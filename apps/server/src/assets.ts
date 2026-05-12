import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { TtlCache } from './cache.js';
import {
  BASE_UNITS_PER_RPOW,
  type ScheduleOpts,
} from './schedule.js';

export const DEFAULT_ASSET_ID = '00000000-0000-4000-8000-000000000000';
export const DEFAULT_ASSET_SLUG = 'rpow4-0';
export const DEFAULT_ASSET_CODE = 'RPOW4.0';
export const LAUNCH_BURN_BASE_UNITS = 10_000n * BASE_UNITS_PER_RPOW;

/**
 * Asset rows are tiny + change rarely (only on launch + on admin status
 * flips), but we resolve them on every authed request. A short TTL cache
 * keeps the hot path off Postgres without a write-through invalidation
 * dance — 10s is short enough that pausing/archiving an asset is felt
 * almost immediately, and long enough that thousands of /me calls reuse
 * the same row.
 */
const ASSET_CACHE_TTL_MS = 10_000;
const assetCache = new TtlCache<string, AssetContext | null>({
  ttlMs: ASSET_CACHE_TTL_MS,
  maxSize: 1024,
});

/** Drop the cached entry after a launch / status change so callers see fresh data. */
export function invalidateAssetCache(slug?: string) {
  if (!slug) {
    assetCache.clear();
    return;
  }
  assetCache.invalidate(slug);
}

export interface AssetRow {
  id: string;
  family_code: string;
  sequence_number: number;
  display_code: string;
  slug: string;
  nickname: string;
  description: string;
  creator_pubkey: string | null;
  status: 'active' | 'paused' | 'archived';
  system_default: boolean;
  supply_mode: 'capped' | 'unlimited';
  max_supply_base_units: string | null;
  base_units_per_coin: string;
  initial_reward_base_units: string;
  reward_schedule_type: 'none' | 'halving_by_blocks' | 'percent_by_blocks' | 'fixed_by_blocks';
  reward_interval_blocks: number;
  reward_reduction_type: 'none' | 'percent' | 'fixed';
  reward_reduction_value: string;
  difficulty_schedule_type: 'linear_by_blocks';
  difficulty_start_bits: number;
  difficulty_step_blocks: number;
  difficulty_max_bits: number;
  mining_algo: 'rpow_classic';
  pool_enabled: boolean;
  pool_enable_at_difficulty_bits: number | null;
  pool_fee_bps: number;
  pool_finder_bps: number;
  pool_share_bits: number;
  transfer_fee_base_units: string;
  founder_allocation_base_units: string;
  treasury_allocation_base_units: string;
  launch_burn_event_id: string | null;
  created_at: Date;
}

export interface AssetContext {
  id: string;
  slug: string;
  displayCode: string;
  nickname: string;
  description: string;
  creatorPubkey: string | null;
  systemDefault: boolean;
  supplyMode: 'capped' | 'unlimited';
  maxSupplyBaseUnits: bigint | null;
  initialRewardBaseUnits: bigint;
  rewardScheduleType: AssetRow['reward_schedule_type'];
  rewardIntervalBlocks: number;
  rewardReductionType: AssetRow['reward_reduction_type'];
  rewardReductionValue: bigint;
  difficultyStartBits: number;
  difficultyStepBlocks: number;
  difficultyMaxBits: number;
  miningAlgo: 'rpow_classic';
  poolEnabled: boolean;
  poolEnableAtDifficultyBits: number | null;
  poolFeeBps: number;
  poolFinderBps: number;
  poolShareBits: number;
  transferFeeBaseUnits: bigint;
  founderAllocationBaseUnits: bigint;
  treasuryAllocationBaseUnits: bigint;
  launchBurnEventId: string | null;
  createdAt: Date;
}

export function assetFromRow(row: AssetRow): AssetContext {
  return {
    id: row.id,
    slug: row.slug,
    displayCode: row.display_code,
    nickname: row.nickname,
    description: row.description,
    creatorPubkey: row.creator_pubkey,
    systemDefault: row.system_default,
    supplyMode: row.supply_mode,
    maxSupplyBaseUnits: row.max_supply_base_units === null ? null : BigInt(row.max_supply_base_units),
    initialRewardBaseUnits: BigInt(row.initial_reward_base_units),
    rewardScheduleType: row.reward_schedule_type,
    rewardIntervalBlocks: row.reward_interval_blocks,
    rewardReductionType: row.reward_reduction_type,
    rewardReductionValue: BigInt(row.reward_reduction_value),
    difficultyStartBits: row.difficulty_start_bits,
    difficultyStepBlocks: row.difficulty_step_blocks,
    difficultyMaxBits: row.difficulty_max_bits,
    miningAlgo: row.mining_algo,
    poolEnabled: row.pool_enabled,
    poolEnableAtDifficultyBits: row.pool_enable_at_difficulty_bits,
    poolFeeBps: row.pool_fee_bps,
    poolFinderBps: row.pool_finder_bps,
    poolShareBits: row.pool_share_bits,
    transferFeeBaseUnits: BigInt(row.transfer_fee_base_units),
    founderAllocationBaseUnits: BigInt(row.founder_allocation_base_units),
    treasuryAllocationBaseUnits: BigInt(row.treasury_allocation_base_units),
    launchBurnEventId: row.launch_burn_event_id,
    createdAt: row.created_at,
  };
}

export function assetToScheduleOpts(asset: AssetContext): ScheduleOpts {
  return {
    baseRewardBaseUnits: asset.initialRewardBaseUnits,
    halvingIntervalBlocks: asset.rewardIntervalBlocks,
    difficultyStartBits: asset.difficultyStartBits,
    difficultyStepBlocks: asset.difficultyStepBlocks,
    difficultyMaxBits: asset.difficultyMaxBits,
    maxSupplyBaseUnits: asset.maxSupplyBaseUnits ?? (2n ** 63n - 1n),
    rewardScheduleType: asset.rewardScheduleType,
    rewardReductionType: asset.rewardReductionType,
    rewardReductionValue: asset.rewardReductionValue,
  };
}

export function assetWire(asset: AssetContext) {
  return {
    id: asset.id,
    slug: asset.slug,
    display_code: asset.displayCode,
    nickname: asset.nickname,
    description: asset.description,
    creator_pubkey: asset.creatorPubkey ?? undefined,
    system_default: asset.systemDefault,
    supply_mode: asset.supplyMode,
    max_supply_base_units: asset.maxSupplyBaseUnits?.toString(),
    base_units_per_coin: BASE_UNITS_PER_RPOW.toString(),
    initial_reward_base_units: asset.initialRewardBaseUnits.toString(),
    reward_schedule_type: asset.rewardScheduleType,
    reward_interval_blocks: asset.rewardIntervalBlocks,
    reward_reduction_type: asset.rewardReductionType,
    reward_reduction_value: asset.rewardReductionValue.toString(),
    difficulty_schedule_type: 'linear_by_blocks',
    difficulty_start_bits: asset.difficultyStartBits,
    difficulty_step_blocks: asset.difficultyStepBlocks,
    difficulty_max_bits: asset.difficultyMaxBits,
    mining_algo: asset.miningAlgo,
    pool_enabled: asset.poolEnabled,
    pool_enable_at_difficulty_bits: asset.poolEnableAtDifficultyBits ?? undefined,
    pool_fee_bps: asset.poolFeeBps,
    pool_finder_bps: asset.poolFinderBps,
    pool_share_bits: asset.poolShareBits,
    transfer_fee_base_units: asset.transferFeeBaseUnits.toString(),
    founder_allocation_base_units: asset.founderAllocationBaseUnits.toString(),
    treasury_allocation_base_units: asset.treasuryAllocationBaseUnits.toString(),
    launch_burn_event_id: asset.launchBurnEventId ?? undefined,
    created_at: asset.createdAt.toISOString(),
  };
}

export async function loadAssetBySlug(db: Pool | PoolClient, slug: string): Promise<AssetContext | null> {
  const { rows } = await db.query<AssetRow>(
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
     WHERE slug = $1 AND status = 'active'`,
    [slug],
  );
  return rows[0] ? assetFromRow(rows[0]) : null;
}

export async function loadDefaultAsset(db: Pool | PoolClient): Promise<AssetContext> {
  const asset = await loadAssetBySlug(db, DEFAULT_ASSET_SLUG);
  if (!asset) throw new Error('default asset missing');
  return asset;
}

export function assetSlugFromRequest(req: FastifyRequest): string {
  const params = req.params as { asset_slug?: string } | undefined;
  return params?.asset_slug || DEFAULT_ASSET_SLUG;
}

export async function resolveAsset(app: FastifyInstance, req: FastifyRequest): Promise<AssetContext | null> {
  const slug = assetSlugFromRequest(req);
  return assetCache.get(slug, () => loadAssetBySlug(app.pool, slug));
}

export function poolAvailableForAsset(asset: AssetContext, currentDifficultyBits: number): boolean {
  if (!asset.poolEnabled) return false;
  if (asset.poolEnableAtDifficultyBits === null) return true;
  return currentDifficultyBits >= asset.poolEnableAtDifficultyBits;
}
