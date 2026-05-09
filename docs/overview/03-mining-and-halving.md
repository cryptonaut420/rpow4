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
`ledger_events.challenge_id` index.

## Reward Schedule

Internal amounts are BIGINT base units:

```ts
BASE_UNITS_PER_RPOW = 1_000_000_000n
MINT_BASE_REWARD_BASE_UNITS = 7_812_500n // 1/128 RPOW
MINT_HALVING_INTERVAL_RPOW = 1_000_000
MINT_MAX_SUPPLY_RPOW = 21_000_000
```

Reward halves every 1,000,000 RPOW minted. Difficulty is configured by env and
currently fixed by policy; the schedule changes issuance amount, not difficulty.

## Cap Enforcement

`app_counters.minted_supply` is the authoritative cap counter. `/mint` updates
it with a conditional statement under the mint advisory lock:

```sql
UPDATE app_counters
   SET value = value + $reward::bigint
 WHERE name='minted_supply'
   AND value + $reward::bigint <= $cap::bigint
```

If no row updates, the request returns `SUPPLY_EXHAUSTED`.

## Maintained Stats

`/ledger` reports minted supply from `app_counters` and transferred/circulating
totals from `ledger_stats`, so public stats do not require `SUM()` scans over
historical event rows.
