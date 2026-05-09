import { describe, it, expect } from 'vitest';
import {
  currentRewardForBlock,
  difficultyForBlock,
  scheduleInfoForBlock,
  BASE_UNITS_PER_RPOW,
  MINT_BASE_REWARD_BASE_UNITS,
  MINT_HALVING_INTERVAL_BLOCKS,
  MINT_DIFFICULTY_START_BITS,
  MINT_DIFFICULTY_STEP_BLOCKS,
  MINT_DIFFICULTY_MAX_BITS,
  MINT_MAX_SUPPLY_RPOW,
} from '../src/schedule.js';

const HALVING = BigInt(MINT_HALVING_INTERVAL_BLOCKS);

describe('RPOW4 block-based schedule (production defaults)', () => {
  it('initial reward is 50 RPOW = 50e9 base units', () => {
    expect(MINT_BASE_REWARD_BASE_UNITS).toBe(50_000_000_000n);
    expect(MINT_BASE_REWARD_BASE_UNITS).toBe(50n * BASE_UNITS_PER_RPOW);
    expect(currentRewardForBlock(0n)).toBe(50_000_000_000n);
    expect(currentRewardForBlock(HALVING - 1n)).toBe(50_000_000_000n);
  });

  it('halves at every 210,000-block boundary', () => {
    expect(currentRewardForBlock(HALVING)).toBe(25_000_000_000n);
    expect(currentRewardForBlock(2n * HALVING)).toBe(12_500_000_000n);
    expect(currentRewardForBlock(3n * HALVING)).toBe(6_250_000_000n);
    expect(currentRewardForBlock(10n * HALVING)).toBe(48_828_125n);
  });

  it('reward floors to 0 once integer-halving collapses below 1 base unit', () => {
    // 50e9 = 5e9 * 2^4 * ... actually integer-halving 36 times: 50e9 / 2^36 ≈ 0.73 → 0
    expect(currentRewardForBlock(36n * HALVING)).toBe(0n);
    expect(currentRewardForBlock(100n * HALVING)).toBe(0n);
  });

  it('21M cap is the geometric sum of 50 RPOW * 210,000 blocks * 2', () => {
    // The actual integer-summed total is slightly less than 21M because
    // each halving floors. Sanity-check: the budget is bounded, never
    // exceeds the 21M cap.
    let total = 0n;
    for (let h = 0n; h < 40n; h++) {
      total += currentRewardForBlock(h * HALVING) * HALVING;
    }
    expect(total).toBeLessThanOrEqual(BigInt(MINT_MAX_SUPPLY_RPOW) * BASE_UNITS_PER_RPOW);
    // And within 1 RPOW of the cap (the floor losses are tiny).
    expect(total).toBeGreaterThan(BigInt(MINT_MAX_SUPPLY_RPOW) * BASE_UNITS_PER_RPOW - BASE_UNITS_PER_RPOW);
  });
});

describe('RPOW4 difficulty schedule', () => {
  const STEP = BigInt(MINT_DIFFICULTY_STEP_BLOCKS);

  it('starts at 24 bits and steps up +1 every 164,062 blocks', () => {
    expect(MINT_DIFFICULTY_START_BITS).toBe(24);
    expect(MINT_DIFFICULTY_STEP_BLOCKS).toBe(164_062);
    expect(difficultyForBlock(0n)).toBe(24);
    expect(difficultyForBlock(STEP - 1n)).toBe(24);
    expect(difficultyForBlock(STEP)).toBe(25);
    expect(difficultyForBlock(2n * STEP)).toBe(26);
    expect(difficultyForBlock(10n * STEP)).toBe(34);
  });

  it('hard-caps difficulty at MINT_DIFFICULTY_MAX_BITS', () => {
    expect(MINT_DIFFICULTY_MAX_BITS).toBe(50);
    // Far past the natural ceiling.
    expect(difficultyForBlock(1000n * STEP)).toBe(MINT_DIFFICULTY_MAX_BITS);
    expect(difficultyForBlock(BigInt(Number.MAX_SAFE_INTEGER))).toBe(MINT_DIFFICULTY_MAX_BITS);
  });

  it('honors per-call overrides', () => {
    expect(difficultyForBlock(0n, { difficultyStartBits: 10 })).toBe(10);
    expect(difficultyForBlock(50n, { difficultyStartBits: 10, difficultyStepBlocks: 10 })).toBe(15);
    expect(
      difficultyForBlock(1000n, { difficultyStartBits: 10, difficultyStepBlocks: 10, difficultyMaxBits: 12 }),
    ).toBe(12);
  });
});

describe('scheduleInfoForBlock', () => {
  const HALVE = BigInt(MINT_HALVING_INTERVAL_BLOCKS);
  const STEP = BigInt(MINT_DIFFICULTY_STEP_BLOCKS);
  const MAX_SUPPLY_BU = BigInt(MINT_MAX_SUPPLY_RPOW) * BASE_UNITS_PER_RPOW;

  it('at block 0', () => {
    const s = scheduleInfoForBlock(0n, 0n);
    expect(s).toEqual({
      blockHeight: 0n,
      currentRewardBaseUnits: 50_000_000_000n,
      currentDifficultyBits: 24,
      halvingIndex: 0,
      difficultyTier: 0,
      nextHalvingAtBlock: HALVE,
      nextDifficultyAtBlock: STEP,
      blocksToNextHalving: HALVE,
      blocksToNextDifficultyStep: STEP,
      nextRewardBaseUnits: 25_000_000_000n,
      nextDifficultyBits: 25,
      isCapped: false,
      isMintable: true,
    });
  });

  it('mid-phase 1', () => {
    const s = scheduleInfoForBlock(HALVE + 1234n, BASE_UNITS_PER_RPOW);
    expect(s.halvingIndex).toBe(1);
    expect(s.currentRewardBaseUnits).toBe(25_000_000_000n);
    expect(s.nextRewardBaseUnits).toBe(12_500_000_000n);
    expect(s.nextHalvingAtBlock).toBe(2n * HALVE);
    expect(s.blocksToNextHalving).toBe(HALVE - 1234n);
    expect(s.isMintable).toBe(true);
  });

  it('flags is_capped when minted reaches max supply', () => {
    const s = scheduleInfoForBlock(0n, MAX_SUPPLY_BU);
    expect(s.isCapped).toBe(true);
    expect(s.isMintable).toBe(false);
  });

  it('next_difficulty_bits saturates at the hard cap', () => {
    const s = scheduleInfoForBlock(1000n * STEP, 0n);
    expect(s.currentDifficultyBits).toBe(MINT_DIFFICULTY_MAX_BITS);
    expect(s.nextDifficultyBits).toBe(MINT_DIFFICULTY_MAX_BITS);
  });
});
