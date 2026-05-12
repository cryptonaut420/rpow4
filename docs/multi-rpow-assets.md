# Multi-RPOW Assets Runbook

RPOW4.0 remains the system default asset. Custom user-created assets are stored in the `assets` table and use the same centralized ledger with an `asset_id` dimension on balances, counters, ledger feeds, recent activity, claims, faucet/trollbox state, and pool mining tables.

## Launch Economics

Launching a custom asset requires an authenticated session and burns `10,000 RPOW4` from the creator's RPOW4.0 balance. The burn is recorded as a `BURN` ledger event on RPOW4.0, increments the `burned_supply` counter, and reduces RPOW4.0 circulating supply. Historical `minted_supply` is not reduced.

Founder allocation is only allowed on capped assets. The requested allocation is the total genesis amount, split 90% to the creator and 10% to the treasury.

## Routing

Existing routes remain RPOW4.0-compatible. Asset-specific routes are available under:

- `GET /assets`
- `GET /assets/:slug`
- `POST /assets`
- `/assets/:slug/challenge`
- `/assets/:slug/mint`
- `/assets/:slug/send`
- `/assets/:slug/me`
- `/assets/:slug/activity`
- `/assets/:slug/ledger`
- `/assets/:slug/explorer/...`
- `/assets/:slug/stats/leaderboard`
- `/assets/:slug/pool/...`

The web app uses hash routes such as `/#/r/:assetSlug/send` for shareable custom-asset pages. RPOW4.0 keeps the legacy URLs.

## Guardrails

Every balance, counter, ledger, activity, and pool query should include `asset_id`. Challenge MAC envelopes and client-signed mining, pool-share, and transfer payloads include asset identity on asset-scoped routes to prevent cross-asset replay.

Faucet and trollbox remain RPOW4.0-only in the UI and backend compatibility paths.
