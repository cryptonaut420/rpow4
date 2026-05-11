import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { TREASURY_PUBKEY, trailingZeroBits, verifyCanonical, type PoolRoundsResponse } from '@rpow/shared';
import { withTxRetry } from '../db.js';
import { signTokenPayload } from '../signing.js';
import {
  currentRewardForBlock,
  difficultyForBlock,
  BASE_UNITS_PER_RPOW,
} from '../schedule.js';
import {
  macPoolChallenge,
  type PoolChallengeEnvelope,
} from '../pool-challenge.js';
import { macsEqual } from '../mint-challenge.js';
import { mirrorLedgerEventHot, type LedgerEventRow } from '../ledger-hot.js';

const ShareBody = z.object({
  challenge_id: z.string().uuid(),
  nonce_prefix: z.string().regex(/^[0-9a-f]{32}$/),
  network_difficulty_bits: z.number().int().min(4).max(64),
  share_difficulty_bits: z.number().int().min(4).max(64),
  issued_at: z.string(),
  expires_at: z.string(),
  challenge_mac: z.string().regex(/^[0-9a-f]{64}$/),
  solution_nonce: z.string().regex(/^\d{1,20}$/),
  client_signature_base58: z.string().min(64).max(96),
});

interface OpenRoundRow {
  id: string;
  started_at: Date;
}

async function readOpenRound(c: PoolClient): Promise<OpenRoundRow | null> {
  const r = await c.query<OpenRoundRow>(
    `SELECT id::text AS id, started_at FROM pool_rounds WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

export async function poolRoutes(app: FastifyInstance) {
  // ---- POST /pool/challenge -------------------------------------------------
  // Auth: session cookie. Issues an envelope MAC'd over (challenge_id,
  // user_pubkey, nonce_prefix, network_bits, share_bits, issued_at,
  // expires_at, domain). Same caller can hold many concurrent challenges
  // (worker rotates them), but each challenge_id is single-use for any
  // given (challenge_id, nonce) pair.
  app.post('/pool/challenge', async (req, reply) => {
    if (!app.config.poolEnabled) {
      return reply.code(503).send({ error: 'POOL_DISABLED', message: 'pool mining is disabled' });
    }
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const { rows } = await app.pool.query<{ name: string; value: string }>(
      `SELECT name, value::text AS value FROM app_counters WHERE name IN ('minted_supply','block_height')`,
    );
    let mintedBaseUnits = 0n;
    let blockHeight = 0n;
    for (const r of rows) {
      if (r.name === 'minted_supply') mintedBaseUnits = BigInt(r.value);
      else if (r.name === 'block_height') blockHeight = BigInt(r.value);
    }
    const capBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;
    if (mintedBaseUnits >= capBaseUnits) {
      return reply.code(410).send({ error: 'SUPPLY_EXHAUSTED', message: '21M cap reached' });
    }

    const networkBits = difficultyForBlock(blockHeight, {
      difficultyStartBits: app.config.difficultyStartBits,
      difficultyStepBlocks: app.config.difficultyStepBlocks,
      difficultyMaxBits: app.config.difficultyMaxBits,
    });
    // Share target is fixed — see POOL_SHARE_BITS in env.ts. We deliberately
    // do NOT track networkBits so share rates stay stable as the network
    // schedule climbs.
    const shareBits = app.config.poolShareBits;

    const id = randomUUID();
    const noncePrefix = randomBytes(16).toString('hex');
    const now = Date.now();
    const envelope: PoolChallengeEnvelope = {
      challenge_id: id,
      user_pubkey: s.pubkey,
      nonce_prefix: noncePrefix,
      network_difficulty_bits: networkBits,
      share_difficulty_bits: shareBits,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + app.config.poolChallengeTtlSeconds * 1000).toISOString(),
      domain: 'rpow4.pool',
    };
    return {
      challenge_id: envelope.challenge_id,
      user_pubkey: envelope.user_pubkey,
      nonce_prefix: envelope.nonce_prefix,
      network_difficulty_bits: envelope.network_difficulty_bits,
      share_difficulty_bits: envelope.share_difficulty_bits,
      issued_at: envelope.issued_at,
      expires_at: envelope.expires_at,
      challenge_mac: macPoolChallenge(envelope, app.config.sessionSecret),
    };
  });

  // ---- POST /pool/share -----------------------------------------------------
  // Submit a single share. Validates MAC + signature + recomputed hash +
  // share difficulty. If the same hash also clears network difficulty,
  // closes the current round and fans out per-miner payouts inside the
  // same transaction.
  app.post('/pool/share', async (req, reply) => {
    if (!app.config.poolEnabled) {
      return reply.code(503).send({ error: 'POOL_DISABLED', message: 'pool mining is disabled' });
    }
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const parsed = ShareBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }

    // Per-share signature: client signs (challenge_id, solution_nonce).
    // Cheap (Ed25519 verify is microseconds) and provides authentic
    // attribution even if the session cookie is leaky.
    const sigOk = verifyCanonical(
      'pool.share',
      { challenge_id: parsed.data.challenge_id, solution_nonce: parsed.data.solution_nonce },
      parsed.data.client_signature_base58,
      s.pubkey,
    );
    if (!sigOk) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: 'share signature does not verify' });
    }

    const envelope: PoolChallengeEnvelope = {
      challenge_id: parsed.data.challenge_id,
      user_pubkey: s.pubkey,
      nonce_prefix: parsed.data.nonce_prefix,
      network_difficulty_bits: parsed.data.network_difficulty_bits,
      share_difficulty_bits: parsed.data.share_difficulty_bits,
      issued_at: parsed.data.issued_at,
      expires_at: parsed.data.expires_at,
      domain: 'rpow4.pool',
    };
    const expectedMac = macPoolChallenge(envelope, app.config.sessionSecret);
    if (!macsEqual(expectedMac, parsed.data.challenge_mac)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'challenge mac mismatch' });
    }

    const expiresAtMs = Date.parse(parsed.data.expires_at);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) {
      return reply.code(410).send({ error: 'CHALLENGE_EXPIRED', message: 'challenge expired' });
    }

    const nonce = BigInt(parsed.data.solution_nonce);
    const noncePrefixBuf = Buffer.from(parsed.data.nonce_prefix, 'hex');
    const zeros = recomputeHashTrailingZeros(noncePrefixBuf, nonce);
    if (zeros < parsed.data.share_difficulty_bits) {
      return reply.code(400).send({ error: 'INVALID_SHARE', message: 'hash does not meet share difficulty' });
    }
    const isBlock = zeros >= parsed.data.network_difficulty_bits;

    const result = await withTxRetry(
      app.pool,
      async (c) => {
        const round = await readOpenRound(c);
        if (!round) {
          // Should never happen: migration seeds an open round and every
          // round-close opens a fresh one in the same TX. If we hit this
          // it's a system invariant violation; surface as 500.
          throw new Error('no open pool round');
        }
        // Capture as a non-null local so TS narrowing reaches into
        // closures (the payout helper below).
        const roundId: string = round.id;

        // Insert the share. Unique index on (challenge_id, nonce_text)
        // catches replays.
        try {
          await c.query(
            `INSERT INTO pool_shares(round_id, pubkey, challenge_id, nonce_text, zeros)
             VALUES($1::bigint, $2, $3, $4, $5)`,
            [roundId, s.pubkey, parsed.data.challenge_id, parsed.data.solution_nonce, zeros],
          );
        } catch (e) {
          if ((e as { code?: string }).code === '23505') {
            return { error: 'DUPLICATE_SHARE' as const, message: 'share already submitted' };
          }
          throw e;
        }

        await c.query(
          `UPDATE pool_rounds SET total_shares = total_shares + 1 WHERE id = $1::bigint`,
          [roundId],
        );

        if (!isBlock) {
          return {
            ok: true as const,
            share_id: 'pending',
            zeros,
            round_id: roundId,
            block_won: false as const,
            participant_pubkeys: [] as string[],
          };
        }

        // Block win path: serialize all closeouts on a single advisory
        // lock so two simultaneous winning shares can't both close the
        // same round.
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_pool_round_close'))`);
        const stillOpen = await c.query<{ id: string }>(
          `SELECT id::text AS id FROM pool_rounds WHERE id = $1::bigint AND ended_at IS NULL FOR UPDATE`,
          [roundId],
        );
        if (stillOpen.rows.length === 0) {
          // Another share closed this round between insert and lock. Our
          // share is already counted; treat as a regular accepted share.
          return {
            ok: true as const,
            share_id: 'pending',
            zeros,
            round_id: roundId,
            block_won: false as const,
            participant_pubkeys: [] as string[],
          };
        }

        // Read counters for the mint, identical guards to /mint.
        const counterRows = (await c.query<{ name: string; value: string }>(
          `SELECT name, value::text AS value FROM app_counters WHERE name IN ('minted_supply','block_height')`,
        )).rows;
        let mintedBaseUnits = 0n;
        let blockHeight = 0n;
        for (const r of counterRows) {
          if (r.name === 'minted_supply') mintedBaseUnits = BigInt(r.value);
          else if (r.name === 'block_height') blockHeight = BigInt(r.value);
        }

        const scheduleOpts = {
          baseRewardBaseUnits: app.config.baseRewardBaseUnits,
          halvingIntervalBlocks: app.config.halvingIntervalBlocks,
          difficultyStartBits: app.config.difficultyStartBits,
          difficultyStepBlocks: app.config.difficultyStepBlocks,
          difficultyMaxBits: app.config.difficultyMaxBits,
          maxSupplyRpow: app.config.mintMaxSupply,
        };
        const reward = currentRewardForBlock(blockHeight, scheduleOpts);
        if (reward === 0n) {
          return { error: 'SUPPLY_EXHAUSTED' as const, message: 'reward floored to zero — schedule terminated' };
        }
        const expectedDifficulty = difficultyForBlock(blockHeight, scheduleOpts);
        if (parsed.data.network_difficulty_bits !== expectedDifficulty) {
          return {
            error: 'CHALLENGE_EXPIRED' as const,
            message: 'difficulty changed between challenge and share; request a new challenge',
          };
        }

        const capBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;
        const supplyResult = await c.query(
          `UPDATE app_counters
             SET value = value + (CASE
               WHEN name = 'minted_supply' THEN $1::bigint
               ELSE 1::bigint
             END)
           WHERE name IN ('minted_supply','block_height')
             AND (SELECT value FROM app_counters WHERE name='minted_supply') + $1::bigint <= $2::bigint`,
          [reward.toString(), capBaseUnits.toString()],
        );
        if (supplyResult.rowCount !== 2) {
          return { error: 'SUPPLY_EXHAUSTED' as const, message: '21M cap reached' };
        }

        // ---- Distribution math ------------------------------------------
        // Treasury fee off the gross.
        const grossReward = reward;
        const treasuryCut = (grossReward * BigInt(app.config.poolFeeBps)) / 10000n;
        const netReward = grossReward - treasuryCut;
        // The finder bonus is a flat slice of the net; the rest is the
        // pro-rata pool. Every miner — INCLUDING the finder — earns from
        // the pro-rata pool in proportion to their share count. The
        // finder additionally receives the bonus on top. This avoids the
        // earlier perverse incentive where a heavy contributor earned
        // *more* when someone else found a block (because excluding the
        // finder from pro-rata gave them a larger slice when they were
        // not the winner).
        const finderBonus = (netReward * BigInt(app.config.poolFinderBps)) / 10000n;
        const proRataPool = netReward - finderBonus;

        // Aggregate shares by pubkey for this round.
        const shareRows = (await c.query<{ pubkey: string; share_count: string }>(
          `SELECT pubkey, count(*)::text AS share_count
             FROM pool_shares
            WHERE round_id = $1::bigint
            GROUP BY pubkey`,
          [roundId],
        )).rows;

        let totalShares = 0n;
        const participantRows: { pubkey: string; shareCount: bigint }[] = [];
        let finderShareCount = 0n;
        for (const r of shareRows) {
          const sc = BigInt(r.share_count);
          participantRows.push({ pubkey: r.pubkey, shareCount: sc });
          totalShares += sc;
          if (r.pubkey === s.pubkey) finderShareCount = sc;
        }

        // Pro-rata share for each participant — including the finder.
        // Integer division means a small residue may remain; that "dust"
        // rolls into the treasury cut so we never mint more than the
        // gross reward.
        let proRataDistributed = 0n;
        // `payout` is the FULL credit each participant receives this
        // round (finder includes their bonus). `proRataShare` is the
        // pro-rata portion only — used to track distribution + dust.
        type PayoutRow = {
          pubkey: string;
          shareCount: bigint;
          payout: bigint;
          isFinder: boolean;
        };
        const payouts: PayoutRow[] = [];
        if (totalShares > 0n) {
          for (const r of participantRows) {
            const proRataShare = (proRataPool * r.shareCount) / totalShares;
            proRataDistributed += proRataShare;
            const isFinder = r.pubkey === s.pubkey;
            payouts.push({
              pubkey: r.pubkey,
              shareCount: r.shareCount,
              payout: isFinder ? proRataShare + finderBonus : proRataShare,
              isFinder,
            });
          }
        } else {
          // No shares at all — shouldn't happen because the winning share
          // is itself counted. Defensive fallback: finder still gets the
          // bonus, everything else stays in the treasury.
          payouts.push({
            pubkey: s.pubkey,
            shareCount: finderShareCount,
            payout: finderBonus,
            isFinder: true,
          });
        }

        // Residue (rounding dust) goes back to the treasury.
        const dust = proRataPool - proRataDistributed;
        const finalTreasuryCut = treasuryCut + dust;
        // What the finder actually takes home (bonus + their own pro-rata).
        const finderPayoutTotal = payouts.find((p) => p.isFinder)?.payout ?? finderBonus;

        // ---- Issuance accounting (single increment for the whole block) -
        // The full gross reward enters circulation here, regardless of
        // how the per-recipient MINT events split it below.
        await c.query(
          `UPDATE ledger_stats SET value = value + $1::bigint, updated_at = now() WHERE name='circulating_supply'`,
          [grossReward.toString()],
        );

        const issuedAt = new Date();

        // ---- Helper: emit a MINT event for a pool participant ----------
        // Each pool payout is recorded as its own MINT event with
        // actor_pubkey = recipient (no counterparty). This is what makes
        // pool payouts show up as "mined" in account / explorer feeds
        // instead of being indirect TRANSFERs from the treasury. The
        // finder additionally gets blocks_mined += 1 so the "blocks
        // mined" leaderboard reflects who actually found this block.
        async function mintPoolPayout(
          recipient: string,
          amount: bigint,
          memo: string,
          isFinder: boolean,
          shareCount: bigint,
        ): Promise<string | null> {
          if (amount === 0n) return null;
          const eventId = randomUUID();
          await c.query(`INSERT INTO ledger_event_ids(id) VALUES($1)`, [eventId]);
          const serverSig = signTokenPayload(
            { id: eventId, owner_pubkey: recipient, value: amount, issued_at: issuedAt.toISOString() },
            app.config.signingPrivateKeyHex,
          );

          // Bump recipient's balance. Finder also gets blocks_mined++.
          // We pass blocks_mined as a parameter so the same statement
          // works for both the insert and update paths (the COALESCE
          // pattern would be uglier).
          await c.query(
            `INSERT INTO account_balances(
               pubkey, spendable_base_units, minted_base_units,
               blocks_mined, events_count, updated_at
             )
             VALUES($1, $2, $2, $3, 1, now())
             ON CONFLICT (pubkey) DO UPDATE SET
               spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
               minted_base_units    = account_balances.minted_base_units    + EXCLUDED.minted_base_units,
               blocks_mined         = account_balances.blocks_mined         + $3::int,
               events_count         = account_balances.events_count         + 1,
               updated_at = now()`,
            [recipient, amount.toString(), isFinder ? 1 : 0],
          );

          const inserted = await c.query<LedgerEventRow>(
            `WITH inserted AS (
               INSERT INTO ledger_events(
                 id, event_type, actor_pubkey, amount, memo, server_sig, created_at
               )
               VALUES($1,'MINT',$2,$3,$4,$5,$6)
               RETURNING event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                         amount, fee_base_units, memo,
                         challenge_id, solution_nonce, idempotency_key,
                         client_signature_base58, server_sig, created_at
             ),
             upd_event_id AS (
               UPDATE ledger_event_ids ids
               SET event_seq = i.event_seq
               FROM inserted i
               WHERE ids.id = i.id
             )
             SELECT event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                    amount::text AS amount, fee_base_units::text AS fee_base_units, memo,
                    challenge_id, solution_nonce, idempotency_key,
                    client_signature_base58, server_sig, created_at
             FROM inserted`,
            [eventId, recipient, amount.toString(), memo, serverSig, issuedAt],
          );
          await mirrorLedgerEventHot(c, inserted.rows[0]!);

          await c.query(
            `INSERT INTO pool_payouts(round_id, pubkey, share_count, payout_base_units, is_finder, event_id)
             VALUES($1::bigint, $2, $3::bigint, $4::bigint, $5, $6)`,
            [roundId, recipient, shareCount.toString(), amount.toString(), isFinder, eventId],
          );
          return eventId;
        }

        // ---- Helper: MINT the treasury fee -----------------------------
        // The treasury receives a MINT too — but we deliberately do NOT
        // increment its minted_base_units or blocks_mined, since the
        // leaderboard would otherwise be dominated by the system
        // account. spendable + events_count bump as usual.
        async function mintTreasuryFee(amount: bigint, memo: string): Promise<string | null> {
          if (amount === 0n) return null;
          const eventId = randomUUID();
          await c.query(`INSERT INTO ledger_event_ids(id) VALUES($1)`, [eventId]);
          const serverSig = signTokenPayload(
            { id: eventId, owner_pubkey: TREASURY_PUBKEY, value: amount, issued_at: issuedAt.toISOString() },
            app.config.signingPrivateKeyHex,
          );
          await c.query(
            `INSERT INTO account_balances(pubkey, spendable_base_units, events_count, updated_at)
             VALUES($1, $2, 1, now())
             ON CONFLICT (pubkey) DO UPDATE SET
               spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
               events_count = account_balances.events_count + 1,
               updated_at = now()`,
            [TREASURY_PUBKEY, amount.toString()],
          );
          const inserted = await c.query<LedgerEventRow>(
            `WITH inserted AS (
               INSERT INTO ledger_events(
                 id, event_type, actor_pubkey, amount, memo, server_sig, created_at
               )
               VALUES($1,'MINT',$2,$3,$4,$5,$6)
               RETURNING event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                         amount, fee_base_units, memo,
                         challenge_id, solution_nonce, idempotency_key,
                         client_signature_base58, server_sig, created_at
             ),
             upd_event_id AS (
               UPDATE ledger_event_ids ids
               SET event_seq = i.event_seq
               FROM inserted i
               WHERE ids.id = i.id
             )
             SELECT event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                    amount::text AS amount, fee_base_units::text AS fee_base_units, memo,
                    challenge_id, solution_nonce, idempotency_key,
                    client_signature_base58, server_sig, created_at
             FROM inserted`,
            [eventId, TREASURY_PUBKEY, amount.toString(), memo, serverSig, issuedAt],
          );
          await mirrorLedgerEventHot(c, inserted.rows[0]!);
          return eventId;
        }

        // ---- Fan out payouts -------------------------------------------
        // Each participant gets a MINT. The finder's memo distinguishes
        // their bigger payout (bonus + pro-rata). The finder's MINT id
        // is what we hand to the explorer as the "block event" link.
        let finderEventId: string | null = null;
        const participantPubkeys: string[] = [];
        for (const p of payouts) {
          const memo = p.isFinder
            ? `pool round #${roundId} (finder bonus + pro-rata)`
            : `pool round #${roundId}`;
          const eventId = await mintPoolPayout(p.pubkey, p.payout, memo, p.isFinder, p.shareCount);
          if (p.isFinder) finderEventId = eventId;
          if (eventId) participantPubkeys.push(p.pubkey);
        }

        // Treasury fee + dust as its own MINT. Always emit if non-zero
        // so the on-chain accounting balances cleanly against gross.
        if (finalTreasuryCut > 0n) {
          await mintTreasuryFee(finalTreasuryCut, `pool round #${roundId} treasury fee`);
        }

        // ---- Close round + open the next one ---------------------------
        // `finder_payout_base_units` records the finder's TOTAL take for
        // the round (bonus + their own pro-rata share). `ended_by_event_id`
        // points at the finder's own MINT event so the explorer "block
        // tx" link lands on the recipient view the user expects.
        await c.query(
          `UPDATE pool_rounds
             SET ended_at = now(),
                 ended_by_pubkey = $2,
                 ended_by_event_id = $3,
                 reward_base_units = $4::bigint,
                 treasury_cut_base_units = $5::bigint,
                 finder_payout_base_units = $6::bigint,
                 pro_rata_pool_base_units = $7::bigint,
                 participant_count = $8
           WHERE id = $1::bigint`,
          [
            roundId,
            s.pubkey,
            finderEventId,
            grossReward.toString(),
            finalTreasuryCut.toString(),
            finderPayoutTotal.toString(),
            proRataPool.toString(),
            shareRows.length,
          ],
        );
        await c.query(`INSERT INTO pool_rounds (started_at) VALUES (now())`);

        return {
          ok: true as const,
          share_id: 'pending',
          zeros,
          round_id: roundId,
          block_won: true as const,
          ...(finderEventId ? { block_event_id: finderEventId } : {}),
          finder_pubkey: s.pubkey,
          reward_base_units: grossReward.toString(),
          your_payout_base_units: finderPayoutTotal.toString(),
          participant_pubkeys: participantPubkeys,
        };
      },
      { onRetry: (err, attempt) => app.log.warn({ err, attempt, route: 'pool/share' }, 'tx retry') },
    );

    if ('error' in result) {
      const status =
        result.error === 'SUPPLY_EXHAUSTED' ? 410 :
        result.error === 'CHALLENGE_EXPIRED' ? 410 :
        result.error === 'DUPLICATE_SHARE' ? 409 :
        400;
      return reply.code(status).send(result);
    }

    if (result.block_won) {
      app.invalidateLedger();
      app.invalidateAccount(TREASURY_PUBKEY);
      // Each participant's MINT lands on their own account view, so
      // their cache needs to be invalidated explicitly. The list comes
      // back from the tx so we don't need an extra query.
      for (const pubkey of result.participant_pubkeys) app.invalidateAccount(pubkey);
    }
    // `participant_pubkeys` is an internal hint for cache invalidation
    // and isn't part of the wire response.
    const { participant_pubkeys: _participants, ...wire } = result;
    return wire;
  });

  // ---- GET /pool/stats ------------------------------------------------------
  // Snapshot of the active round + recent payouts. Cheap query — keep in
  // a 2s TTL cache so the visualizer can poll it without DB pressure.
  app.get('/pool/stats', async (req, reply) => {
    if (!app.config.poolEnabled) {
      return reply.code(503).send({ error: 'POOL_DISABLED', message: 'pool mining is disabled' });
    }

    const session = app.readSession(req);
    const cacheKey = session?.pubkey ?? 'anon';

    const body = await app.caches.poolStats.get(cacheKey, async () => {
      const open = (await app.pool.query<{ id: string; started_at: Date; total_shares: string }>(
        `SELECT id::text AS id, started_at, total_shares::text AS total_shares
           FROM pool_rounds WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`,
      )).rows[0];
      const totalShares = open ? BigInt(open.total_shares) : 0n;

      const counterRows = (await app.pool.query<{ name: string; value: string }>(
        `SELECT name, value::text AS value FROM app_counters WHERE name = 'block_height'`,
      )).rows;
      const blockHeight = counterRows[0] ? BigInt(counterRows[0].value) : 0n;
      const networkBits = difficultyForBlock(blockHeight, {
        difficultyStartBits: app.config.difficultyStartBits,
        difficultyStepBlocks: app.config.difficultyStepBlocks,
        difficultyMaxBits: app.config.difficultyMaxBits,
      });
      const shareBits = app.config.poolShareBits;

      // Active miners + per-miner share counts in last 60s, used to
      // estimate hashrate. 2^share_bits hashes per share by definition.
      const recent = (await app.pool.query<{ pubkey: string; n: string }>(
        `SELECT pubkey, count(*)::text AS n
           FROM pool_shares
          WHERE submitted_at > now() - interval '60 seconds'
          GROUP BY pubkey`,
      )).rows;
      let totalRecentShares = 0n;
      for (const r of recent) totalRecentShares += BigInt(r.n);
      const poolHashratePerSec = Number(totalRecentShares) * Math.pow(2, shareBits) / 60;

      // Caller's contribution to the open round.
      let yourShares = 0n;
      if (session && open) {
        const r = (await app.pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pool_shares WHERE round_id = $1::bigint AND pubkey = $2`,
          [open.id, session.pubkey],
        )).rows[0];
        yourShares = r ? BigInt(r.n) : 0n;
      }

      // Schedule helpers for the estimated payout preview.
      const reward = currentRewardForBlock(blockHeight, {
        baseRewardBaseUnits: app.config.baseRewardBaseUnits,
        halvingIntervalBlocks: app.config.halvingIntervalBlocks,
        difficultyStartBits: app.config.difficultyStartBits,
        difficultyStepBlocks: app.config.difficultyStepBlocks,
        difficultyMaxBits: app.config.difficultyMaxBits,
        maxSupplyRpow: app.config.mintMaxSupply,
      });
      const treasuryCut = (reward * BigInt(app.config.poolFeeBps)) / 10000n;
      const netReward = reward - treasuryCut;
      const finderBonus = (netReward * BigInt(app.config.poolFinderBps)) / 10000n;
      const proRataPool = netReward - finderBonus;

      // Under the new fairness rules, EVERY participant earns a pro-rata
      // share (finder included). The finder additionally gets the bonus.
      // So both previews are anchored on the same pro-rata calculation.
      const proRataIfWon = totalShares > 0n
        ? (proRataPool * yourShares) / totalShares
        : 0n;
      const estIfFinder = finderBonus + proRataIfWon;
      const estIfNotFinder = proRataIfWon;

      // Recent closed rounds for the activity strip in the UI.
      const recentClosedRows = (await app.pool.query<{
        id: string;
        ended_at: Date;
        ended_by_pubkey: string;
        reward_base_units: string;
        participant_count: number | null;
        finder_payout_base_units: string;
        ended_by_display_name: string | null;
      }>(
        `SELECT pr.id::text AS id,
                pr.ended_at,
                pr.ended_by_pubkey,
                pr.reward_base_units::text AS reward_base_units,
                pr.participant_count,
                pr.finder_payout_base_units::text AS finder_payout_base_units,
                a.display_name AS ended_by_display_name
           FROM pool_rounds pr
      LEFT JOIN accounts a ON a.pubkey = pr.ended_by_pubkey
          WHERE pr.ended_at IS NOT NULL
       ORDER BY pr.ended_at DESC
          LIMIT 10`,
      )).rows;

      // Caller's payout history within the recent closed rounds.
      const recentRoundIds = recentClosedRows.map((r) => r.id);
      const yourPayouts: Record<string, string> = {};
      if (session && recentRoundIds.length > 0) {
        const r = await app.pool.query<{ round_id: string; payout_base_units: string }>(
          `SELECT round_id::text AS round_id, payout_base_units::text AS payout_base_units
             FROM pool_payouts
            WHERE round_id = ANY($1::bigint[]) AND pubkey = $2`,
          [recentRoundIds, session.pubkey],
        );
        for (const row of r.rows) yourPayouts[row.round_id] = row.payout_base_units;
      }

      return {
        enabled: true,
        share_difficulty_bits: shareBits,
        network_difficulty_bits: networkBits,
        current_round: open
          ? {
              id: open.id,
              started_at: open.started_at.toISOString(),
              total_shares: totalShares.toString(),
              your_shares: yourShares.toString(),
              estimated_finder_payout_base_units: estIfFinder.toString(),
              estimated_pro_rata_payout_base_units: estIfNotFinder.toString(),
            }
          : null,
        active_miners: recent.length,
        pool_hashrate_hps: Math.round(poolHashratePerSec),
        pool_fee_bps: app.config.poolFeeBps,
        finder_bps: app.config.poolFinderBps,
        gross_reward_base_units: reward.toString(),
        recent_payouts: recentClosedRows.map((r) => ({
          round_id: r.id,
          ended_at: r.ended_at.toISOString(),
          finder_pubkey: r.ended_by_pubkey,
          ...(r.ended_by_display_name ? { finder_display_name: r.ended_by_display_name } : {}),
          reward_base_units: r.reward_base_units,
          finder_payout_base_units: r.finder_payout_base_units,
          participant_count: r.participant_count ?? 0,
          ...(yourPayouts[r.id] ? { your_payout_base_units: yourPayouts[r.id] } : {}),
        })),
      };
    });
    reply.header('cache-control', 'private, max-age=0');
    return body;
  });

  // ---- GET /pool/rounds -----------------------------------------------------
  // Paginated history of CLOSED pool rounds, newest first. Powers the
  // "view all" page so the visualizer / stats panels can keep their
  // recent-payouts list short. The caller's per-round payout (if any) is
  // included on each row.
  //
  // Cursor pagination uses the round id (BIGSERIAL) — simple, dense,
  // monotonic. The `pool_rounds_ended_at_idx` index keeps this cheap
  // even as the table grows.
  const RoundsQuery = z.object({
    cursor: z.string().regex(/^\d+$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  });
  app.get('/pool/rounds', async (req, reply) => {
    if (!app.config.poolEnabled) {
      return reply.code(503).send({ error: 'POOL_DISABLED', message: 'pool mining is disabled' });
    }
    const qp = RoundsQuery.safeParse(req.query);
    if (!qp.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid query params' });
    }
    const { cursor, limit } = qp.data;
    const session = app.readSession(req);

    const params: unknown[] = [];
    let cursorClause = '';
    if (cursor) {
      params.push(cursor);
      cursorClause = `AND pr.id < $${params.length}::bigint`;
    }
    params.push(limit + 1);
    const limitParam = `$${params.length}`;

    const rows = (await app.pool.query<{
      id: string;
      started_at: Date;
      ended_at: Date;
      ended_by_pubkey: string;
      ended_by_event_id: string | null;
      reward_base_units: string;
      treasury_cut_base_units: string;
      finder_payout_base_units: string;
      pro_rata_pool_base_units: string;
      participant_count: number | null;
      total_shares: string;
      ended_by_display_name: string | null;
    }>(
      `SELECT pr.id::text AS id,
              pr.started_at,
              pr.ended_at,
              pr.ended_by_pubkey,
              pr.ended_by_event_id::text AS ended_by_event_id,
              pr.reward_base_units::text AS reward_base_units,
              pr.treasury_cut_base_units::text AS treasury_cut_base_units,
              pr.finder_payout_base_units::text AS finder_payout_base_units,
              pr.pro_rata_pool_base_units::text AS pro_rata_pool_base_units,
              pr.participant_count,
              pr.total_shares::text AS total_shares,
              a.display_name AS ended_by_display_name
         FROM pool_rounds pr
    LEFT JOIN accounts a ON a.pubkey = pr.ended_by_pubkey
        WHERE pr.ended_at IS NOT NULL
          ${cursorClause}
     ORDER BY pr.id DESC
        LIMIT ${limitParam}`,
      params,
    )).rows;

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);

    // Per-round caller payout in a single roundtrip (so each request is
    // exactly 2 queries regardless of page size).
    const yourPayouts: Record<string, string> = {};
    if (session && pageRows.length > 0) {
      const ids = pageRows.map((r) => r.id);
      const r = await app.pool.query<{ round_id: string; payout_base_units: string }>(
        `SELECT round_id::text AS round_id, payout_base_units::text AS payout_base_units
           FROM pool_payouts
          WHERE round_id = ANY($1::bigint[]) AND pubkey = $2`,
        [ids, session.pubkey],
      );
      for (const row of r.rows) yourPayouts[row.round_id] = row.payout_base_units;
    }

    const body: PoolRoundsResponse = {
      rounds: pageRows.map((r) => ({
        round_id: r.id,
        started_at: r.started_at.toISOString(),
        ended_at: r.ended_at.toISOString(),
        finder_pubkey: r.ended_by_pubkey,
        ...(r.ended_by_display_name ? { finder_display_name: r.ended_by_display_name } : {}),
        ...(r.ended_by_event_id ? { block_event_id: r.ended_by_event_id } : {}),
        reward_base_units: r.reward_base_units,
        treasury_cut_base_units: r.treasury_cut_base_units,
        finder_payout_base_units: r.finder_payout_base_units,
        pro_rata_pool_base_units: r.pro_rata_pool_base_units,
        participant_count: r.participant_count ?? 0,
        total_shares: r.total_shares,
        ...(yourPayouts[r.id] ? { your_payout_base_units: yourPayouts[r.id] } : {}),
      })),
      ...(hasMore && pageRows.length > 0
        ? { next_cursor: pageRows[pageRows.length - 1]!.id }
        : {}),
    };

    reply.header('cache-control', 'public, max-age=3, stale-while-revalidate=15');
    return body;
  });
}

function recomputeHashTrailingZeros(noncePrefix: Buffer, nonce: bigint): number {
  // Re-derive the hash and count trailing zero bits. Used in /pool/share
  // since we accept hashes below network difficulty (those would fail
  // the existing /pow.ts verifier which only returns a boolean).
  const nonceBuf = Buffer.alloc(8);
  let x = nonce;
  for (let i = 0; i < 8; i++) { nonceBuf[i] = Number(x & 0xffn); x >>= 8n; }
  const h = createHash('sha256').update(noncePrefix).update(nonceBuf).digest();
  return trailingZeroBits(h);
}
