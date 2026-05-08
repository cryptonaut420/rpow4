# 03 · Mining, Difficulty, Halving, Supply Cap

## Hashcash construction

A challenge is `(challenge_id, nonce_prefix: 16 random bytes, difficulty_bits)`.
Mining means finding any 64-bit `solution_nonce` such that:

```
H = SHA-256( nonce_prefix ‖ u64_LE(solution_nonce) )
trailing_zero_bits(H) ≥ difficulty_bits
```

Both server and worker use the same `trailingZeroBits` helper from
[`packages/shared/src/difficulty.ts`](../../packages/shared/src/difficulty.ts)
— it scans the digest from byte 31 backwards counting zero bits:

```ts
export function trailingZeroBits(buf: Uint8Array): number {
  let count = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    const b = buf[i]!;
    if (b === 0) { count += 8; continue; }
    let bit = 0;
    while ((b & (1 << bit)) === 0) bit++;
    return count + bit;
  }
  return count;
}
```

Server-side verification ([`pow.ts`](../../apps/server/src/pow.ts)) is two
lines: rebuild the 24-byte input, hash, count bits.

## Web Worker miner

[`apps/web/src/miner.worker.ts`](../../apps/web/src/miner.worker.ts) loads
`hash-wasm`'s `createSHA256` (WASM-accelerated) and runs a tight loop:

```ts
while (!aborted) {
  // write nonce as little-endian u64 into the trailing 8 bytes of buf
  for (let i = 0; i < 8; i++) { buf[prefix.length + i] = Number(x & 0xffn); x >>= 8n; }
  sha.init(); sha.update(buf);
  const digest = sha.digest('binary');
  if (trailingZeroBits(digest) >= target) postMessage({ type: 'found', solution_nonce, hashes });
  nonce++;
  if ((count & 0xffff) === 0n) // throttled progress messages every ~250ms
}
```

The worker posts `{type: 'progress', hashes, elapsed_ms}` to the UI roughly
4×/sec so the Mine page renders the live MH/s counter, and `{type: 'found',
solution_nonce, hashes}` when a solution lands. The page submits
`/mint`, then loops back to `/challenge` automatically until the user hits
STOP. See [`apps/web/src/pages/Mine.tsx`](../../apps/web/src/pages/Mine.tsx).

A modern laptop hits 24 trailing-zero bits in ~30 s on average.

## Difficulty selection

In [`routes/challenge.ts`](../../apps/server/src/routes/challenge.ts):

```ts
const scheduledBits = difficultyBitsForSupply(minted, {
  difficultyBits: app.config.difficultyBits,    // env DIFFICULTY_BITS, default 28
  maxSupplyRpow: app.config.mintMaxSupply,
});
const difficulty = Math.max(app.config.difficultyFloor, scheduledBits);
```

In the **halving model** ([`schedule.ts`](../../apps/server/src/schedule.ts)),
`difficultyBitsForSupply` is constant at `MINT_DIFFICULTY_BITS_DEFAULT = 24`
regardless of supply — the schedule changes the *reward*, not the
difficulty. The `DIFFICULTY_FLOOR` env (default 20) is a backstop that lets
ops temporarily raise difficulty without touching code.

So in practice, on a normal production day:

- Difficulty stamped on every challenge: **24** trailing-zero bits.
- Override path: `DIFFICULTY_BITS=30` in the env file → `max(20, 24) → 30`
  effective.
- If the schedule were ever to call for a bump, the floor wouldn't lower it.

The challenge row records `difficulty_bits` on creation and `/mint`
verifies against that exact value — even if the schedule changes mid-mine,
the user's work is honored.

> **Doc drift note.** The pre-launch spec
> [`2026-05-07-difficulty-schedule-design.md`](../superpowers/specs/2026-05-07-difficulty-schedule-design.md)
> describes a stepped +1-bit-per-million model. That design was superseded
> by halving issuance during the SRPOW rollout
> ([`2026-05-08-srpow-wrap-design.md`](../superpowers/specs/2026-05-08-srpow-wrap-design.md)).
> The Ledger UI About panel still mentions "stepped difficulty adjustment"
> in one paragraph — that line is outdated; `schedule.ts` is the source of
> truth.

## Halving issuance

Constants ([`schedule.ts`](../../apps/server/src/schedule.ts)):

```ts
MINT_DIFFICULTY_BITS_DEFAULT = 24;
BASE_UNITS_PER_RPOW          = 1_000_000_000n;        // 9 decimals — matches SRPOW
MINT_BASE_REWARD_BASE_UNITS  =     7_812_500n;        // = 10^9 / 128 = 1/128 RPOW
MINT_HALVING_INTERVAL_RPOW   = 1_000_000;             // halve every 1M RPOW minted
MINT_MAX_SUPPLY_RPOW         = 21_000_000;            // hard cap (env-overridable, currently 19_900_000 in prod)
```

The reward at any point is determined by how many full halving intervals
have been crossed:

```ts
function currentRewardBaseUnits(minted_base_units): bigint {
  const halvings = minted_base_units / (1_000_000n * 10n**9n);   // integer divide
  let reward = 7_812_500n;
  for (let i = 0n; i < halvings; i++) reward = reward / 2n;
  return reward;     // 0 once reward floors out below 1 base unit
}
```

So:

| Halving index | Cumulative supply at start | Reward per solution |
|---:|---:|---:|
| 0 | 0 RPOW | 1/128 RPOW = 7,812,500 base units |
| 1 | 1,000,000 RPOW | 1/256 RPOW = 3,906,250 base units |
| 2 | 2,000,000 RPOW | 1/512 RPOW = 1,953,125 base units |
| … | … | … |
| 22 | 22,000,000 RPOW (unreachable, capped at 21M) | 0 (reward floored) |

The schedule terminates either at the hard cap or when the reward in base
units drops below 1, whichever comes first. With the current parameters
the cap terminates first.

The `/ledger` response surfaces the current and next reward, and the
"distance to next halving" so the Mine page can render a forward-looking
context line:

```
CURRENT REWARD   : 0.0078125 RPOW (1/128) per solution
CURRENT DIFFICULTY: 24 trailing zero bits
NEXT HALVING AT  : 1000000 RPOW total minted (954321.2345 RPOW to go)
NEXT REWARD      : 0.00390625 RPOW (1/256)
```

## Supply cap and counter

Two supply numbers exist:

1. **`SELECT sum(value) FROM tokens WHERE parent_token_id IS NULL`** — the
   post-hoc count of tokens that aren't reissuance children. Used by
   `/me`'s `minted_base_units` and `/ledger`'s `total_minted_base_units`.
2. **`app_counters.minted_supply`** — a maintained counter row, the
   authoritative cap-enforcement number. Bumped only by `/mint` (atomic
   conditional update under advisory lock) and by `/claim` (additive when a
   pending transfer to a non-user is redeemed and a new root token is
   minted into the recipient's wallet).

Migration `005` introduced the counter so `/mint` doesn't have to scan a
half-million-row tokens table on every request:

```sql
INSERT INTO app_counters (name, value)
SELECT 'minted_supply', count(*) FROM tokens WHERE parent_token_id IS NULL
ON CONFLICT (name) DO NOTHING;
```

Migration `008` widened the counter and `tokens.value` to BIGINT and
multiplied existing values by 10⁹ — the rollover from "integer RPOW" to
"base units" (so SRPOW-fractional rewards are representable end to end).
Migrations `009` and `010` did the same widening for `transfers.amount`,
`pending_transfers.amount`, and `srpow_wrap_events.amount`.

The cap is enforced atomically inside the `/mint` transaction:

```sql
SELECT pg_advisory_xact_lock(hashtext('rpow_mint_supply'));
…
UPDATE app_counters
   SET value = value + $reward::bigint
 WHERE name='minted_supply' AND value + $reward::bigint <= $cap::bigint
-- if rowCount = 0 → SUPPLY_EXHAUSTED
```

The advisory lock serializes mints (avoids two parallel mints both winning
the conditional update at the boundary), and the conditional is the actual
guard.

## 21M invariant in the presence of SRPOW

Define:

- `R_root` = root rpow tokens (`parent_token_id IS NULL`)
- `R_valid` = state=`VALID` (spendable on rpow)
- `R_locked` = state=`LOCKED_FOR_BRIDGE` (in-flight wrap; transient ≤60s)
- `R_wrapped` = state=`WRAPPED` (1:1 against on-chain SRPOW)
- `K = 1,100,000` = the satoshi allocation, minted once at launch and vested
  via Streamflow.
- `S` = on-chain SRPOW supply (sum of all token-account balances ÷ 10⁹).

The cap counter is set to `MINT_MAX_SUPPLY = 19,900,000` (= 21,000,000 − K).
Wrap is a state change only — it doesn't touch `app_counters.minted_supply`.
Therefore:

```
user-visible RPOW supply
 = R_valid + S
 = R_valid + (K + R_wrapped)              // SRPOW only minted as launch K + wrap-phase-2
 ≤ R_root + K
 ≤ minted_supply + K
 ≤ 19,900,000 + 1,100,000
 = 21,000,000
```

Proof sketch is given in
[`docs/superpowers/specs/2026-05-08-srpow-wrap-design.md`](../superpowers/specs/2026-05-08-srpow-wrap-design.md).
The transient `R_locked` rows aren't user-visible: they resolve to
`VALID` (refund) or `WRAPPED` (success) within the wrap timeout (60s
default) or by the boot-time reconciler.

## Tunable knobs (env)

| Var | Default | Effect |
|---|---|---|
| `DIFFICULTY_BITS` | 28 | Maximum of (this, schedule) is the floor for stamped difficulty before the floor backstop. With the halving model, schedule is fixed at 24, so this only matters if it's > 24. |
| `DIFFICULTY_FLOOR` | 20 | Hard lower bound: `max(floor, scheduled)`. |
| `MINT_MAX_SUPPLY` | 21_000_000 | Cap counter ceiling, in whole RPOW. Production sets 19_900_000 to make room for the satoshi allocation. |

Source-of-truth: [`apps/server/src/env.ts`](../../apps/server/src/env.ts).
