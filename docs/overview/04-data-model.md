# 04 · Data Model

The hot ledger model is balance-row based. Historical `tokens` and `transfers` tables remain for migration/backfill compatibility, but request paths use maintained current-state tables plus append-only events.

## Hot Tables

### `account_balances`

One row per account stores spendable, minted, sent, and received totals in BIGINT base units. `/me` is a primary-key lookup. `/send` uses a conditional debit so arbitrary base-unit amounts work without scanning token rows.

### `ledger_events`

Append-only public/audit history with `MINT` and `TRANSFER` rows. Indexes support public pagination, account activity, unique accepted `challenge_id`, and transfer idempotency.

### `ledger_stats` and `app_counters`

`app_counters.minted_supply` remains the authoritative cap counter. `ledger_stats` stores maintained totals such as `total_transferred`, `circulating_supply`, and `user_count`. `/ledger` reads these small tables instead of aggregating history.

## Mining Challenges

Mining challenges are stateless HMAC envelopes. `/challenge` does not write a database row; `/mint` verifies the challenge MAC, proof of work, client signature, cap counter, and unique event before crediting the miner.

## Legacy Tables

`tokens`, `transfers`, and `challenges` may still exist from earlier migrations. Migration `013_scalable_ledger.sql` backfills `account_balances`, `ledger_events`, and `ledger_stats` from legacy rows, then live routes stop depending on token scans or exact-sum token selection. Bridge-only state is removed from the active schema.
