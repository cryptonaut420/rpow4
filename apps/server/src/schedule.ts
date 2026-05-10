// RPOW4 Bitcoin-style issuance schedule.
//
// Tokenomics summary:
//
//   - 1 accepted PoW solution = 1 "block" in the simulation.
//   - The reward starts at 50 RPOW per block (= 50 * 10^9 base units) and
//     halves every 210,000 blocks (Bitcoin-exact: the geometric sum
//     50 * 210,000 * 2 = 21,000,000 RPOW gives an exact 21M cap).
//   - Difficulty starts at 24 trailing-zero bits and steps up by +1 bit
//     every 50,000 blocks. The 24→50-bit ramp completes around block
//     1.3M (roughly the 6th halving), keeping mining responsive while
//     a young chain establishes its hashrate.
//   - Difficulty is hard-capped at 50 bits so the schedule stays
//     mineable on commodity hardware in the long tail.
//   - The schedule terminates either at the 21M cap or when the
//     integer-floored reward drops below 1 base unit. Either way the
//     hard 21M cap is enforced by the route layer.
//
// This file is the single source of truth for the issuance curve. The
// callers (`/mint`, `/challenge`, `/ledger`) pass per-app overrides
// (sourced from `AppConfig`) so tests and dev can shrink intervals
// without touching production constants.

export const BASE_UNITS_PER_RPOW = 1_000_000_000n;          // 9 decimals
export const MINT_BASE_REWARD_BASE_UNITS = 50_000_000_000n; // 50 RPOW
export const MINT_HALVING_INTERVAL_BLOCKS = 210_000;
export const MINT_DIFFICULTY_START_BITS = 24;
export const MINT_DIFFICULTY_STEP_BLOCKS = 50_000;
export const MINT_DIFFICULTY_MAX_BITS = 50;
export const MINT_MAX_SUPPLY_RPOW = 21_000_000;

export interface ScheduleOpts {
  baseRewardBaseUnits?: bigint;
  halvingIntervalBlocks?: number;
  difficultyStartBits?: number;
  difficultyStepBlocks?: number;
  difficultyMaxBits?: number;
  maxSupplyRpow?: number;
}

export interface ScheduleInfo {
  /** Block height at which `currentRewardBaseUnits` and `currentDifficultyBits` apply. */
  blockHeight: bigint;
  currentRewardBaseUnits: bigint;
  currentDifficultyBits: number;
  /** 0 during the first 210k blocks, then 1, 2, 3, ... */
  halvingIndex: number;
  /** 0 during the first difficulty-step block window, then 1, 2, ... */
  difficultyTier: number;
  nextHalvingAtBlock: bigint;
  nextDifficultyAtBlock: bigint;
  blocksToNextHalving: bigint;
  blocksToNextDifficultyStep: bigint;
  nextRewardBaseUnits: bigint;
  nextDifficultyBits: number;
  /** Hard cap reached (minted >= 21M). */
  isCapped: boolean;
  /** Reward > 0 AND not capped. */
  isMintable: boolean;
}

interface Resolved {
  baseRewardBaseUnits: bigint;
  halvingIntervalBlocks: bigint;
  difficultyStartBits: number;
  difficultyStepBlocks: bigint;
  difficultyMaxBits: number;
  maxSupplyBaseUnits: bigint;
}

function resolve(opts?: ScheduleOpts): Resolved {
  const baseRewardBaseUnits = opts?.baseRewardBaseUnits ?? MINT_BASE_REWARD_BASE_UNITS;
  const halvingIntervalBlocks = opts?.halvingIntervalBlocks ?? MINT_HALVING_INTERVAL_BLOCKS;
  const difficultyStartBits = opts?.difficultyStartBits ?? MINT_DIFFICULTY_START_BITS;
  const difficultyStepBlocks = opts?.difficultyStepBlocks ?? MINT_DIFFICULTY_STEP_BLOCKS;
  const difficultyMaxBits = opts?.difficultyMaxBits ?? MINT_DIFFICULTY_MAX_BITS;
  const maxSupplyRpow = opts?.maxSupplyRpow ?? MINT_MAX_SUPPLY_RPOW;

  if (halvingIntervalBlocks <= 0) throw new Error('halvingIntervalBlocks must be positive');
  if (difficultyStepBlocks <= 0) throw new Error('difficultyStepBlocks must be positive');
  if (difficultyMaxBits < difficultyStartBits) {
    throw new Error('difficultyMaxBits must be >= difficultyStartBits');
  }

  return {
    baseRewardBaseUnits,
    halvingIntervalBlocks: BigInt(halvingIntervalBlocks),
    difficultyStartBits,
    difficultyStepBlocks: BigInt(difficultyStepBlocks),
    difficultyMaxBits,
    maxSupplyBaseUnits: BigInt(maxSupplyRpow) * BASE_UNITS_PER_RPOW,
  };
}

function nonNegBlock(h: bigint): bigint {
  return h < 0n ? 0n : h;
}

/**
 * Reward (in base units) for a block mined at height `blockHeight`. The
 * very first mint is at height 0; the reward is constant within a
 * halving window and is integer-floored at each halving boundary.
 */
export function currentRewardForBlock(blockHeight: bigint, opts?: ScheduleOpts): bigint {
  const r = resolve(opts);
  const h = nonNegBlock(blockHeight);
  const halvings = h / r.halvingIntervalBlocks;
  let reward = r.baseRewardBaseUnits;
  for (let i = 0n; i < halvings; i++) {
    reward = reward / 2n;
    if (reward === 0n) return 0n;
  }
  return reward;
}

/**
 * Trailing-zero-bit difficulty at block `blockHeight`. Starts at
 * `difficultyStartBits`, +1 every `difficultyStepBlocks` blocks, capped
 * at `difficultyMaxBits` so the schedule stays mineable indefinitely.
 */
export function difficultyForBlock(blockHeight: bigint, opts?: ScheduleOpts): number {
  const r = resolve(opts);
  const h = nonNegBlock(blockHeight);
  const tiers = h / r.difficultyStepBlocks;
  const raw = r.difficultyStartBits + Number(tiers);
  return Math.min(raw, r.difficultyMaxBits);
}

export function scheduleInfoForBlock(
  blockHeight: bigint,
  mintedBaseUnits: bigint,
  opts?: ScheduleOpts,
): ScheduleInfo {
  const r = resolve(opts);
  const h = nonNegBlock(blockHeight);
  const minted = mintedBaseUnits < 0n ? 0n : mintedBaseUnits;

  const halvings = h / r.halvingIntervalBlocks;
  const halvingIndex = Number(halvings);
  const reward = currentRewardForBlock(h, opts);
  const nextReward = reward === 0n ? 0n : reward / 2n;
  const nextHalvingAtBlock = (halvings + 1n) * r.halvingIntervalBlocks;
  const blocksToNextHalving = nextHalvingAtBlock - h;

  const difficultyTiersRaw = h / r.difficultyStepBlocks;
  const currentDifficultyBits = difficultyForBlock(h, opts);
  const nextDifficultyAtBlock = (difficultyTiersRaw + 1n) * r.difficultyStepBlocks;
  const blocksToNextDifficultyStep = nextDifficultyAtBlock - h;
  // Difficulty never decreases, but past the max cap it stops climbing.
  const nextDifficultyBits = currentDifficultyBits >= r.difficultyMaxBits
    ? r.difficultyMaxBits
    : currentDifficultyBits + 1;

  const isCapped = minted >= r.maxSupplyBaseUnits;
  const isMintable = !isCapped && reward > 0n;

  return {
    blockHeight: h,
    currentRewardBaseUnits: reward,
    currentDifficultyBits,
    halvingIndex,
    difficultyTier: Number(difficultyTiersRaw),
    nextHalvingAtBlock,
    nextDifficultyAtBlock,
    blocksToNextHalving,
    blocksToNextDifficultyStep,
    nextRewardBaseUnits: nextReward,
    nextDifficultyBits,
    isCapped,
    isMintable,
  };
}

/**
 * Apply the reward-halving schedule to a base fee. Used so the network's
 * "transaction-cost" fees (per-send fee, trollbox post fee) decay at the
 * same cadence as the block reward — half at every halving, capped at 0.
 *
 * Bit-shift right by halvingIndex == floor(base / 2^halvingIndex). Caller
 * supplies an integer halvingIndex computed from block_height.
 */
export function feeAtHalving(baseFeeBaseUnits: bigint, halvingIndex: number): bigint {
  if (baseFeeBaseUnits <= 0n) return 0n;
  if (halvingIndex <= 0) return baseFeeBaseUnits;
  const shifted = baseFeeBaseUnits >> BigInt(halvingIndex);
  return shifted < 0n ? 0n : shifted;
}
