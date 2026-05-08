# 04 · Data Model

The Postgres schema is defined entirely by the ordered SQL files in
[`apps/server/migrations/`](../../apps/server/migrations) and applied
idempotently by [`db.runMigrations`](../../apps/server/src/db.ts) on every
boot. Each filename is recorded in `schema_migrations(filename PK)`.

## Tables

### `users`

```sql
users(
  email          TEXT PRIMARY KEY,        -- lowercased on insert
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ,
  solana_wallet  TEXT UNIQUE              -- added in 007; nullable; 1:1 binding
)
```

`UPSERT` on every successful magic-link verify and on every claim. Rows are
never deleted by the app (only manually, e.g. for test resets — see the
RUNBOOK).

### `magic_links`

```sql
magic_links(
  id            UUID PRIMARY KEY,
  email         TEXT NOT NULL,
  token_hash    BYTEA NOT NULL,           -- sha256(token)
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_addr       INET                      -- added in 002; for per-IP rate limit
)
CREATE INDEX magic_links_email_idx ON magic_links(email);
CREATE INDEX magic_links_ip_idx ON magic_links(ip_addr, created_at);
CREATE INDEX magic_links_email_created_idx ON magic_links(email, created_at);
CREATE UNIQUE INDEX magic_links_token_hash_idx ON magic_links(token_hash);   -- 003
```

Tokens themselves are never stored — only their SHA-256 hashes. Rows are
single-use (`used_at` stamped on consume), with a 15-minute TTL enforced by
the predicate `expires_at > now()`. Old rows linger in the table but never
match the lookup again.

### `challenges`

```sql
challenges(
  id              UUID PRIMARY KEY,
  user_email      TEXT NOT NULL,
  nonce_prefix    BYTEA NOT NULL,          -- 16 random bytes
  difficulty_bits INT  NOT NULL,           -- stamped at issuance, used by /mint
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,    -- now + 5min
  claimed_at      TIMESTAMPTZ              -- set by successful /mint
)
```

A successful mint locks the row via `SELECT … FOR UPDATE` and stamps
`claimed_at`. Replays on a claimed challenge are rejected.

### `tokens`

The ledger row. One per RPOW unit; values are BIGINT base units after
migration `008` (10⁹ base units = 1 RPOW).

```sql
tokens(
  id              UUID PRIMARY KEY,
  owner_email     TEXT NOT NULL,
  value           BIGINT NOT NULL DEFAULT 1,    -- widened to BIGINT in 008
  state           TEXT NOT NULL CHECK (state IN
                    ('VALID','INVALIDATED','LOCKED_FOR_BRIDGE','WRAPPED')),  -- expanded in 007
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  invalidated_at  TIMESTAMPTZ,
  parent_token_id UUID REFERENCES tokens(id),    -- chain back to mint event
  server_sig      BYTEA NOT NULL,                -- ed25519 over canonical JSON payload
  wrap_event_id   UUID REFERENCES srpow_wrap_events(id)   -- added in 007
)
CREATE INDEX tokens_owner_state_idx ON tokens(owner_email, state);
CREATE INDEX tokens_wrap_event_idx ON tokens(wrap_event_id) WHERE wrap_event_id IS NOT NULL;
```

State machine (graph in [`05-srpow-bridge.md`](./05-srpow-bridge.md), text below):

- `VALID` — spendable. Returned by selectors with `WHERE state='VALID'`.
- `INVALIDATED` — terminal, audit-only. Set by `/send` when the row is
  reissued (or burned to fund a pending claim).
- `LOCKED_FOR_BRIDGE` — transient. Set by Phase 1 of `/srpow/wrap`. Carries
  `wrap_event_id` so a refund or confirmation can find the right rows.
- `WRAPPED` — terminal-on-rpow. The matching SRPOW supply lives on Solana.
  Counted by `/me`'s `srpow_supply_owned_base_units`.

`tokens` is mutated in place rather than appended: a row is born `VALID`
and may transition to either `INVALIDATED` (burn) or `WRAPPED` (bridge) for
its lifetime. Rows are not deleted.

The signed payload is canonical-JSON over `{id, owner_email_hash, value,
issued_at}` where `owner_email_hash = sha256(owner_email)`. Bigints are
serialized as strings during signing. See
[`signing.ts`](../../apps/server/src/signing.ts).

### `transfers`

```sql
transfers(
  id              UUID PRIMARY KEY,
  sender_email    TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  amount          BIGINT NOT NULL,                  -- widened to BIGINT in 009
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

A transfer to an existing user is a single `transfers` insert plus N pairs
of `tokens` invalidate-and-reissue. The unique constraint on
`idempotency_key` is the formal idempotency anchor; route handlers also
catch the resulting Postgres error code 23505 to return the existing
result.

### `pending_transfers`

```sql
pending_transfers(
  id                UUID PRIMARY KEY,
  sender_email      TEXT NOT NULL,
  recipient_email   TEXT NOT NULL,
  amount            BIGINT NOT NULL CHECK (amount > 0),  -- widened in 009
  idempotency_key   TEXT NOT NULL UNIQUE,
  claim_token_hash  BYTEA NOT NULL,                       -- sha256(claim_token)
  expires_at        TIMESTAMPTZ NOT NULL,                 -- now + 30 days
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at        TIMESTAMPTZ
)
CREATE UNIQUE INDEX pending_transfers_claim_token_hash_idx ON pending_transfers(claim_token_hash);
CREATE INDEX pending_transfers_recipient_idx ON pending_transfers(recipient_email, claimed_at);
CREATE INDEX pending_transfers_sender_idx ON pending_transfers(sender_email, claimed_at);
```

A pending claim is created when `/send` targets a non-user — the sender's
tokens are already invalidated, so the row carries the value debt until
the recipient clicks the email link or the row expires (30d).

### `app_counters`

```sql
app_counters(
  name   TEXT PRIMARY KEY,
  value  BIGINT NOT NULL                    -- widened to BIGINT in 008
)
INSERT 'minted_supply' = count of root tokens at the time migration 005 ran
```

Today only `name='minted_supply'` exists; the table is generic on purpose.
Bumped by `/mint` (atomic conditional `UPDATE`) and `/claim` (additive). See
[`03-mining-and-halving.md`](./03-mining-and-halving.md) for the cap math.

### `email_unsubscribes`

```sql
email_unsubscribes(
  email      TEXT PRIMARY KEY,
  scope      TEXT NOT NULL DEFAULT 'all',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

Populated by `/unsubscribe` (RFC 8058 one-click POST or human GET). Honored
by the `/send` path: a send to an unsubscribed non-user fails with
`RECIPIENT_UNSUBSCRIBED` *before* the sender's tokens are touched.
Magic-link sign-in emails are still sent — only token-claim emails respect
the unsubscribe.

### `srpow_wrap_events`

```sql
srpow_wrap_events(
  id                UUID PRIMARY KEY,
  user_email        TEXT NOT NULL,
  solana_wallet     TEXT NOT NULL,
  amount            BIGINT NOT NULL CHECK (amount > 0),     -- widened in 010
  direction         TEXT NOT NULL CHECK (direction IN ('WRAP','UNWRAP')),
  status            TEXT NOT NULL CHECK (status IN ('PENDING','CONFIRMED','FAILED','REFUNDED')),
  idempotency_key   TEXT NOT NULL UNIQUE,
  solana_signature  TEXT,                  -- persisted BEFORE submit (crash-recovery anchor)
  failure_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
)
CREATE INDEX srpow_wrap_events_user_idx    ON srpow_wrap_events(user_email);
CREATE INDEX srpow_wrap_events_pending_idx ON srpow_wrap_events(status) WHERE status='PENDING';
```

Status state machine: `PENDING → CONFIRMED | REFUNDED | FAILED`. (`UNWRAP`
direction is reserved for future work — not implemented in v1.)

### `phantom_challenges`

```sql
phantom_challenges(
  nonce       UUID PRIMARY KEY,            -- the challenge value the user signs
  user_email  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,        -- now + 5 min
  used_at     TIMESTAMPTZ
)
CREATE INDEX phantom_challenges_user_idx ON phantom_challenges(user_email);
```

Issued by `POST /phantom/challenge`. The user signs the literal UTF-8
string `rpow2.com bind: ${nonce}` with their Phantom wallet, then `POST
/phantom/bind` verifies the ed25519 signature, marks the nonce
`used_at=now()`, and writes `users.solana_wallet`.

### `schema_migrations`

```sql
schema_migrations(
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

The migration runner inserts here in the same transaction as the SQL file's
contents.

## Migration history

| File | Purpose |
|---|---|
| `001_init.sql` | Initial schema: `users`, `magic_links`, `challenges`, `tokens`, `transfers`, `schema_migrations` |
| `002_magic_link_ip.sql` | `magic_links.ip_addr` + indexes for per-IP cooldown |
| `003_magic_link_token_hash_idx.sql` | UNIQUE index on `magic_links.token_hash` |
| `004_pending_transfers.sql` | Email-keyed pending claims |
| `005_minted_supply_counter.sql` | `app_counters` to replace `count(*)` on hot path |
| `006_email_unsubscribes.sql` | RFC 8058 unsubscribes |
| `007_srpow_wrap.sql` | `tokens.state` expansion, `users.solana_wallet`, `srpow_wrap_events`, `phantom_challenges`, `tokens.wrap_event_id` |
| `008_base_units.sql` | Widen `tokens.value` and `app_counters.value` to BIGINT, multiply by 10⁹ (rollover from integer RPOW to base units) |
| `009_pending_transfers_base_units.sql` | Same for `pending_transfers.amount` and `transfers.amount` |
| `010_srpow_wrap_events_base_units.sql` | Same for `srpow_wrap_events.amount` |

## Hot-path query characteristics

A few queries deserve callouts because they show up in bench traces:

- `/challenge` and `/ledger` cache `app_counters.minted_supply` for 5s with
  single-flight de-dup; without that the count was the dominant cost on
  request bursts.
- `/mint` runs entirely inside one `withTx`, holding
  `pg_advisory_xact_lock(hashtext('rpow_mint_supply'))` for the duration
  of the transaction (sub-millisecond reads + atomic conditional update +
  insert). Migration 005's counter pattern keeps that lock window tiny.
- `/send` and `/srpow/wrap` greedy-pick using
  `ORDER BY value DESC, id ASC FOR UPDATE SKIP LOCKED` so concurrent
  spenders don't fight over the same rows.
- After the Fly→VPS migration the `/mint` p50 went from ~84,000 ms to
  ~57 ms. Local Unix-socket Postgres is the dominant factor.

## Reset / debug

Per the runbook, "reset a user" is a four-table delete:

```sql
DELETE FROM tokens WHERE owner_email='X';
DELETE FROM transfers WHERE sender_email='X' OR recipient_email='X';
DELETE FROM pending_transfers WHERE sender_email='X' OR recipient_email='X';
DELETE FROM users WHERE email='X';
```

There's no analogous flow for SRPOW: wrapped rpow rows persist as
`WRAPPED`, and the on-chain SRPOW lives in the user's wallet
independently.
