import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { TREASURY_PUBKEY } from '@rpow/shared';
import { withTxRetry } from '../db.js';
import { mirrorLedgerEventHot, type LedgerEventRow } from '../ledger-hot.js';
import { DEFAULT_ASSET_ID } from '../assets.js';

interface CooldownRow {
  last_claimed_at: Date;
  last_amount: string;
}

/**
 * Fetch the most recent claim for either the pubkey or the IP. Returns
 * the *more recent* of the two so a single value summarizes the active
 * cooldown for the calling caller-pair.
 */
async function findActiveCooldown(
  pool: FastifyInstance['pool'],
  pubkey: string,
  ip: string,
  cooldownHours: number,
): Promise<{ at: Date; amountBaseUnits: string; reason: 'pubkey' | 'ip' } | null> {
  // UNION the two indexed lookups. Each side stops at LIMIT 1 thanks to
  // the (pubkey, claimed_at DESC) and (ip, claimed_at DESC) indexes.
  const result = await pool.query<{ claimed_at: Date; amount_base_units: string; reason: string }>(
    `(SELECT claimed_at, amount_base_units::text, 'pubkey'::text AS reason
        FROM faucet_claims
       WHERE pubkey = $1
         AND claimed_at > now() - ($3 || ' hours')::interval
       ORDER BY claimed_at DESC
       LIMIT 1)
     UNION ALL
     (SELECT claimed_at, amount_base_units::text, 'ip'::text AS reason
        FROM faucet_claims
       WHERE ip = $2
         AND claimed_at > now() - ($3 || ' hours')::interval
       ORDER BY claimed_at DESC
       LIMIT 1)
     ORDER BY claimed_at DESC
     LIMIT 1`,
    [pubkey, ip, String(cooldownHours)],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0]!;
  return {
    at: row.claimed_at,
    amountBaseUnits: row.amount_base_units,
    reason: row.reason === 'ip' ? 'ip' : 'pubkey',
  };
}

function computeNextClaimAt(lastClaimedAt: Date, cooldownHours: number): Date {
  return new Date(lastClaimedAt.getTime() + cooldownHours * 60 * 60 * 1000);
}

/**
 * Resolve a stable client IP. Fastify already honors X-Forwarded-For when
 * trustProxy is set; this small wrapper just picks the first hop and
 * normalizes IPv6-mapped IPv4 (::ffff:1.2.3.4 → 1.2.3.4) so the cooldown
 * dedup is consistent across container/proxy boundaries.
 */
function clientIp(req: FastifyRequest): string {
  let ip = req.ip ?? '';
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  return ip;
}

export async function faucetRoutes(app: FastifyInstance) {
  // ---- GET /faucet ----------------------------------------------------------
  // Public. Returns global config (claim amount, cooldown, treasury balance)
  // plus, when the caller is signed in, their personal eligibility.
  app.get('/faucet', async (req, reply) => {
    const session = app.readSession(req);
    const ip = clientIp(req);
    const cacheKey = `${session?.pubkey ?? 'anon'}|${ip}`;

    const body = await app.caches.faucetStatus.get(cacheKey, async () => {
      const treasuryRow = await app.pool.query<{ balance: string }>(
        `SELECT spendable_base_units::text AS balance
           FROM account_balances
          WHERE asset_id=$1::uuid AND pubkey = $2`,
        [DEFAULT_ASSET_ID, TREASURY_PUBKEY],
      );
      const treasuryBalance = treasuryRow.rows[0]?.balance ?? '0';
      const treasuryBalanceBigInt = BigInt(treasuryBalance);
      const claimAmount = app.config.faucetClaimAmountBaseUnits;
      const enabled = app.config.faucetEnabled;
      const cooldownHours = app.config.faucetCooldownHours;
      const cooldownSeconds = cooldownHours * 3600;

      let cooldown: { at: Date; amountBaseUnits: string; reason: 'pubkey' | 'ip' } | null = null;
      if (session) {
        cooldown = await findActiveCooldown(app.pool, session.pubkey, ip, cooldownHours);
      } else if (ip) {
        // Even unauthenticated callers should see "this IP claimed recently"
        // so the UI doesn't promise a claim that won't go through.
        cooldown = await findActiveCooldown(app.pool, '__never__', ip, cooldownHours);
      }

      const treasuryHasFunds = treasuryBalanceBigInt >= claimAmount;
      const eligible = enabled && treasuryHasFunds && cooldown === null && session !== null;

      const reason = !enabled
        ? 'disabled'
        : !treasuryHasFunds
        ? 'treasury_dry'
        : cooldown !== null
        ? cooldown.reason === 'ip' ? 'cooldown_ip' : 'cooldown_pubkey'
        : session === null
        ? 'login_required'
        : null;

      return {
        enabled,
        eligible,
        claim_amount_base_units: claimAmount.toString(),
        cooldown_hours: cooldownHours,
        cooldown_seconds: cooldownSeconds,
        treasury_balance_base_units: treasuryBalance,
        treasury_pubkey: TREASURY_PUBKEY,
        ...(cooldown
          ? {
              last_claim_at: cooldown.at.toISOString(),
              next_claim_at: computeNextClaimAt(cooldown.at, cooldownHours).toISOString(),
              last_claim_amount_base_units: cooldown.amountBaseUnits,
            }
          : {}),
        ...(reason ? { ineligible_reason: reason } : {}),
      };
    });

    reply.header('cache-control', 'private, max-age=0');
    return body;
  });

  // ---- POST /faucet/claim ---------------------------------------------------
  // Auth required. Atomically debits the treasury, credits the caller, and
  // records the claim row + a TRANSFER ledger event.
  app.post('/faucet/claim', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    }

    if (!app.config.faucetEnabled) {
      return reply.code(403).send({ error: 'BAD_REQUEST', message: 'faucet is disabled' });
    }

    const claimAmount = app.config.faucetClaimAmountBaseUnits;
    const cooldownHours = app.config.faucetCooldownHours;
    const ip = clientIp(req);
    const recipient = s.pubkey;

    if (recipient === TREASURY_PUBKEY) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'treasury cannot claim from itself' });
    }

    type ClaimResult =
      | {
          ok: true;
          amount_base_units: string;
          transfer_id: string;
          claim_id: string;
          claimed_at: string;
          next_claim_at: string;
        }
      | {
          error: 'TREASURY_DRY' | 'COOLDOWN_ACTIVE';
          message: string;
          status: number;
          extra?: Record<string, unknown>;
        };

    let out!: ClaimResult;
    try {
      out = await withTxRetry<ClaimResult>(
        app.pool,
        async (c) => {
          // Lock cooldown window first — a concurrent claim from the same
          // pubkey or IP must serialize behind us. Use deterministic order
          // so two parallel claimers can't deadlock on each other's locks.
          const lockKeys = ['rpow_faucet_pubkey:' + recipient, 'rpow_faucet_ip:' + ip].sort();
          for (const k of lockKeys) {
            await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [k]);
          }

          // Re-check the cooldown inside the lock. If a parallel claim
          // already wrote a row, we'll see it here and bail.
          const cooldownProbe = await c.query<{ claimed_at: Date; reason: string }>(
            `(SELECT claimed_at, 'pubkey'::text AS reason
                FROM faucet_claims
               WHERE pubkey = $1 AND claimed_at > now() - ($3 || ' hours')::interval
               ORDER BY claimed_at DESC LIMIT 1)
             UNION ALL
             (SELECT claimed_at, 'ip'::text AS reason
                FROM faucet_claims
               WHERE ip = $2 AND claimed_at > now() - ($3 || ' hours')::interval
               ORDER BY claimed_at DESC LIMIT 1)
             ORDER BY claimed_at DESC LIMIT 1`,
            [recipient, ip, String(cooldownHours)],
          );
          if (cooldownProbe.rows.length > 0) {
            const row = cooldownProbe.rows[0]!;
            const next = computeNextClaimAt(row.claimed_at, cooldownHours);
            return {
              error: 'COOLDOWN_ACTIVE',
              message: `next claim available at ${next.toISOString()}`,
              status: 429,
              extra: {
                last_claim_at: row.claimed_at.toISOString(),
                next_claim_at: next.toISOString(),
                cooldown_reason: row.reason,
              },
            };
          }

          // Lock both balance rows to serialize against concurrent sends/mints.
          for (const pubkey of [TREASURY_PUBKEY, recipient].sort()) {
            await c.query(
              `SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance:' || $1), hashtext($2))`,
              [DEFAULT_ASSET_ID, pubkey],
            );
          }

          // Debit treasury. rowCount === 0 means a dry treasury (the
          // spendable_base_units >= claim CHECK gates the UPDATE).
          const debit = await c.query(
            `UPDATE account_balances
                SET spendable_base_units = spendable_base_units - $3::numeric,
                    sent_base_units = sent_base_units + $3::numeric,
                    updated_at = now()
              WHERE asset_id=$1::uuid AND pubkey = $2 AND spendable_base_units >= $3::numeric`,
            [DEFAULT_ASSET_ID, TREASURY_PUBKEY, claimAmount.toString()],
          );
          if (debit.rowCount === 0) {
            return {
              error: 'TREASURY_DRY',
              message: 'treasury does not have enough tokens to grant a faucet claim',
              status: 503,
            };
          }

          // Lazy-create the recipient accounts row (matches /send semantics).
          await c.query(
            `INSERT INTO accounts(pubkey) VALUES($1)
              ON CONFLICT (pubkey) DO NOTHING`,
            [recipient],
          );

          // Credit the recipient + bump events_count for /activity total_count.
          // RETURNING (xmax = 0) tells us whether this was a new balance row;
          // if so, bump per-asset user_count to keep reconciliation honest.
          const credit = await c.query<{ was_inserted: boolean }>(
            `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units, received_base_units, events_count, updated_at)
                  VALUES($1::uuid, $2, $3, $3, 1, now())
              ON CONFLICT (asset_id, pubkey) DO UPDATE SET
                spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
                received_base_units = account_balances.received_base_units + EXCLUDED.received_base_units,
                events_count = account_balances.events_count + 1,
                updated_at = now()
              RETURNING (xmax = 0) AS was_inserted`,
            [DEFAULT_ASSET_ID, recipient, claimAmount.toString()],
          );
          if (credit.rows[0]?.was_inserted) {
            await c.query(
              `UPDATE ledger_stats SET value = value + 1, updated_at = now()
                WHERE asset_id=$1::uuid AND name='user_count'`,
              [DEFAULT_ASSET_ID],
            );
          }

          // Stat shard for total_transferred. The shard key is the recipient
          // pubkey here so faucet drips spread across shards rather than
          // dogpiling on one.
          await c.query(
            `UPDATE ledger_stat_shards
                SET value = value + $1::numeric, updated_at = now()
              WHERE name='total_transferred'
                AND asset_id=$3::uuid
                AND shard = (mod(hashtext($2)::bigint + 2147483648, 64))::smallint`,
            [claimAmount.toString(), recipient, DEFAULT_ASSET_ID],
          );

          const transferId = randomUUID();
          const claimId = randomUUID();
          const createdAt = new Date();
          const memo = 'faucet claim';

          await c.query(
            `INSERT INTO ledger_event_ids(id, asset_id) VALUES($1, $2::uuid)`,
            [transferId, DEFAULT_ASSET_ID],
          );

          // Insert the TRANSFER event + propagate event_seq + bump
          // transfer_count, all in a single CTE so the partition write
          // happens once.
          const inserted = await c.query<LedgerEventRow>(
            `WITH inserted AS (
               INSERT INTO ledger_events(
                 asset_id, id, event_type, actor_pubkey, counterparty_pubkey, amount,
                 fee_base_units, memo, idempotency_key, client_signature_base58, created_at
               )
               VALUES($1::uuid,$2,'TRANSFER',$3,$4,$5,0,$6,NULL,NULL,$7)
               RETURNING asset_id::text, event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                         amount, fee_base_units, memo, challenge_id, solution_nonce,
                         idempotency_key, client_signature_base58, server_sig, created_at
             ),
             upd_event_id AS (
               UPDATE ledger_event_ids ids
                 SET event_seq = i.event_seq
                FROM inserted i
               WHERE ids.id = i.id
             ),
             upd_transfer_count AS (
               UPDATE app_counters SET value = value + 1
                WHERE asset_id=$1::uuid AND name='transfer_count'
             )
             SELECT asset_id, event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                    amount::text AS amount, fee_base_units::text AS fee_base_units, memo,
                    challenge_id, solution_nonce, idempotency_key,
                    client_signature_base58, server_sig, created_at
               FROM inserted`,
            [DEFAULT_ASSET_ID, transferId, TREASURY_PUBKEY, recipient, claimAmount.toString(), memo, createdAt],
          );
          const event = inserted.rows[0]!;
          await mirrorLedgerEventHot(c, event);

          // Record the faucet claim. Cooldown lookups use the indexed
          // (pubkey, claimed_at DESC) and (ip, claimed_at DESC) so this
          // insert is the only persistent state we need for cooldowns.
          await c.query(
            `INSERT INTO faucet_claims(asset_id, id, pubkey, ip, amount_base_units, transfer_event_id, claimed_at)
                  VALUES($1::uuid, $2, $3, $4, $5, $6, $7)`,
            [DEFAULT_ASSET_ID, claimId, recipient, ip, claimAmount.toString(), transferId, createdAt],
          );

          return {
            ok: true as const,
            amount_base_units: claimAmount.toString(),
            transfer_id: transferId,
            claim_id: claimId,
            claimed_at: createdAt.toISOString(),
            next_claim_at: computeNextClaimAt(createdAt, cooldownHours).toISOString(),
          };
        },
        { onRetry: (err, attempt) => app.log.warn({ err, attempt, route: 'faucet' }, 'tx retry') },
      );
    } catch (e) {
      app.log.error({ err: e, route: 'faucet' }, 'faucet claim failed');
      return reply.code(500).send({ error: 'INTERNAL', message: 'faucet claim failed' });
    }

    if ('error' in out) {
      return reply.code(out.status).send({
        error: out.error,
        message: out.message,
        ...(out.extra ?? {}),
      });
    }

    // Treasury balance shifts → invalidate ledger + per-account caches.
    app.invalidateAccount(recipient);
    app.invalidateLedger();
    return out;
  });
}
