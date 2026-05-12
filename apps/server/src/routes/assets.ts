import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TREASURY_PUBKEY } from '@rpow/shared';
import { withTxRetry } from '../db.js';
import { mirrorLedgerEventHot, type LedgerEventRow } from '../ledger-hot.js';
import {
  assetFromRow,
  assetToScheduleOpts,
  assetWire,
  DEFAULT_ASSET_ID,
  invalidateAssetCache,
  LAUNCH_BURN_BASE_UNITS,
  loadAssetBySlug,
  type AssetRow,
} from '../assets.js';
import { BASE_UNITS_PER_RPOW, scheduleInfoForBlock } from '../schedule.js';

const Body = z.object({
  nickname: z.string().trim().min(3).max(40),
  description: z.string().trim().max(280).default(''),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/).optional(),
  supply_mode: z.enum(['capped', 'unlimited']).default('capped'),
  max_supply_base_units: z.string().regex(/^[1-9][0-9]{0,18}$/).optional(),
  initial_reward_base_units: z.string().regex(/^[1-9][0-9]{0,18}$/).default('50000000000'),
  reward_schedule_type: z.enum(['none', 'halving_by_blocks']).default('halving_by_blocks'),
  reward_interval_blocks: z.number().int().positive().max(100_000_000).default(210_000),
  difficulty_start_bits: z.number().int().min(4).max(64).default(24),
  difficulty_step_blocks: z.number().int().positive().max(100_000_000).default(50_000),
  difficulty_max_bits: z.number().int().min(4).max(64).default(50),
  mining_algo: z.literal('rpow_classic').default('rpow_classic'),
  pool_enabled: z.boolean().default(true),
  pool_enable_at_difficulty_bits: z.number().int().min(4).max(64).nullable().optional(),
  pool_fee_bps: z.number().int().min(0).max(2000).default(200),
  pool_finder_bps: z.number().int().min(0).max(10000).default(2500),
  pool_share_bits: z.number().int().min(4).max(64).default(24),
  founder_allocation_base_units: z.string().regex(/^[0-9]{1,18}$/).default('0'),
});

function slugify(input: string): string {
  const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug.length >= 3 ? slug : `rpow-${slug || 'asset'}`;
}

async function loadAssetRows(app: FastifyInstance): Promise<AssetRow[]> {
  const { rows } = await app.pool.query<AssetRow>(
    `SELECT id::text, family_code, sequence_number, display_code, slug, nickname, description,
            creator_pubkey, status, system_default, supply_mode,
            max_supply_base_units::text, base_units_per_coin::text,
            initial_reward_base_units::text, reward_schedule_type,
            reward_interval_blocks, reward_reduction_type, reward_reduction_value::text,
            difficulty_schedule_type, difficulty_start_bits, difficulty_step_blocks,
            difficulty_max_bits, mining_algo, pool_enabled, pool_enable_at_difficulty_bits,
            pool_fee_bps, pool_finder_bps, pool_share_bits, transfer_fee_base_units::text,
            founder_allocation_base_units::text, treasury_allocation_base_units::text,
            launch_burn_event_id::text, created_at
     FROM assets
     WHERE status = 'active'
     ORDER BY sequence_number ASC`,
  );
  return rows;
}

export async function assetsRoutes(app: FastifyInstance) {
  app.get('/assets', async () => {
    const assets = (await loadAssetRows(app)).map((row) => assetWire(assetFromRow(row)));
    return { assets, default_asset_slug: 'rpow4-0', launch_burn_base_units: LAUNCH_BURN_BASE_UNITS.toString() };
  });

  app.get('/assets/:asset_slug', async (req, reply) => {
    const { asset_slug } = req.params as { asset_slug: string };
    const asset = await loadAssetBySlug(app.pool, asset_slug);
    if (!asset) return reply.code(404).send({ error: 'NOT_FOUND', message: 'asset not found' });

    const { rows } = await app.pool.query<{ name: string; value: string }>(
      `SELECT name, value::text AS value
         FROM app_counters
        WHERE asset_id=$1::uuid AND name IN ('minted_supply','block_height')`,
      [asset.id],
    );
    let minted = 0n;
    let height = 0n;
    for (const r of rows) {
      if (r.name === 'minted_supply') minted = BigInt(r.value);
      if (r.name === 'block_height') height = BigInt(r.value);
    }
    const schedule = scheduleInfoForBlock(height, minted, assetToScheduleOpts(asset));
    return { asset: assetWire(asset), schedule: {
      block_height: schedule.blockHeight.toString(),
      current_reward_base_units: schedule.currentRewardBaseUnits.toString(),
      current_difficulty_bits: schedule.currentDifficultyBits,
      next_reward_base_units: schedule.nextRewardBaseUnits.toString(),
      next_difficulty_bits: schedule.nextDifficultyBits,
      is_mintable: schedule.isMintable,
      is_capped: asset.supplyMode === 'capped' && schedule.isCapped,
    } };
  });

  app.post('/assets', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    const input = parsed.data;
    if (input.difficulty_max_bits < input.difficulty_start_bits) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'max difficulty must be >= starting difficulty' });
    }
    if (input.pool_enable_at_difficulty_bits != null && input.pool_enable_at_difficulty_bits > input.difficulty_max_bits) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'pool threshold cannot exceed max difficulty' });
    }

    const maxSupply = input.supply_mode === 'unlimited'
      ? null
      : BigInt(input.max_supply_base_units ?? (21_000_000n * BASE_UNITS_PER_RPOW).toString());
    const founderAllocation = BigInt(input.founder_allocation_base_units);
    if (input.supply_mode === 'unlimited' && founderAllocation > 0n) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'founder allocation requires a capped supply' });
    }
    if (maxSupply !== null && founderAllocation > (maxSupply * 20n) / 100n) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'founder allocation cannot exceed 20% of capped supply' });
    }

    const out = await withTxRetry(app.pool, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_asset_launch'))`);
      // Same lock key /send uses for the default asset so a concurrent
      // RPOW4.0 transfer can't race the burn against the same balance row.
      await c.query(
        `SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance:' || $1), hashtext($2))`,
        [DEFAULT_ASSET_ID, s.pubkey],
      );

      const sequence = await c.query<{ n: number }>(
        `SELECT COALESCE(max(sequence_number), 0) + 1 AS n FROM assets`,
      );
      const seq = Number(sequence.rows[0]!.n);
      const assetId = randomUUID();
      const displayCode = `RPOW4.${seq}`;
      const slugBase = input.slug ?? `rpow4-${seq}-${slugify(input.nickname)}`;

      const existing = await c.query(`SELECT 1 FROM assets WHERE slug=$1`, [slugBase]);
      if (existing.rowCount) return { error: 'SLUG_TAKEN' as const, status: 409, message: 'asset slug already exists' };

      // Burns are NOT transfers — keep them out of `sent_base_units` so the
      // reconciliation invariant `total_transferred = sum(sent_base_units)`
      // holds. We still bump `events_count` so the activity tab reflects
      // the burn in its total row count.
      const debit = await c.query(
        `UPDATE account_balances
            SET spendable_base_units = spendable_base_units - $3::bigint,
                events_count = events_count + 1,
                updated_at = now()
          WHERE asset_id=$1::uuid AND pubkey=$2 AND spendable_base_units >= $3::bigint`,
        [DEFAULT_ASSET_ID, s.pubkey, LAUNCH_BURN_BASE_UNITS.toString()],
      );
      if (debit.rowCount === 0) {
        return { error: 'INSUFFICIENT_BALANCE' as const, status: 400, message: 'not enough RPOW4 to burn launch fee' };
      }

      const burnEventId = randomUUID();
      await c.query(`INSERT INTO ledger_event_ids(id, asset_id) VALUES($1, $2::uuid)`, [burnEventId, DEFAULT_ASSET_ID]);
      const burnEvent = await c.query<LedgerEventRow>(
        `WITH inserted AS (
           INSERT INTO ledger_events(asset_id, id, event_type, actor_pubkey, amount, memo, created_at)
           VALUES($1::uuid, $2, 'BURN', $3, $4, $5, now())
           RETURNING asset_id::text, event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                     amount, fee_base_units, memo, challenge_id, solution_nonce, idempotency_key,
                     client_signature_base58, server_sig, created_at
         ),
         upd_event_id AS (
           UPDATE ledger_event_ids ids SET event_seq = i.event_seq FROM inserted i WHERE ids.id = i.id
         )
         SELECT asset_id, event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                amount::text AS amount, fee_base_units::text AS fee_base_units, memo,
                challenge_id, solution_nonce, idempotency_key, client_signature_base58, server_sig, created_at
         FROM inserted`,
        [DEFAULT_ASSET_ID, burnEventId, s.pubkey, LAUNCH_BURN_BASE_UNITS.toString(), `launch ${displayCode}`],
      );
      await c.query(
        `UPDATE ledger_stats
            SET value = value - $2::bigint, updated_at = now()
          WHERE asset_id=$1::uuid AND name='circulating_supply' AND value >= $2::bigint`,
        [DEFAULT_ASSET_ID, LAUNCH_BURN_BASE_UNITS.toString()],
      );
      await c.query(
        `INSERT INTO app_counters(asset_id, name, value)
         VALUES($1::uuid, 'burned_supply', $2::bigint)
         ON CONFLICT (asset_id, name) DO UPDATE SET value = app_counters.value + EXCLUDED.value`,
        [DEFAULT_ASSET_ID, LAUNCH_BURN_BASE_UNITS.toString()],
      );
      await mirrorLedgerEventHot(c, burnEvent.rows[0]!);

      const creatorAllocation = (founderAllocation * 90n) / 100n;
      const treasuryAllocation = founderAllocation - creatorAllocation;

      const insertedAsset = await c.query<AssetRow>(
        `INSERT INTO assets(
           id, sequence_number, display_code, slug, nickname, description, creator_pubkey,
           supply_mode, max_supply_base_units, initial_reward_base_units, reward_schedule_type,
           reward_interval_blocks, reward_reduction_type, reward_reduction_value,
           difficulty_schedule_type, difficulty_start_bits, difficulty_step_blocks, difficulty_max_bits,
           mining_algo, pool_enabled, pool_enable_at_difficulty_bits, pool_fee_bps,
           pool_finder_bps, pool_share_bits, transfer_fee_base_units,
           founder_allocation_base_units, treasury_allocation_base_units, launch_burn_event_id
         )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'percent',50,'linear_by_blocks',$13,$14,$15,
                'rpow_classic',$16,$17,$18,$19,$20,0,$21,$22,$23)
         RETURNING id::text, family_code, sequence_number, display_code, slug, nickname, description,
                   creator_pubkey, status, system_default, supply_mode,
                   max_supply_base_units::text, base_units_per_coin::text,
                   initial_reward_base_units::text, reward_schedule_type,
                   reward_interval_blocks, reward_reduction_type, reward_reduction_value::text,
                   difficulty_schedule_type, difficulty_start_bits, difficulty_step_blocks,
                   difficulty_max_bits, mining_algo, pool_enabled, pool_enable_at_difficulty_bits,
                   pool_fee_bps, pool_finder_bps, pool_share_bits, transfer_fee_base_units::text,
                   founder_allocation_base_units::text, treasury_allocation_base_units::text,
                   launch_burn_event_id::text, created_at`,
        [
          assetId,
          seq,
          displayCode,
          slugBase,
          input.nickname,
          input.description,
          s.pubkey,
          input.supply_mode,
          maxSupply?.toString() ?? null,
          input.initial_reward_base_units,
          input.reward_schedule_type,
          input.reward_interval_blocks,
          input.difficulty_start_bits,
          input.difficulty_step_blocks,
          input.difficulty_max_bits,
          input.pool_enabled,
          input.pool_enable_at_difficulty_bits ?? null,
          input.pool_fee_bps,
          input.pool_finder_bps,
          input.pool_share_bits,
          founderAllocation.toString(),
          treasuryAllocation.toString(),
          burnEventId,
        ],
      );

      await c.query(
        `INSERT INTO app_counters(asset_id, name, value)
         VALUES ($1::uuid,'minted_supply',0),($1::uuid,'block_height',0),
                ($1::uuid,'transfer_count',0),($1::uuid,'total_fees_collected',0),
                ($1::uuid,'burned_supply',0)`,
        [assetId],
      );
      // user_count tracks distinct accounts with a balance row so the
      // reconciliation view stays consistent. The creator gets a row in
      // either branch (zero-balance seat when founderAllocation==0, or a
      // positive balance via creditGenesis when creatorAllocation>0).
      // The treasury only gets a row when its slice is > 0 — creditGenesis
      // no-ops on amount<=0. Counts kept conditional so a tiny founder
      // allocation that floors creatorAllocation to 0 doesn't desync the
      // reconciliation view.
      let initialUserCount = 0;
      if (founderAllocation === 0n || creatorAllocation > 0n) initialUserCount += 1;
      if (founderAllocation > 0n && treasuryAllocation > 0n) initialUserCount += 1;
      await c.query(
        `INSERT INTO ledger_stats(asset_id, name, value)
         VALUES ($1::uuid,'circulating_supply',0),($1::uuid,'user_count',$2::bigint)`,
        [assetId, initialUserCount],
      );
      await c.query(
        `INSERT INTO ledger_stat_shards(asset_id, name, shard, value)
         SELECT $1::uuid, 'total_transferred', gs.shard::smallint, 0
         FROM generate_series(0, 63) AS gs(shard)`,
        [assetId],
      );
      if (input.pool_enabled) {
        await c.query(`INSERT INTO pool_rounds(asset_id, started_at) VALUES($1::uuid, now())`, [assetId]);
      }
      await c.query(
        `INSERT INTO markets(id, base_asset_id, quote_asset_id, symbol, status, taker_fee_bps)
         VALUES(gen_random_uuid(), $1::uuid, $2::uuid, $3, 'active', 0)
         ON CONFLICT (base_asset_id, quote_asset_id) DO NOTHING`,
        [assetId, DEFAULT_ASSET_ID, `${displayCode}/RPOW4.0`],
      );

      async function creditGenesis(pubkey: string, amount: bigint) {
        if (amount <= 0n) return;
        await c.query(
          `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units, minted_base_units, events_count, updated_at)
           VALUES($1::uuid, $2, $3, $3, 1, now())
           ON CONFLICT (asset_id, pubkey) DO UPDATE SET
             spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
             minted_base_units = account_balances.minted_base_units + EXCLUDED.minted_base_units,
             events_count = account_balances.events_count + 1,
             updated_at = now()`,
          [assetId, pubkey, amount.toString()],
        );
        const eventId = randomUUID();
        await c.query(`INSERT INTO ledger_event_ids(id, asset_id) VALUES($1, $2::uuid)`, [eventId, assetId]);
        const event = await c.query<LedgerEventRow>(
          `WITH inserted AS (
             INSERT INTO ledger_events(asset_id, id, event_type, actor_pubkey, amount, memo, created_at)
             VALUES($1::uuid, $2, 'GENESIS_ALLOCATION', $3, $4, 'founder allocation', now())
             RETURNING asset_id::text, event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                       amount, fee_base_units, memo, challenge_id, solution_nonce, idempotency_key,
                       client_signature_base58, server_sig, created_at
           ),
           upd_event_id AS (
             UPDATE ledger_event_ids ids SET event_seq = i.event_seq FROM inserted i WHERE ids.id = i.id
           )
           SELECT asset_id, event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                  amount::text AS amount, fee_base_units::text AS fee_base_units, memo,
                  challenge_id, solution_nonce, idempotency_key, client_signature_base58, server_sig, created_at
           FROM inserted`,
          [assetId, eventId, pubkey, amount.toString()],
        );
        await mirrorLedgerEventHot(c, event.rows[0]!);
      }

      if (founderAllocation > 0n) {
        await creditGenesis(s.pubkey, creatorAllocation);
        await creditGenesis(TREASURY_PUBKEY, treasuryAllocation);
        await c.query(
          `UPDATE app_counters SET value = value + $2::bigint WHERE asset_id=$1::uuid AND name='minted_supply'`,
          [assetId, founderAllocation.toString()],
        );
        await c.query(
          `UPDATE ledger_stats SET value = value + $2::bigint, updated_at = now()
           WHERE asset_id=$1::uuid AND name='circulating_supply'`,
          [assetId, founderAllocation.toString()],
        );
      } else {
        await c.query(
          `INSERT INTO account_balances(asset_id, pubkey, updated_at)
           VALUES($1::uuid, $2, now())
           ON CONFLICT (asset_id, pubkey) DO NOTHING`,
          [assetId, s.pubkey],
        );
      }

      return { asset: assetFromRow(insertedAsset.rows[0]!), burn_event_id: burnEventId };
    });

    if ('error' in out) return reply.code(out.status ?? 400).send({ error: out.error, message: out.message });
    // Drop any negative cache entry so resolveAsset() can see the
    // newly-launched asset immediately.
    invalidateAssetCache(out.asset.slug);
    app.invalidateAccount(s.pubkey);
    app.invalidateLedger();
    return reply.code(201).send({
      ok: true,
      asset: assetWire(out.asset),
      launch_burn_event_id: out.burn_event_id,
      launch_burn_base_units: LAUNCH_BURN_BASE_UNITS.toString(),
    });
  });
}
