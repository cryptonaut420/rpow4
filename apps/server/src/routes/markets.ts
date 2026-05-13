import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  TREASURY_PUBKEY,
  verifyCanonical,
  type MarketOrder,
  type MarketTrade,
} from '@rpow/shared';
import { withTxRetry } from '../db.js';
import { assetWire, DEFAULT_ASSET_ID } from '../assets.js';
import { mirrorLedgerEventHot, type LedgerEventRow } from '../ledger-hot.js';

const BASE_UNITS_PER_COIN = 1_000_000_000n;
const MAX_AMOUNT = 10n ** 18n;
// Postgres bigint upper bound (2^63 - 1). Any product or running total that
// would exceed this would otherwise crash matching mid-transaction with
// `error: bigint out of range`. We pre-validate so the API returns a clean
// BAD_REQUEST instead.
const MAX_PG_BIGINT = 9_223_372_036_854_775_807n;

const BigintString = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((s) => {
    try {
      const n = BigInt(s);
      return n > 0n && n <= MAX_AMOUNT;
    } catch {
      return false;
    }
  });

const OrderCreateBody = z.object({
  market_id: z.string().uuid(),
  side: z.enum(['buy', 'sell']),
  order_type: z.enum(['limit', 'market']),
  price_quote_base_units: BigintString.optional(),
  base_amount_base_units: BigintString,
  max_quote_base_units: BigintString.optional(),
  client_order_id: z.string().uuid(),
  client_signature_base58: z.string().min(64).max(128),
});

const OrderCancelBody = z.object({
  market_id: z.string().uuid(),
  order_id: z.string().uuid(),
  client_signature_base58: z.string().min(64).max(128),
});

interface MarketRow {
  id: string;
  symbol: string;
  status: 'active' | 'paused' | 'archived';
  taker_fee_bps: number;
  created_at: Date;
  base_id: string;
  base_family_code: string;
  base_sequence_number: number;
  base_display_code: string;
  base_slug: string;
  base_nickname: string;
  base_description: string;
  base_creator_pubkey: string | null;
  base_status: 'active' | 'paused' | 'archived';
  base_asset_kind: 'mineable' | 'external_custodial';
  base_system_default: boolean;
  base_supply_mode: 'capped' | 'unlimited';
  base_max_supply_base_units: string | null;
  base_base_units_per_coin: string;
  base_initial_reward_base_units: string;
  base_reward_schedule_type: 'none' | 'halving_by_blocks' | 'percent_by_blocks' | 'fixed_by_blocks';
  base_reward_interval_blocks: number;
  base_reward_reduction_type: 'none' | 'percent' | 'fixed';
  base_reward_reduction_value: string;
  base_difficulty_schedule_type: 'linear_by_blocks';
  base_difficulty_start_bits: number;
  base_difficulty_step_blocks: number;
  base_difficulty_max_bits: number;
  base_mining_algo: 'rpow_classic';
  base_pool_enabled: boolean;
  base_pool_enable_at_difficulty_bits: number | null;
  base_pool_fee_bps: number;
  base_pool_finder_bps: number;
  base_pool_share_bits: number;
  base_transfer_fee_base_units: string;
  base_founder_allocation_base_units: string;
  base_treasury_allocation_base_units: string;
  base_launch_burn_event_id: string | null;
  base_created_at: Date;
  quote_id: string;
  quote_family_code: string;
  quote_sequence_number: number;
  quote_display_code: string;
  quote_slug: string;
  quote_nickname: string;
  quote_description: string;
  quote_creator_pubkey: string | null;
  quote_status: 'active' | 'paused' | 'archived';
  quote_asset_kind: 'mineable' | 'external_custodial';
  quote_system_default: boolean;
  quote_supply_mode: 'capped' | 'unlimited';
  quote_max_supply_base_units: string | null;
  quote_base_units_per_coin: string;
  quote_initial_reward_base_units: string;
  quote_reward_schedule_type: 'none' | 'halving_by_blocks' | 'percent_by_blocks' | 'fixed_by_blocks';
  quote_reward_interval_blocks: number;
  quote_reward_reduction_type: 'none' | 'percent' | 'fixed';
  quote_reward_reduction_value: string;
  quote_difficulty_schedule_type: 'linear_by_blocks';
  quote_difficulty_start_bits: number;
  quote_difficulty_step_blocks: number;
  quote_difficulty_max_bits: number;
  quote_mining_algo: 'rpow_classic';
  quote_pool_enabled: boolean;
  quote_pool_enable_at_difficulty_bits: number | null;
  quote_pool_fee_bps: number;
  quote_pool_finder_bps: number;
  quote_pool_share_bits: number;
  quote_transfer_fee_base_units: string;
  quote_founder_allocation_base_units: string;
  quote_treasury_allocation_base_units: string;
  quote_launch_burn_event_id: string | null;
  quote_created_at: Date;
  last_price_quote_base_units: string | null;
  best_bid_quote_base_units: string | null;
  best_ask_quote_base_units: string | null;
  open_price_24h_quote_base_units: string | null;
  volume_24h_base_units: string;
  volume_24h_quote_base_units: string;
  trade_count_24h: string;
}

interface OrderRow {
  id: string;
  market_id: string;
  owner_pubkey: string;
  side: 'buy' | 'sell';
  order_type: 'limit' | 'market';
  price_quote_base_units: string | null;
  avg_fill_price_quote_base_units?: string | null;
  original_base_units: string;
  remaining_base_units: string;
  reserved_asset_id: string | null;
  reserved_remaining_base_units: string;
  status: MarketOrder['status'];
  client_order_id: string;
  client_signature_base58: string | null;
  created_at: Date;
  updated_at: Date;
  cancelled_at: Date | null;
}

function ceilDiv(n: bigint, d: bigint): bigint {
  return (n + d - 1n) / d;
}

class OverflowError extends Error {
  constructor() {
    super('amount overflows backend bigint range');
  }
}

function ensureFitsBigint(n: bigint): bigint {
  if (n > MAX_PG_BIGINT || n < 0n) throw new OverflowError();
  return n;
}

function quoteFor(baseAmount: bigint, price: bigint): bigint {
  // Use ceilDiv so the quoted reserve always covers the worst case for the
  // buyer (matches what the seller will collect at fill time).
  return ensureFitsBigint(ceilDiv(baseAmount * price, BASE_UNITS_PER_COIN));
}

function feeFor(quoteAmount: bigint, bps: number): bigint {
  if (bps <= 0) return 0n;
  return ensureFitsBigint(ceilDiv(quoteAmount * BigInt(bps), 10_000n));
}

function orderWire(row: OrderRow): MarketOrder {
  return {
    id: row.id,
    market_id: row.market_id,
    owner_pubkey: row.owner_pubkey,
    side: row.side,
    order_type: row.order_type,
    price_quote_base_units: row.price_quote_base_units ?? undefined,
    avg_fill_price_quote_base_units: row.avg_fill_price_quote_base_units ?? undefined,
    original_base_units: row.original_base_units,
    remaining_base_units: row.remaining_base_units,
    reserved_asset_id: row.reserved_asset_id ?? undefined,
    reserved_remaining_base_units: row.reserved_remaining_base_units,
    status: row.status,
    client_order_id: row.client_order_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    cancelled_at: row.cancelled_at?.toISOString(),
  };
}

function tradeWire(row: {
  id: string;
  market_id: string;
  price_quote_base_units: string;
  base_amount_base_units: string;
  quote_amount_base_units: string;
  taker_side: 'buy' | 'sell';
  fee_base_units: string;
  fee_asset_id: string;
  created_at: Date;
}): MarketTrade {
  return {
    id: row.id,
    market_id: row.market_id,
    price_quote_base_units: row.price_quote_base_units,
    base_amount_base_units: row.base_amount_base_units,
    quote_amount_base_units: row.quote_amount_base_units,
    taker_side: row.taker_side,
    fee_base_units: row.fee_base_units,
    fee_asset_id: row.fee_asset_id,
    created_at: row.created_at.toISOString(),
  };
}

function marketWire(row: MarketRow) {
  const base = assetWire({
    id: row.base_id,
    slug: row.base_slug,
    displayCode: row.base_display_code,
    nickname: row.base_nickname,
    description: row.base_description,
    creatorPubkey: row.base_creator_pubkey,
    assetKind: row.base_asset_kind ?? 'mineable',
    systemDefault: row.base_system_default,
    supplyMode: row.base_supply_mode,
    maxSupplyBaseUnits: row.base_max_supply_base_units === null ? null : BigInt(row.base_max_supply_base_units),
    initialRewardBaseUnits: BigInt(row.base_initial_reward_base_units),
    rewardScheduleType: row.base_reward_schedule_type,
    rewardIntervalBlocks: row.base_reward_interval_blocks,
    rewardReductionType: row.base_reward_reduction_type,
    rewardReductionValue: BigInt(row.base_reward_reduction_value),
    difficultyStartBits: row.base_difficulty_start_bits,
    difficultyStepBlocks: row.base_difficulty_step_blocks,
    difficultyMaxBits: row.base_difficulty_max_bits,
    miningAlgo: row.base_mining_algo,
    poolEnabled: row.base_pool_enabled,
    poolEnableAtDifficultyBits: row.base_pool_enable_at_difficulty_bits,
    poolFeeBps: row.base_pool_fee_bps,
    poolFinderBps: row.base_pool_finder_bps,
    poolShareBits: row.base_pool_share_bits,
    transferFeeBaseUnits: BigInt(row.base_transfer_fee_base_units),
    founderAllocationBaseUnits: BigInt(row.base_founder_allocation_base_units),
    treasuryAllocationBaseUnits: BigInt(row.base_treasury_allocation_base_units),
    launchBurnEventId: row.base_launch_burn_event_id,
    createdAt: row.base_created_at,
  });
  const quote = assetWire({
    id: row.quote_id,
    slug: row.quote_slug,
    displayCode: row.quote_display_code,
    nickname: row.quote_nickname,
    description: row.quote_description,
    creatorPubkey: row.quote_creator_pubkey,
    assetKind: row.quote_asset_kind ?? 'mineable',
    systemDefault: row.quote_system_default,
    supplyMode: row.quote_supply_mode,
    maxSupplyBaseUnits: row.quote_max_supply_base_units === null ? null : BigInt(row.quote_max_supply_base_units),
    initialRewardBaseUnits: BigInt(row.quote_initial_reward_base_units),
    rewardScheduleType: row.quote_reward_schedule_type,
    rewardIntervalBlocks: row.quote_reward_interval_blocks,
    rewardReductionType: row.quote_reward_reduction_type,
    rewardReductionValue: BigInt(row.quote_reward_reduction_value),
    difficultyStartBits: row.quote_difficulty_start_bits,
    difficultyStepBlocks: row.quote_difficulty_step_blocks,
    difficultyMaxBits: row.quote_difficulty_max_bits,
    miningAlgo: row.quote_mining_algo,
    poolEnabled: row.quote_pool_enabled,
    poolEnableAtDifficultyBits: row.quote_pool_enable_at_difficulty_bits,
    poolFeeBps: row.quote_pool_fee_bps,
    poolFinderBps: row.quote_pool_finder_bps,
    poolShareBits: row.quote_pool_share_bits,
    transferFeeBaseUnits: BigInt(row.quote_transfer_fee_base_units),
    founderAllocationBaseUnits: BigInt(row.quote_founder_allocation_base_units),
    treasuryAllocationBaseUnits: BigInt(row.quote_treasury_allocation_base_units),
    launchBurnEventId: row.quote_launch_burn_event_id,
    createdAt: row.quote_created_at,
  });
  return {
    id: row.id,
    symbol: row.symbol,
    status: row.status,
    base_asset: base,
    quote_asset: quote,
    taker_fee_bps: row.taker_fee_bps,
    last_price_quote_base_units: row.last_price_quote_base_units ?? undefined,
    best_bid_quote_base_units: row.best_bid_quote_base_units ?? undefined,
    best_ask_quote_base_units: row.best_ask_quote_base_units ?? undefined,
    open_price_24h_quote_base_units: row.open_price_24h_quote_base_units ?? undefined,
    volume_24h_base_units: row.volume_24h_base_units,
    volume_24h_quote_base_units: row.volume_24h_quote_base_units,
    trade_count_24h: Number(row.trade_count_24h),
    created_at: row.created_at.toISOString(),
  };
}

const marketSelect = `
  SELECT m.id::text, m.symbol, m.status, m.taker_fee_bps, m.created_at,
         b.id::text AS base_id, b.family_code AS base_family_code, b.sequence_number AS base_sequence_number,
         b.display_code AS base_display_code, b.slug AS base_slug, b.nickname AS base_nickname,
         b.description AS base_description, b.creator_pubkey AS base_creator_pubkey, b.status AS base_status,
         b.asset_kind AS base_asset_kind, b.system_default AS base_system_default, b.supply_mode AS base_supply_mode,
         b.max_supply_base_units::text AS base_max_supply_base_units, b.base_units_per_coin::text AS base_base_units_per_coin,
         b.initial_reward_base_units::text AS base_initial_reward_base_units, b.reward_schedule_type AS base_reward_schedule_type,
         b.reward_interval_blocks AS base_reward_interval_blocks, b.reward_reduction_type AS base_reward_reduction_type,
         b.reward_reduction_value::text AS base_reward_reduction_value, b.difficulty_schedule_type AS base_difficulty_schedule_type,
         b.difficulty_start_bits AS base_difficulty_start_bits, b.difficulty_step_blocks AS base_difficulty_step_blocks,
         b.difficulty_max_bits AS base_difficulty_max_bits, b.mining_algo AS base_mining_algo, b.pool_enabled AS base_pool_enabled,
         b.pool_enable_at_difficulty_bits AS base_pool_enable_at_difficulty_bits, b.pool_fee_bps AS base_pool_fee_bps,
         b.pool_finder_bps AS base_pool_finder_bps, b.pool_share_bits AS base_pool_share_bits,
         b.transfer_fee_base_units::text AS base_transfer_fee_base_units,
         b.founder_allocation_base_units::text AS base_founder_allocation_base_units,
         b.treasury_allocation_base_units::text AS base_treasury_allocation_base_units,
         b.launch_burn_event_id::text AS base_launch_burn_event_id, b.created_at AS base_created_at,
         q.id::text AS quote_id, q.family_code AS quote_family_code, q.sequence_number AS quote_sequence_number,
         q.display_code AS quote_display_code, q.slug AS quote_slug, q.nickname AS quote_nickname,
         q.description AS quote_description, q.creator_pubkey AS quote_creator_pubkey, q.status AS quote_status,
         q.asset_kind AS quote_asset_kind, q.system_default AS quote_system_default, q.supply_mode AS quote_supply_mode,
         q.max_supply_base_units::text AS quote_max_supply_base_units, q.base_units_per_coin::text AS quote_base_units_per_coin,
         q.initial_reward_base_units::text AS quote_initial_reward_base_units, q.reward_schedule_type AS quote_reward_schedule_type,
         q.reward_interval_blocks AS quote_reward_interval_blocks, q.reward_reduction_type AS quote_reward_reduction_type,
         q.reward_reduction_value::text AS quote_reward_reduction_value, q.difficulty_schedule_type AS quote_difficulty_schedule_type,
         q.difficulty_start_bits AS quote_difficulty_start_bits, q.difficulty_step_blocks AS quote_difficulty_step_blocks,
         q.difficulty_max_bits AS quote_difficulty_max_bits, q.mining_algo AS quote_mining_algo, q.pool_enabled AS quote_pool_enabled,
         q.pool_enable_at_difficulty_bits AS quote_pool_enable_at_difficulty_bits, q.pool_fee_bps AS quote_pool_fee_bps,
         q.pool_finder_bps AS quote_pool_finder_bps, q.pool_share_bits AS quote_pool_share_bits,
         q.transfer_fee_base_units::text AS quote_transfer_fee_base_units,
         q.founder_allocation_base_units::text AS quote_founder_allocation_base_units,
         q.treasury_allocation_base_units::text AS quote_treasury_allocation_base_units,
         q.launch_burn_event_id::text AS quote_launch_burn_event_id, q.created_at AS quote_created_at,
         (SELECT price_quote_base_units::text FROM market_trades t WHERE t.market_id=m.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_price_quote_base_units,
         (SELECT max(price_quote_base_units)::text FROM market_orders o WHERE o.market_id=m.id AND side='buy' AND status IN ('open','partially_filled') AND remaining_base_units > 0) AS best_bid_quote_base_units,
         (SELECT min(price_quote_base_units)::text FROM market_orders o WHERE o.market_id=m.id AND side='sell' AND status IN ('open','partially_filled') AND remaining_base_units > 0) AS best_ask_quote_base_units,
         (SELECT price_quote_base_units::text FROM market_trades t WHERE t.market_id=m.id AND t.created_at > now() - interval '24 hours' ORDER BY created_at ASC, id ASC LIMIT 1) AS open_price_24h_quote_base_units,
         COALESCE((SELECT sum(base_amount_base_units) FROM market_trades t WHERE t.market_id=m.id AND t.created_at > now() - interval '24 hours'), 0)::text AS volume_24h_base_units,
         COALESCE((SELECT sum(quote_amount_base_units) FROM market_trades t WHERE t.market_id=m.id AND t.created_at > now() - interval '24 hours'), 0)::text AS volume_24h_quote_base_units,
         COALESCE((SELECT count(*) FROM market_trades t WHERE t.market_id=m.id AND t.created_at > now() - interval '24 hours'), 0)::text AS trade_count_24h
    FROM markets m
    JOIN assets b ON b.id=m.base_asset_id
    JOIN assets q ON q.id=m.quote_asset_id
`;

async function loadMarket(c: PoolClient | FastifyInstance['pool'], id: string): Promise<MarketRow | null> {
  const { rows } = await c.query<MarketRow>(`${marketSelect} WHERE m.id=$1::uuid`, [id]);
  return rows[0] ?? null;
}

async function lockAccount(c: PoolClient, assetId: string, pubkey: string) {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance:' || $1), hashtext($2))`, [assetId, pubkey]);
}

async function transferLeg(
  c: PoolClient,
  args: {
    assetId: string;
    actor: string;
    recipient: string;
    amount: bigint;
    fee: bigint;
    memo: string;
    signature: string | null;
  },
): Promise<string> {
  const eventId = randomUUID();
  await c.query(`INSERT INTO ledger_event_ids(id, asset_id) VALUES($1, $2::uuid)`, [eventId, args.assetId]);
  const shardUpdate = await c.query(
    `UPDATE ledger_stat_shards
       SET value = value + $1::bigint, updated_at = now()
     WHERE asset_id=$3::uuid
       AND name='total_transferred'
       AND shard = (mod(hashtext($2)::bigint + 2147483648, 64))::smallint`,
    [args.amount.toString(), eventId, args.assetId],
  );
  if (shardUpdate.rowCount !== 1) {
    throw new Error('total_transferred shard row missing for asset');
  }
  if (args.fee > 0n) {
    const feeUpdate = await c.query(
      `UPDATE app_counters SET value = value + $1::bigint
       WHERE asset_id=$2::uuid AND name='total_fees_collected'`,
      [args.fee.toString(), args.assetId],
    );
    if (feeUpdate.rowCount !== 1) {
      throw new Error('total_fees_collected counter missing for asset');
    }
  }
  const inserted = await c.query<LedgerEventRow>(
    `WITH inserted AS (
       INSERT INTO ledger_events(
         asset_id, id, event_type, actor_pubkey, counterparty_pubkey, amount,
         fee_base_units, memo, client_signature_base58, created_at
       )
       VALUES($1::uuid,$2,'TRANSFER',$3,$4,$5,$6,$7,$8,now())
       RETURNING asset_id, event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                 amount, fee_base_units, memo, challenge_id, solution_nonce, idempotency_key,
                 client_signature_base58, server_sig, created_at
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
     SELECT asset_id::text AS asset_id, event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
            amount::text AS amount, fee_base_units::text AS fee_base_units, memo,
            challenge_id, solution_nonce, idempotency_key, client_signature_base58, server_sig, created_at
     FROM inserted`,
    [
      args.assetId,
      eventId,
      args.actor,
      args.recipient,
      args.amount.toString(),
      args.fee.toString(),
      args.memo,
      args.signature,
    ],
  );
  await mirrorLedgerEventHot(c, inserted.rows[0]!);
  return eventId;
}

export async function marketsRoutes(app: FastifyInstance) {
  app.get('/markets', async () => {
    // Only surface trading pairs whose market AND both legs are active.
    // A paused/archived asset (or a paused market row itself) shouldn't
    // appear in the picker — clients would otherwise see the pair, click
    // through, and then hit MARKET_NOT_FOUND on order placement.
    const { rows } = await app.pool.query<MarketRow>(
      `${marketSelect}
       WHERE m.status = 'active' AND b.status = 'active' AND q.status = 'active'
       ORDER BY
         CASE WHEN b.slug = 'rpow2' AND q.slug = 'rpow4-0' THEN 0 ELSE 1 END,
         b.sequence_number ASC,
         m.symbol ASC`,
    );
    return { markets: rows.map(marketWire), default_quote_asset_slug: 'rpow4-0' };
  });

  app.get('/markets/:market_id', async (req, reply) => {
    const id = (req.params as { market_id: string }).market_id;
    const market = await loadMarket(app.pool, id);
    if (!market) return reply.code(404).send({ error: 'MARKET_NOT_FOUND', message: 'market not found' });
    return { market: marketWire(market) };
  });

  app.get('/markets/:market_id/book', async (req, reply) => {
    const id = (req.params as { market_id: string }).market_id;
    // Validate the market exists before returning what would otherwise be
    // an empty book that's indistinguishable from a real (idle) market.
    const exists = await app.pool.query(`SELECT 1 FROM markets WHERE id=$1::uuid`, [id]);
    if (exists.rowCount === 0) {
      return reply.code(404).send({ error: 'MARKET_NOT_FOUND', message: 'market not found' });
    }
    const { rows: bids } = await app.pool.query(
      `SELECT price_quote_base_units::text,
              sum(remaining_base_units)::text AS base_amount_base_units,
              sum(ceil((remaining_base_units::numeric * price_quote_base_units::numeric) / 1000000000))::text AS quote_amount_base_units,
              count(*)::int AS order_count
       FROM market_orders
       WHERE market_id=$1::uuid AND side='buy' AND status IN ('open','partially_filled') AND remaining_base_units > 0
       GROUP BY price_quote_base_units
       ORDER BY price_quote_base_units DESC
       LIMIT 25`,
      [id],
    );
    const { rows: asks } = await app.pool.query(
      `SELECT price_quote_base_units::text,
              sum(remaining_base_units)::text AS base_amount_base_units,
              sum(ceil((remaining_base_units::numeric * price_quote_base_units::numeric) / 1000000000))::text AS quote_amount_base_units,
              count(*)::int AS order_count
       FROM market_orders
       WHERE market_id=$1::uuid AND side='sell' AND status IN ('open','partially_filled') AND remaining_base_units > 0
       GROUP BY price_quote_base_units
       ORDER BY price_quote_base_units ASC
       LIMIT 25`,
      [id],
    );
    return { market_id: id, bids, asks, at: new Date().toISOString() };
  });

  app.get('/markets/:market_id/trades', async (req, reply) => {
    const id = (req.params as { market_id: string }).market_id;
    const q = req.query as { limit?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50) || 50));
    const exists = await app.pool.query(`SELECT 1 FROM markets WHERE id=$1::uuid`, [id]);
    if (exists.rowCount === 0) {
      return reply.code(404).send({ error: 'MARKET_NOT_FOUND', message: 'market not found' });
    }
    const { rows } = await app.pool.query(
      `SELECT id::text, market_id::text, price_quote_base_units::text, base_amount_base_units::text,
              quote_amount_base_units::text, taker_side, fee_base_units::text, fee_asset_id::text, created_at
       FROM market_trades
       WHERE market_id=$1::uuid
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [id, limit],
    );
    return { trades: rows.map(tradeWire) };
  });

  app.get('/markets/:market_id/candles', async (req, reply) => {
    const id = (req.params as { market_id: string }).market_id;
    const q = req.query as { interval?: string; limit?: string };
    const exists = await app.pool.query(`SELECT 1 FROM markets WHERE id=$1::uuid`, [id]);
    if (exists.rowCount === 0) {
      return reply.code(404).send({ error: 'MARKET_NOT_FOUND', message: 'market not found' });
    }
    const interval = q.interval === '5m' || q.interval === '1h' || q.interval === '1d' ? q.interval : '1m';
    const limit = Math.min(240, Math.max(1, Number(q.limit ?? 80) || 80));
    const bucketExpr =
      interval === '1d' ? `date_trunc('day', created_at)` :
      interval === '1h' ? `date_trunc('hour', created_at)` :
      interval === '5m' ? `date_trunc('hour', created_at) + floor(date_part('minute', created_at) / 5) * interval '5 minutes'` :
      `date_trunc('minute', created_at)`;
    const { rows } = await app.pool.query(
      `WITH bucketed AS (
         SELECT ${bucketExpr} AS bucket_start, *
         FROM market_trades
         WHERE market_id=$1::uuid
       ),
       grouped AS (
         SELECT bucket_start,
                (array_agg(price_quote_base_units ORDER BY created_at ASC, id ASC))[1] AS open_quote_base_units,
                max(price_quote_base_units) AS high_quote_base_units,
                min(price_quote_base_units) AS low_quote_base_units,
                (array_agg(price_quote_base_units ORDER BY created_at DESC, id DESC))[1] AS close_quote_base_units,
                sum(base_amount_base_units) AS volume_base_units,
                sum(quote_amount_base_units) AS volume_quote_base_units,
                count(*)::int AS trade_count
         FROM bucketed
         GROUP BY bucket_start
       )
       SELECT bucket_start, open_quote_base_units::text, high_quote_base_units::text, low_quote_base_units::text,
              close_quote_base_units::text, volume_base_units::text, volume_quote_base_units::text, trade_count
       FROM grouped
       ORDER BY bucket_start DESC
       LIMIT $2`,
      [id, limit],
    );
    return {
      market_id: id,
      interval,
      candles: rows.reverse().map((r: any) => ({ ...r, bucket_start: r.bucket_start.toISOString() })),
    };
  });

  app.get('/markets/:market_id/balances', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const id = (req.params as { market_id: string }).market_id;
    const market = await loadMarket(app.pool, id);
    if (!market) return reply.code(404).send({ error: 'MARKET_NOT_FOUND', message: 'market not found' });
    const { rows } = await app.pool.query<{ asset_id: string; spendable: string; locked: string }>(
      `SELECT asset_id::text, spendable_base_units::text AS spendable, locked_base_units::text AS locked
       FROM account_balances
       WHERE pubkey=$1 AND asset_id IN ($2::uuid,$3::uuid)`,
      [s.pubkey, market.base_id, market.quote_id],
    );
    const byAsset = new Map(rows.map((r) => [r.asset_id, r]));
    const base = byAsset.get(market.base_id);
    const quote = byAsset.get(market.quote_id);
    return {
      market_id: id,
      base: {
        asset_id: market.base_id,
        asset_slug: market.base_slug,
        asset_code: market.base_display_code,
        spendable_base_units: base?.spendable ?? '0',
        locked_base_units: base?.locked ?? '0',
      },
      quote: {
        asset_id: market.quote_id,
        asset_slug: market.quote_slug,
        asset_code: market.quote_display_code,
        spendable_base_units: quote?.spendable ?? '0',
        locked_base_units: quote?.locked ?? '0',
      },
    };
  });

  app.get('/markets/:market_id/my-orders', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const id = (req.params as { market_id: string }).market_id;
    const { rows } = await app.pool.query<OrderRow>(
      `SELECT o.id::text, o.market_id::text, o.owner_pubkey, o.side, o.order_type, o.price_quote_base_units::text,
              o.original_base_units::text, o.remaining_base_units::text, o.reserved_asset_id::text,
              o.reserved_remaining_base_units::text, o.status, o.client_order_id::text, o.client_signature_base58,
              o.created_at, o.updated_at, o.cancelled_at,
              (SELECT ceil(
                 sum(t.quote_amount_base_units::numeric) * 1000000000
                 / NULLIF(sum(t.base_amount_base_units::numeric), 0)
               )::text
               FROM market_trades t
               WHERE t.maker_order_id = o.id OR t.taker_order_id = o.id) AS avg_fill_price_quote_base_units
       FROM market_orders o
       WHERE o.market_id=$1::uuid AND o.owner_pubkey=$2
       ORDER BY o.created_at DESC
       LIMIT 100`,
      [id, s.pubkey],
    );
    return { orders: rows.map(orderWire) };
  });

  app.post('/markets/:market_id/orders', async (req: FastifyRequest, reply: FastifyReply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = OrderCreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    const body = parsed.data;
    const routeMarketId = (req.params as { market_id: string }).market_id;
    if (body.market_id !== routeMarketId) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'market mismatch' });
    if (body.order_type === 'limit' && !body.price_quote_base_units) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'limit orders require price' });
    }
    if (body.order_type === 'market' && body.price_quote_base_units) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'market orders cannot include price' });
    }
    const sigBody: Record<string, string> = {
      market_id: body.market_id,
      side: body.side,
      order_type: body.order_type,
      base_amount_base_units: body.base_amount_base_units,
      client_order_id: body.client_order_id,
    };
    if (body.price_quote_base_units) sigBody.price_quote_base_units = body.price_quote_base_units;
    if (body.max_quote_base_units) sigBody.max_quote_base_units = body.max_quote_base_units;
    if (!verifyCanonical('market.order.create', sigBody, body.client_signature_base58, s.pubkey)) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: 'order signature does not verify' });
    }

    // Pre-validate that the headline amounts fit in pg bigint so we fail
    // cleanly rather than blowing up mid-transaction with `bigint out of
    // range`. Per-fill running totals are also covered by ensureFitsBigint
    // inside quoteFor / feeFor below.
    try {
      const baseAmount = BigInt(body.base_amount_base_units);
      ensureFitsBigint(baseAmount);
      if (body.price_quote_base_units) {
        const price = BigInt(body.price_quote_base_units);
        ensureFitsBigint(price);
        // Limit-buy reservation is the most likely pure-input overflow path.
        if (body.side === 'buy' && body.order_type === 'limit') {
          quoteFor(baseAmount, price);
        }
      }
      if (body.max_quote_base_units) ensureFitsBigint(BigInt(body.max_quote_base_units));
    } catch (err) {
      if (err instanceof OverflowError) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'order amount/price exceeds backend precision; reduce size' });
      }
      throw err;
    }

    let result;
    try {
      result = await withTxRetry(app.pool, async (c) => {
      const market = await loadMarket(c, body.market_id);
      if (!market) return { error: 'MARKET_NOT_FOUND' as const, status: 404, message: 'market not found' };
      if (market.status !== 'active') return { error: 'MARKET_PAUSED' as const, status: 400, message: 'market is not active' };

      const dup = await c.query<OrderRow>(
        `SELECT id::text, market_id::text, owner_pubkey, side, order_type, price_quote_base_units::text,
                original_base_units::text, remaining_base_units::text, reserved_asset_id::text,
                reserved_remaining_base_units::text, status, client_order_id::text, client_signature_base58,
                created_at, updated_at, cancelled_at
         FROM market_orders
         WHERE owner_pubkey=$1 AND client_order_id=$2::uuid`,
        [s.pubkey, body.client_order_id],
      );
      if (dup.rows[0]) {
        const existing = dup.rows[0];
        // Reject cross-market replays. (owner_pubkey, client_order_id) is
        // globally unique, so a retry that targets a different market_id
        // must be a client bug — surface it instead of returning the prior
        // market's order with the new market's status code.
        if (existing.market_id !== body.market_id) {
          return {
            error: 'BAD_REQUEST' as const,
            status: 409,
            message: 'client_order_id reused across different markets',
          };
        }
        const { rows: dupTrades } = await c.query<{
          id: string;
          market_id: string;
          price_quote_base_units: string;
          base_amount_base_units: string;
          quote_amount_base_units: string;
          taker_side: 'buy' | 'sell';
          fee_base_units: string;
          fee_asset_id: string;
          created_at: Date;
        }>(
          `SELECT id::text, market_id::text, price_quote_base_units::text, base_amount_base_units::text,
                  quote_amount_base_units::text, taker_side, fee_base_units::text, fee_asset_id::text, created_at
           FROM market_trades
           WHERE taker_order_id=$1::uuid
           ORDER BY created_at ASC, id ASC`,
          [existing.id],
        );
        let filled = 0n;
        let spentQuote = 0n;
        let receivedQuote = 0n;
        let fee = 0n;
        for (const t of dupTrades) {
          const base = BigInt(t.base_amount_base_units);
          const quote = BigInt(t.quote_amount_base_units);
          const tradeFee = BigInt(t.fee_base_units);
          filled += base;
          fee += tradeFee;
          if (existing.side === 'buy') spentQuote += quote;
          else receivedQuote += quote - tradeFee;
        }
        return {
          ok: true as const,
          order: orderWire(existing),
          trades: dupTrades.map(tradeWire),
          filled_base_units: filled.toString(),
          spent_quote_base_units: spentQuote.toString(),
          received_quote_base_units: receivedQuote.toString(),
          fee_base_units: fee.toString(),
          touched_pubkeys: [s.pubkey],
        };
      }

      await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_market'), hashtext($1))`, [body.market_id]);
      const baseAmount = BigInt(body.base_amount_base_units);
      const price = body.price_quote_base_units ? BigInt(body.price_quote_base_units) : null;
      let reserveAssetId: string | null = null;
      let reserve = 0n;
      if (body.order_type === 'limit') {
        if (body.side === 'buy') {
          reserveAssetId = market.quote_id;
          reserve = quoteFor(baseAmount, price!);
        } else {
          reserveAssetId = market.base_id;
          reserve = baseAmount;
        }
        await lockAccount(c, reserveAssetId, s.pubkey);
        const debit = await c.query(
          `UPDATE account_balances
              SET spendable_base_units = spendable_base_units - $3::bigint,
                  locked_base_units = locked_base_units + $3::bigint,
                  updated_at = now()
            WHERE asset_id=$1::uuid AND pubkey=$2 AND spendable_base_units >= $3::bigint`,
          [reserveAssetId, s.pubkey, reserve.toString()],
        );
        if (debit.rowCount === 0) return { error: 'INSUFFICIENT_BALANCE' as const, status: 400, message: 'not enough available balance to reserve order' };
      }

      const orderId = randomUUID();
      const inserted = await c.query<OrderRow>(
        `INSERT INTO market_orders(
           id, market_id, owner_pubkey, side, order_type, price_quote_base_units,
           original_base_units, remaining_base_units, reserved_asset_id, reserved_remaining_base_units,
           status, client_order_id, client_signature_base58
         )
         VALUES($1,$2::uuid,$3,$4,$5,$6::bigint,$7::bigint,$7::bigint,$8::uuid,$9::bigint,'open',$10::uuid,$11)
         RETURNING id::text, market_id::text, owner_pubkey, side, order_type, price_quote_base_units::text,
                   original_base_units::text, remaining_base_units::text, reserved_asset_id::text,
                   reserved_remaining_base_units::text, status, client_order_id::text, client_signature_base58,
                   created_at, updated_at, cancelled_at`,
        [
          orderId,
          body.market_id,
          s.pubkey,
          body.side,
          body.order_type,
          price?.toString() ?? null,
          baseAmount.toString(),
          reserveAssetId,
          reserve.toString(),
          body.client_order_id,
          body.client_signature_base58,
        ],
      );

      const trades: MarketTrade[] = [];
      let remaining = baseAmount;
      let spentQuote = 0n;
      let receivedQuote = 0n;
      let totalFee = 0n;
      let totalQuoteFee = 0n;
      const touchedPubkeys = new Set<string>([s.pubkey]);
      for (;;) {
        if (remaining <= 0n) break;
        const makerRes = await c.query<OrderRow>(
          `SELECT id::text, market_id::text, owner_pubkey, side, order_type, price_quote_base_units::text,
                  original_base_units::text, remaining_base_units::text, reserved_asset_id::text,
                  reserved_remaining_base_units::text, status, client_order_id::text, client_signature_base58,
                  created_at, updated_at, cancelled_at
           FROM market_orders
           WHERE market_id=$1::uuid
             AND owner_pubkey <> $2
             AND side=$3
             AND status IN ('open','partially_filled')
             AND remaining_base_units > 0
             AND ($4::bigint IS NULL OR (side='sell' AND price_quote_base_units <= $4::bigint) OR (side='buy' AND price_quote_base_units >= $4::bigint))
           ORDER BY
             CASE WHEN side='sell' THEN price_quote_base_units END ASC,
             CASE WHEN side='buy' THEN price_quote_base_units END DESC,
             created_at ASC, id ASC
           LIMIT 1
           FOR UPDATE`,
          [body.market_id, s.pubkey, body.side === 'buy' ? 'sell' : 'buy', body.order_type === 'limit' ? price!.toString() : null],
        );
        const maker = makerRes.rows[0];
        if (!maker) break;
        const fillBase = remaining < BigInt(maker.remaining_base_units) ? remaining : BigInt(maker.remaining_base_units);
        const fillPrice = BigInt(maker.price_quote_base_units!);
        const fillQuote = quoteFor(fillBase, fillPrice);
        const feeInBase = market.base_asset_kind === 'external_custodial';
        const feeAssetId = feeInBase ? market.base_id : market.quote_id;
        const fee = feeFor(feeInBase ? fillBase : fillQuote, market.taker_fee_bps);
        const baseFee = feeInBase ? fee : 0n;
        const quoteFee = feeInBase ? 0n : fee;
        const buyerBaseReceive = fillBase - baseFee;
        // Seller's quote receipt depends on which side the taker is on so that
        // both buyer outflow + treasury inflow conserves total QUOTE supply:
        //   buy-taker:  buyer pays fillQuote + quoteFee, seller gets full
        //               fillQuote, treasury gets quoteFee.
        //   sell-taker: maker (buyer) gives up exactly the fillQuote they
        //               locked, seller gets fillQuote - quoteFee, treasury
        //               gets quoteFee. (sellerNetQuote)
        // Using `sellerNetQuote` for both sides was a real bug that broke
        // `circulating_matches_balances` on buy-taker fills because the same
        // quoteFee was both withheld from the seller AND debited from the
        // buyer on top, with only one copy reaching the treasury.
        const sellerNetQuote = fillQuote - quoteFee;
        const sellerQuoteCredit = body.side === 'buy' ? fillQuote : sellerNetQuote;
        // Slippage cap: stop when the next fill would push the buyer's
        // total quote outflow (existing fills + their fees + this fill +
        // its fee) past max_quote. Without including cumulative fee, a
        // taker_fee>0 market buy could over-spend on later fills.
        if (
          body.side === 'buy' &&
          body.max_quote_base_units &&
          spentQuote + totalQuoteFee + fillQuote + quoteFee > BigInt(body.max_quote_base_units)
        ) break;
        const buyer = body.side === 'buy' ? s.pubkey : maker.owner_pubkey;
        const seller = body.side === 'sell' ? s.pubkey : maker.owner_pubkey;
        touchedPubkeys.add(maker.owner_pubkey);
        const lockPairs = [
          [market.base_id, buyer],
          [market.base_id, seller],
          [market.quote_id, buyer],
          [market.quote_id, seller],
          ...(fee > 0n ? [[feeAssetId, TREASURY_PUBKEY] as [string, string]] : []),
        ] as Array<[string, string]>;
        for (const [assetId, pubkey] of Array.from(new Map(lockPairs.map((p) => [`${p[0]}|${p[1]}`, p])).values()).sort(([a1, p1], [a2, p2]) => `${a1}|${p1}`.localeCompare(`${a2}|${p2}`))) {
          await lockAccount(c, assetId, pubkey);
        }
        if (body.side === 'buy') {
          if (body.order_type === 'market') {
            const debit = await c.query(
              `UPDATE account_balances SET spendable_base_units = spendable_base_units - $3::bigint, sent_base_units = sent_base_units + $4::bigint, events_count = events_count + 1, updated_at=now()
               WHERE asset_id=$1::uuid AND pubkey=$2 AND spendable_base_units >= $3::bigint`,
              [market.quote_id, buyer, (fillQuote + quoteFee).toString(), fillQuote.toString()],
            );
            if (debit.rowCount === 0) break;
          } else {
            const debit = await c.query(
              `UPDATE account_balances
                  SET locked_base_units = locked_base_units - $3::bigint,
                      spendable_base_units = spendable_base_units - $4::bigint,
                      sent_base_units = sent_base_units + $3::bigint,
                      events_count = events_count + 1,
                      updated_at=now()
                WHERE asset_id=$1::uuid
                  AND pubkey=$2
                  AND locked_base_units >= $3::bigint
                  AND spendable_base_units >= $4::bigint`,
              [market.quote_id, buyer, fillQuote.toString(), quoteFee.toString()],
            );
            if (debit.rowCount === 0) break;
          }
        } else {
          if (body.order_type === 'market') {
            const debit = await c.query(
              `UPDATE account_balances SET spendable_base_units = spendable_base_units - $3::bigint, sent_base_units = sent_base_units + $4::bigint, events_count = events_count + 1, updated_at=now()
               WHERE asset_id=$1::uuid AND pubkey=$2 AND spendable_base_units >= $3::bigint`,
              [market.base_id, seller, fillBase.toString(), buyerBaseReceive.toString()],
            );
            if (debit.rowCount === 0) break;
          } else {
            const debit = await c.query(
              `UPDATE account_balances SET locked_base_units = locked_base_units - $3::bigint, sent_base_units = sent_base_units + $4::bigint, events_count = events_count + 1, updated_at=now()
               WHERE asset_id=$1::uuid AND pubkey=$2 AND locked_base_units >= $3::bigint`,
              [market.base_id, seller, fillBase.toString(), buyerBaseReceive.toString()],
            );
            if (debit.rowCount === 0) break;
          }
        }
        // Maker debit: settle the funds the maker reserved when they posted
        // their resting order. For a buy-taker the maker is a SELL with
        // base_id locked; for a sell-taker the maker is a BUY with quote_id
        // locked.
        //
        // Fee model (taker pays in quote, regardless of side):
        //   - buy-taker: buyer pays fillQuote + fee total (seller still
        //     receives full fillQuote). The fee was already debited from the
        //     taker buyer's spendable a few lines up — nothing else here.
        //   - sell-taker: buyer (maker) gives up exactly the fillQuote they
        //     locked, of which `fee` is routed to the treasury and the
        //     remainder goes to the seller (taker). Buyer's sent reflects
        //     what the recipient (seller) actually received, matching the
        //     send.ts convention so total_transferred == sum(sent_base_units)
        //     stays balanced.
        if (body.side === 'buy') {
          const makerDebit = await c.query(
            `UPDATE account_balances SET locked_base_units = locked_base_units - $3::bigint, sent_base_units = sent_base_units + $4::bigint, events_count = events_count + 1, updated_at=now()
             WHERE asset_id=$1::uuid AND pubkey=$2 AND locked_base_units >= $3::bigint`,
            [market.base_id, seller, fillBase.toString(), buyerBaseReceive.toString()],
          );
          if (makerDebit.rowCount !== 1) throw new Error('market maker base reservation invariant failed');
        } else {
          // Sell-taker: maker (buyer) had `fillQuote` locked. Their `sent` is
          // what the recipient (seller) actually received, which is
          // sellerQuoteCredit = sellerNetQuote here.
          const makerDebit = await c.query(
            `UPDATE account_balances SET locked_base_units = locked_base_units - $3::bigint, sent_base_units = sent_base_units + $4::bigint, events_count = events_count + 1, updated_at=now()
             WHERE asset_id=$1::uuid AND pubkey=$2 AND locked_base_units >= $3::bigint`,
            [market.quote_id, buyer, fillQuote.toString(), sellerQuoteCredit.toString()],
          );
          if (makerDebit.rowCount !== 1) throw new Error('market maker quote reservation invariant failed');
        }
        // Buyer + seller credits create their first balance row in the
        // base/quote asset whenever they're new to it; bump per-asset
        // user_count so the ledger_accounting_reconciliation invariant
        // (user_count == balance_row_count) stays honest. Same `(xmax = 0)`
        // pattern as send/mint/pool/claim/faucet.
        const buyerBaseCredit = await c.query<{ was_inserted: boolean }>(
          `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units, received_base_units, events_count, updated_at)
           VALUES($1::uuid, $2, $3, $3, 1, now())
           ON CONFLICT (asset_id, pubkey) DO UPDATE SET
             spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
             received_base_units = account_balances.received_base_units + EXCLUDED.received_base_units,
             events_count = account_balances.events_count + 1,
             updated_at=now()
           RETURNING (xmax = 0) AS was_inserted`,
          [market.base_id, buyer, buyerBaseReceive.toString()],
        );
        if (buyerBaseCredit.rows[0]?.was_inserted) {
          await c.query(
            `UPDATE ledger_stats SET value = value + 1, updated_at = now()
             WHERE asset_id=$1::uuid AND name='user_count'`,
            [market.base_id],
          );
        }
        const sellerQuoteCreditRow = await c.query<{ was_inserted: boolean }>(
          `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units, received_base_units, events_count, updated_at)
           VALUES($1::uuid, $2, $3, $3, 1, now())
           ON CONFLICT (asset_id, pubkey) DO UPDATE SET
             spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
             received_base_units = account_balances.received_base_units + EXCLUDED.received_base_units,
             events_count = account_balances.events_count + 1,
             updated_at=now()
           RETURNING (xmax = 0) AS was_inserted`,
          [market.quote_id, seller, sellerQuoteCredit.toString()],
        );
        if (sellerQuoteCreditRow.rows[0]?.was_inserted) {
          await c.query(
            `UPDATE ledger_stats SET value = value + 1, updated_at = now()
             WHERE asset_id=$1::uuid AND name='user_count'`,
            [market.quote_id],
          );
        }
        if (fee > 0n) {
          // Treasury already has a row at genesis on every asset, so this
          // is essentially a no-op for user_count, but keep the pattern
          // consistent so a hypothetical future fee-asset without a treasury
          // row stays balanced.
          const treasuryCredit = await c.query<{ was_inserted: boolean }>(
            `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units, updated_at)
             VALUES($1::uuid, $2, $3, now())
             ON CONFLICT (asset_id, pubkey) DO UPDATE SET
               spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
               updated_at=now()
             RETURNING (xmax = 0) AS was_inserted`,
            [feeAssetId, TREASURY_PUBKEY, fee.toString()],
          );
          if (treasuryCredit.rows[0]?.was_inserted) {
            await c.query(
              `UPDATE ledger_stats SET value = value + 1, updated_at = now()
               WHERE asset_id=$1::uuid AND name='user_count'`,
              [feeAssetId],
            );
          }
        }
        const tradeId = randomUUID();
        const memo = `trade:${tradeId}`;
        const baseEventId = await transferLeg(c, {
          assetId: market.base_id,
          actor: seller,
          recipient: buyer,
          amount: buyerBaseReceive,
          fee: baseFee,
          memo,
          signature: body.side === 'sell' ? body.client_signature_base58 : maker.client_signature_base58,
        });
        // The quote leg's `amount` is the recipient's net gain (matches
        // send.ts), so total_transferred / sent / received stay aligned. For
        // buy-takers that's the full fillQuote; for sell-takers it's
        // fillQuote minus the taker fee (kept by the treasury).
        const quoteEventId = await transferLeg(c, {
          assetId: market.quote_id,
          actor: buyer,
          recipient: seller,
          amount: sellerQuoteCredit,
          fee: quoteFee,
          memo,
          signature: body.side === 'buy' ? body.client_signature_base58 : maker.client_signature_base58,
        });
        const tr = await c.query(
          `INSERT INTO market_trades(
             id, market_id, maker_order_id, taker_order_id, maker_pubkey, taker_pubkey, taker_side,
             price_quote_base_units, base_amount_base_units, quote_amount_base_units, fee_base_units,
             fee_asset_id, base_event_id, quote_event_id
           )
           VALUES($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8::bigint,$9::bigint,$10::bigint,$11::bigint,$12::uuid,$13,$14)
           RETURNING id::text, market_id::text, price_quote_base_units::text, base_amount_base_units::text,
                     quote_amount_base_units::text, taker_side, fee_base_units::text, fee_asset_id::text, created_at`,
          [tradeId, body.market_id, maker.id, orderId, maker.owner_pubkey, s.pubkey, body.side, fillPrice.toString(), fillBase.toString(), fillQuote.toString(), fee.toString(), feeAssetId, baseEventId, quoteEventId],
        );
        trades.push(tradeWire(tr.rows[0] as any));
        remaining -= fillBase;
        if (body.side === 'buy') spentQuote += fillQuote;
        else receivedQuote += sellerNetQuote;
        totalFee += fee;
        totalQuoteFee += quoteFee;
        const makerRemaining = BigInt(maker.remaining_base_units) - fillBase;
        const makerStatus = makerRemaining === 0n ? 'filled' : 'partially_filled';
        await c.query(
          `UPDATE market_orders
           SET remaining_base_units=$2::bigint,
               reserved_remaining_base_units = GREATEST(0, reserved_remaining_base_units - $3::bigint),
               status=$4,
               updated_at=now()
           WHERE id=$1::uuid`,
          [maker.id, makerRemaining.toString(), maker.side === 'sell' ? fillBase.toString() : fillQuote.toString(), makerStatus],
        );
      }

      // Market orders never rest on the book; once we exit the matching
      // loop the order is terminal regardless of how much it filled.
      // Forcing remaining=0 prevents stale market rows from ever being
      // picked up by a future match (the index includes
      // `remaining_base_units > 0`).
      const isMarketTerminal = body.order_type === 'market';
      const finalStatus =
        remaining === 0n ? 'filled' :
        isMarketTerminal ? (remaining === baseAmount ? 'rejected' : 'partially_filled') :
        remaining < baseAmount ? 'partially_filled' : 'open';
      const finalRemaining = isMarketTerminal ? 0n : remaining;
      // Limit orders release any leftover reservation that is no longer
      // needed. A buy taker can fill at prices below their limit, so keeping
      // `reserve - spentQuote` locked would over-reserve quote while the
      // remaining order rests. Instead, retain only the maximum quote needed
      // to fill the remaining base at the taker's limit price.
      let release = 0n;
      if (body.order_type === 'limit' && reserveAssetId) {
        const neededReservation =
          finalStatus === 'filled'
            ? 0n
            : (body.side === 'sell' ? remaining : quoteFor(remaining, price!));
        const currentReservation =
          body.side === 'sell' ? reserve - (baseAmount - remaining) : reserve - spentQuote;
        release = currentReservation - neededReservation;
      }
      const reservedRemaining =
        body.order_type === 'limit' && finalStatus !== 'filled'
          ? (body.side === 'sell' ? remaining : quoteFor(remaining, price!))
          : 0n;
      if (release > 0n && reserveAssetId) {
        const releaseResult = await c.query(
          `UPDATE account_balances SET locked_base_units = locked_base_units - $3::bigint, spendable_base_units = spendable_base_units + $3::bigint, updated_at=now()
           WHERE asset_id=$1::uuid AND pubkey=$2 AND locked_base_units >= $3::bigint`,
          [reserveAssetId, s.pubkey, release.toString()],
        );
        if (releaseResult.rowCount !== 1) throw new Error('market reservation release invariant failed');
      }
      const updated = await c.query<OrderRow>(
        `UPDATE market_orders
         SET remaining_base_units=$2::bigint,
             reserved_remaining_base_units=$3::bigint,
             status=$4,
             updated_at=now()
         WHERE id=$1::uuid
         RETURNING id::text, market_id::text, owner_pubkey, side, order_type, price_quote_base_units::text,
                   original_base_units::text, remaining_base_units::text, reserved_asset_id::text,
                   reserved_remaining_base_units::text, status, client_order_id::text, client_signature_base58,
                   created_at, updated_at, cancelled_at`,
        [orderId, finalRemaining.toString(), reservedRemaining.toString(), finalStatus],
      );
      return {
        ok: true as const,
        order: orderWire(updated.rows[0] ?? inserted.rows[0]!),
        trades,
        filled_base_units: (baseAmount - remaining).toString(),
        spent_quote_base_units: spentQuote.toString(),
        received_quote_base_units: receivedQuote.toString(),
        fee_base_units: totalFee.toString(),
        touched_pubkeys: Array.from(touchedPubkeys),
      };
      });
    } catch (err) {
      if (err instanceof OverflowError) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'order amount/price would overflow backend precision; reduce size' });
      }
      throw err;
    }
    if ('error' in result) return reply.code(result.status ?? 400).send({ error: result.error, message: result.message });
    for (const pubkey of result.touched_pubkeys) app.invalidateAccount(pubkey);
    app.invalidateLedger();
    const { touched_pubkeys: _touched, ...responseBody } = result;
    return responseBody;
  });

  app.post('/markets/:market_id/orders/:order_id/cancel', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = OrderCancelBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    const body = parsed.data;
    const params = req.params as { market_id: string; order_id: string };
    if (body.market_id !== params.market_id || body.order_id !== params.order_id) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'order mismatch' });
    }
    const sigBody = { market_id: body.market_id, order_id: body.order_id };
    if (!verifyCanonical('market.order.cancel', sigBody, body.client_signature_base58, s.pubkey)) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: 'cancel signature does not verify' });
    }
    const result = await withTxRetry(app.pool, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_market'), hashtext($1))`, [body.market_id]);
      const { rows } = await c.query<OrderRow>(
        `SELECT id::text, market_id::text, owner_pubkey, side, order_type, price_quote_base_units::text,
                original_base_units::text, remaining_base_units::text, reserved_asset_id::text,
                reserved_remaining_base_units::text, status, client_order_id::text, client_signature_base58,
                created_at, updated_at, cancelled_at
         FROM market_orders
         WHERE id=$1::uuid AND market_id=$2::uuid AND owner_pubkey=$3
         FOR UPDATE`,
        [body.order_id, body.market_id, s.pubkey],
      );
      const order = rows[0];
      if (!order) return { error: 'ORDER_NOT_FOUND' as const, status: 404, message: 'order not found' };
      if (order.status !== 'open' && order.status !== 'partially_filled') {
        return { ok: true as const, order: orderWire(order), released_base_units: '0' };
      }
      const release = BigInt(order.reserved_remaining_base_units);
      if (release > 0n && order.reserved_asset_id) {
        await lockAccount(c, order.reserved_asset_id, s.pubkey);
        const releaseResult = await c.query(
          `UPDATE account_balances
             SET locked_base_units = locked_base_units - $3::bigint,
                 spendable_base_units = spendable_base_units + $3::bigint,
                 updated_at=now()
           WHERE asset_id=$1::uuid AND pubkey=$2 AND locked_base_units >= $3::bigint`,
          [order.reserved_asset_id, s.pubkey, release.toString()],
        );
        if (releaseResult.rowCount !== 1) throw new Error('market cancel release invariant failed');
      }
      const updated = await c.query<OrderRow>(
        `UPDATE market_orders
         SET status='cancelled', remaining_base_units=0, reserved_remaining_base_units=0,
             cancelled_at=now(), updated_at=now()
         WHERE id=$1::uuid
         RETURNING id::text, market_id::text, owner_pubkey, side, order_type, price_quote_base_units::text,
                   original_base_units::text, remaining_base_units::text, reserved_asset_id::text,
                   reserved_remaining_base_units::text, status, client_order_id::text, client_signature_base58,
                   created_at, updated_at, cancelled_at`,
        [order.id],
      );
      return { ok: true as const, order: orderWire(updated.rows[0]!), released_base_units: release.toString() };
    });
    if ('error' in result) return reply.code(result.status ?? 400).send({ error: result.error, message: result.message });
    app.invalidateAccount(s.pubkey);
    return result;
  });
}
