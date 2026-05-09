# 03 · Mining, Halving, Supply Cap

Mining is hashcash over:

```text
SHA256(nonce_prefix || u64le(solution_nonce))
```

The hash must have at least `difficulty_bits` trailing zero bits.

## Stateless Challenges

`/challenge` returns a HMAC-protected challenge envelope and does not write a
database row. `/mint` verifies the challenge MAC and expiry before checking the
proof. Replay/double-claim protection comes from the unique mint
`ledger_events.challenge_id` index, with `ledger_mint_claims` providing
the global uniqueness across the partitioned event log.

## RPOW4 issuance schedule (block-based, Bitcoin-flavored)

1 successful PoW = 1 "block". The schedule is a pure function of the
monotonic `block_height` counter in `app_counters`.

Internal amounts are BIGINT base units:

```ts
BASE_UNITS_PER_RPOW           = 1_000_000_000n
MINT_BASE_REWARD_BASE_UNITS   = 50_000_000_000n  // 50 RPOW
MINT_HALVING_INTERVAL_BLOCKS  = 210_000
MINT_DIFFICULTY_START_BITS    = 24
MINT_DIFFICULTY_STEP_BLOCKS   = 164_062            // ≈ 21M / 128
MINT_DIFFICULTY_MAX_BITS      = 50
MINT_MAX_SUPPLY_RPOW          = 21_000_000
```

| Block range                | Reward (RPOW) | Difficulty (bits) |
|----------------------------|---------------|-------------------|
| 0 .. 164,061               | 50            | 24                |
| 164,062 .. 210,000-1        | 50            | 25                |
| 210,000 .. 328,124          | 25            | 25                |
| 328,125 .. 420,000-1        | 25            | 26                |
| ... (halvings every 210k, +1 bit every 164,062, capped at 50) |        |        |
| ≥ ~36 × 210,000             | 0 (floors)    | 50 (capped)       |

The geometric sum of `50 × 210,000 × (1 + 1/2 + 1/4 + …)` is exactly
**21,000,000 RPOW**, so the cap closes naturally. The hard cap in
`app_counters.minted_supply` is enforced by `/mint` regardless,
catching any off-by-floor edge cases.

## Cap & block-height enforcement

`/mint` increments `minted_supply` AND `block_height` atomically, gated
on the cap, in a single statement under the mint advisory lock:

```sql
UPDATE app_counters
   SET value = value + (CASE
     WHEN name = 'minted_supply' THEN $reward::bigint
     ELSE 1::bigint
   END)
 WHERE name IN ('minted_supply','block_height')
   AND (SELECT value FROM app_counters WHERE name='minted_supply') + $reward::bigint <= $cap::bigint
```

If `rowCount != 2` (cap exceeded), neither counter advances and the
request returns `SUPPLY_EXHAUSTED`. The same statement enforces that
`block_height` only ever moves on a successfully issued event.

## Difficulty matching

The challenge envelope's `difficulty_bits` is computed from a slightly
stale `block_height` snapshot (5 s cache in `/challenge`). At `/mint`
time the route reads the *current* counter under the lock and compares
against the stamped value — if the schedule advanced underneath the
client, the route returns `CHALLENGE_EXPIRED` and the client refetches
a current challenge instead of mining against a stale difficulty.

## Maintained Stats

`/ledger` reports minted supply, block height, and the schedule's
current/next reward + difficulty from `app_counters` and `ledger_stats`,
so public stats do not require `SUM()` scans over historical event rows.
The ETag-cached response (5 s + stale-while-revalidate=30) is
invalidated by every successful `/mint` and `/send`.
