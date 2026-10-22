# TSQR runtime upgrade — October 2026

TSQR uses `compose.tsqr.yaml`, the shared external `tsqr-network` and its existing
TLS proxy. Do not run the standalone deploy script here: it starts another proxy.
Existing `prod.env` remains private and must be preserved, especially issuer and
session keys. Compose reads it with `--env-file ops/aws-ec2/prod.env`.

Runtime targets: Node 26.12.1, PostgreSQL 18.6, Nginx 1.31.8; dependency versions
are pinned by package-lock.json. React is deduplicated across workspaces so the
browser and router share one runtime. Dev and production images use the same
Node release. Tests use at most two backend workers and isolated schemas.

## PostgreSQL migration (required before starting the new stack)

PostgreSQL 18 cannot open a version-17 data directory. The new `pg18-data` volume
mounts `/var/lib/postgresql`; the old `pg-data` volume is deliberately untouched.
This applies to local and standalone stacks as well as TSQR. Never use `down -v`.

1. Build the server/web images while the current stack is running.
2. Test a logical dump restore on PostgreSQL 18 in an isolated environment.
3. Stop API writers, including pollers, then take a fresh custom-format dump.
4. Record exact row counts and ledger/balance aggregates on the stopped source.
5. Retain the old database container and volume; start PostgreSQL 18 with the new
   volume, restore the fresh dump, then compare every recorded count/aggregate.
6. Start the updated API/web only after parity checks pass. Check readiness,
   public statistics, browser wallet screens and API errors without issuing
   production transactions.
7. Retain the old volume and final dump. Before any new writes, rollback can
   restore the old database and app images. After new writes, never blindly
   revert to the stale volume: preserve/reconcile those writes first.

Validation: 35 shared cryptographic/wallet tests and 152 backend tests pass on
Node 26/PostgreSQL 18, including ledger, custody, authentication and migration
schema isolation. Web has no unit test suite; its build and isolated browser
preview are checked separately. npm audit reports zero known advisories.

The migration-034 schema lookup now scopes legacy-table discovery to the current
schema. Existing databases already record that migration, so it does not rerun;
fresh test/restore schemas no longer accidentally discover another schema's table.
