import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isValidPubkeyBase58, TREASURY_PUBKEY } from '@rpow/shared';
import { withTxRetry } from '../db.js';
import { mirrorLedgerEventHot, type LedgerEventRow } from '../ledger-hot.js';
import { Rpow2Client, Rpow2ClientError, type Rpow2ActivityEntry } from '../external/rpow2.js';

const PROVIDER = 'rpow2';
const RPOW2_ASSET_ID = '00000000-0000-4000-8000-000000000002';
const MAX_AMOUNT = 10n ** 18n;
const MEMO_SAFE_HANDLE = /^[A-Za-z0-9_-]{3,32}$/;
const USER_SYNC_COOLDOWN_MS = 10_000;
let syncInFlight: Promise<SyncSummary> | null = null;
let lastUserSyncAt = 0;

const Amount = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((s) => BigInt(s) <= MAX_AMOUNT, 'amount too large');

const WithdrawalBody = z.object({
  destination_email: z.string().email().max(254),
  amount_base_units: Amount,
});

const AssignDepositBody = z.object({
  pubkey: z.string().refine(isValidPubkeyBase58),
});

interface SyncSummary {
  ok: true;
  processed: number;
  credited: number;
  unattributed: number;
  skipped: number;
}

interface DepositProcessResult {
  status: 'credited' | 'unattributed' | 'skipped';
  pubkey?: string;
}

interface CustodyFlags {
  deposit_enabled: boolean;
  withdrawal_enabled: boolean;
  paused: boolean;
}

function configured(app: FastifyInstance): boolean {
  return !!(app.config.rpow2SessionCookie && app.config.rpow2BankerEmail);
}

function rpow2Client(app: FastifyInstance): Rpow2Client | null {
  if (!app.config.rpow2SessionCookie) return null;
  return new Rpow2Client({
    baseUrl: app.config.rpow2ApiBaseUrl ?? 'https://api.rpow2.com',
    sessionCookie: app.config.rpow2SessionCookie,
    cfClearance: app.config.rpow2CfClearance,
  });
}

async function isAdmin(app: FastifyInstance, pubkey: string): Promise<boolean> {
  const r = await app.pool.query<{ is_admin: boolean }>(
    `SELECT is_admin FROM accounts WHERE pubkey=$1`,
    [pubkey],
  );
  return r.rows[0]?.is_admin === true;
}

async function custodyFlags(app: FastifyInstance): Promise<CustodyFlags> {
  const r = await app.pool.query<CustodyFlags>(
    `SELECT c.deposit_enabled, c.withdrawal_enabled, COALESCE(s.paused, false) AS paused
     FROM external_asset_configs c
     LEFT JOIN external_sync_state s ON s.provider_key = c.provider_key
     WHERE c.provider_key=$1`,
    [PROVIDER],
  );
  return r.rows[0] ?? { deposit_enabled: false, withdrawal_enabled: false, paused: false };
}

async function requireAdmin(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const s = app.readSession(req);
  if (!s) {
    reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    return null;
  }
  if (!(await isAdmin(app, s.pubkey))) {
    reply.code(403).send({ error: 'FORBIDDEN', message: 'admin access required' });
    return null;
  }
  return s.pubkey;
}

function fingerprint(entry: Rpow2ActivityEntry): string {
  return createHash('sha256')
    .update(JSON.stringify({
      provider: PROVIDER,
      at: entry.at,
      sender: entry.counterparty_email ?? entry.email ?? '',
      amount: entry.amount_base_units,
      memo: entry.memo ?? '',
    }))
    .digest('hex');
}

async function resolveMemo(c: PoolClient, memoRaw: string | null | undefined): Promise<{ pubkey: string; kind: 'pubkey' | 'handle' } | null> {
  const memo = (memoRaw ?? '').trim();
  if (!memo) return null;
  if (isValidPubkeyBase58(memo)) {
    const r = await c.query<{ pubkey: string }>(`SELECT pubkey FROM accounts WHERE pubkey=$1`, [memo]);
    return r.rows[0] ? { pubkey: memo, kind: 'pubkey' } : null;
  }
  if (!MEMO_SAFE_HANDLE.test(memo)) return null;
  const r = await c.query<{ pubkey: string }>(
    `SELECT pubkey FROM accounts WHERE lower(display_name) = lower($1) LIMIT 1`,
    [memo],
  );
  return r.rows[0] ? { pubkey: r.rows[0].pubkey, kind: 'handle' } : null;
}

async function insertCustodyMintEvent(c: PoolClient, pubkey: string, amount: string, memo: string): Promise<LedgerEventRow> {
  const eventId = randomUUID();
  await c.query(`INSERT INTO ledger_event_ids(id, asset_id) VALUES($1, $2::uuid)`, [eventId, RPOW2_ASSET_ID]);
  const inserted = await c.query<LedgerEventRow>(
    `WITH inserted AS (
       INSERT INTO ledger_events(asset_id, id, event_type, actor_pubkey, amount, memo, created_at)
       VALUES($1::uuid, $2, 'MINT', $3, $4::bigint, $5, now())
       RETURNING asset_id, event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                 amount, fee_base_units, memo, challenge_id, solution_nonce, idempotency_key,
                 client_signature_base58, server_sig, created_at
     ),
     upd_event_id AS (
       UPDATE ledger_event_ids ids SET event_seq = i.event_seq FROM inserted i WHERE ids.id = i.id
     )
     SELECT asset_id::text AS asset_id, event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
            amount::text AS amount, fee_base_units::text AS fee_base_units, memo,
            challenge_id, solution_nonce, idempotency_key, client_signature_base58, server_sig, created_at
     FROM inserted`,
    [RPOW2_ASSET_ID, eventId, pubkey, amount, memo],
  );
  return inserted.rows[0]!;
}

async function creditDeposit(c: PoolClient, depositId: string, pubkey: string, memoKind: 'pubkey' | 'handle' | null): Promise<string> {
  const dep = await c.query<{ amount_base_units: string; raw_memo: string | null; sender_external_id: string }>(
    `SELECT amount_base_units::text, raw_memo, sender_external_id
     FROM external_deposits
     WHERE id=$1 AND status='unattributed'
     FOR UPDATE`,
    [depositId],
  );
  if (!dep.rows[0]) throw new Error('deposit not assignable');
  const row = dep.rows[0];

  // Lock the recipient's RPOW2 balance row first, then upsert and read
  // back the (xmax = 0) flag to decide whether this is a brand-new
  // (asset_id, pubkey) row. Doing the existence check inside the lock
  // closes the race where two concurrent credits for the same pubkey
  // could both observe `hadBalance == false` (and double-bump
  // user_count) or both observe `true` (and miss the bump entirely).
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance:' || $1), hashtext($2))`, [RPOW2_ASSET_ID, pubkey]);
  const credit = await c.query<{ was_inserted: boolean }>(
    `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units, minted_base_units, events_count, updated_at)
     VALUES($1::uuid, $2, $3::bigint, $3::bigint, 1, now())
     ON CONFLICT (asset_id, pubkey) DO UPDATE SET
       spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
       minted_base_units = account_balances.minted_base_units + EXCLUDED.minted_base_units,
       events_count = account_balances.events_count + 1,
       updated_at = now()
     RETURNING (xmax = 0) AS was_inserted`,
    [RPOW2_ASSET_ID, pubkey, row.amount_base_units],
  );
  if (credit.rows[0]?.was_inserted) {
    await c.query(
      `UPDATE ledger_stats SET value = value + 1, updated_at = now()
       WHERE asset_id=$1::uuid AND name='user_count'`,
      [RPOW2_ASSET_ID],
    );
  }
  await c.query(
    `UPDATE app_counters SET value = value + $1::bigint WHERE asset_id=$2::uuid AND name='minted_supply'`,
    [row.amount_base_units, RPOW2_ASSET_ID],
  );
  await c.query(
    `UPDATE ledger_stats SET value = value + $1::bigint, updated_at = now()
     WHERE asset_id=$2::uuid AND name='circulating_supply'`,
    [row.amount_base_units, RPOW2_ASSET_ID],
  );
  const event = await insertCustodyMintEvent(
    c,
    pubkey,
    row.amount_base_units,
    `RPOW2 deposit from ${row.sender_external_id}${row.raw_memo ? ` (memo: ${row.raw_memo})` : ''}`,
  );
  await mirrorLedgerEventHot(c, event);
  const updated = await c.query(
    `UPDATE external_deposits
     SET status='credited', account_pubkey=$2, resolved_memo_kind=$3, credited_event_id=$4, credited_at=now()
     WHERE id=$1 AND status='unattributed'`,
    [depositId, pubkey, memoKind, event.id],
  );
  if (updated.rowCount !== 1) {
    throw new Error('rpow2 deposit row was not in unattributed state when crediting');
  }
  return event.id;
}

async function processDeposit(app: FastifyInstance, entry: Rpow2ActivityEntry): Promise<DepositProcessResult> {
  if (entry.type !== 'receive') return { status: 'skipped' };
  if (!/^[1-9][0-9]{0,18}$/.test(entry.amount_base_units) || BigInt(entry.amount_base_units) > MAX_AMOUNT) {
    return { status: 'skipped' };
  }
  const observedAt = new Date(entry.at);
  if (!Number.isFinite(observedAt.getTime())) return { status: 'skipped' };
  const sender = entry.counterparty_email ?? entry.email ?? 'unknown';
  const fp = fingerprint(entry);

  return withTxRetry(app.pool, async (c) => {
    const resolved = await resolveMemo(c, entry.memo);
    const inserted = await c.query<{ id: string }>(
      `INSERT INTO external_deposits(
         asset_id, provider_key, fingerprint, account_pubkey, sender_external_id,
         raw_memo, resolved_memo_kind, amount_base_units, external_observed_at, status
       )
       VALUES($1::uuid, $2, $3, NULL, $4, $5, NULL, $6::bigint, $7, $8)
       ON CONFLICT (fingerprint) DO NOTHING
       RETURNING id::text AS id`,
      [RPOW2_ASSET_ID, PROVIDER, fp, sender, entry.memo ?? null, entry.amount_base_units, observedAt, 'unattributed'],
    );
    const depositId = inserted.rows[0]?.id;
    if (!depositId) {
      if (!resolved) return { status: 'skipped' as const };
      const existing = await c.query<{ id: string }>(
        `SELECT id::text AS id
         FROM external_deposits
         WHERE fingerprint=$1 AND status='unattributed'
         FOR UPDATE`,
        [fp],
      );
      if (!existing.rows[0]) return { status: 'skipped' as const };
      await creditDeposit(c, existing.rows[0].id, resolved.pubkey, resolved.kind);
      return { status: 'credited' as const, pubkey: resolved.pubkey };
    }
    if (!resolved) return { status: 'unattributed' as const };
    await creditDeposit(c, depositId, resolved.pubkey, resolved.kind);
    return { status: 'credited' as const, pubkey: resolved.pubkey };
  }, { onRetry: (err, attempt) => app.log.warn({ err, attempt }, 'rpow2 deposit tx retry') });
}

export async function syncRpow2Deposits(app: FastifyInstance): Promise<SyncSummary> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = doSyncRpow2Deposits(app).finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

async function doSyncRpow2Deposits(app: FastifyInstance): Promise<SyncSummary> {
  if (!configured(app)) {
    await app.pool.query(
      `UPDATE external_sync_state SET last_run_at=now(), last_error=$2 WHERE provider_key=$1`,
      [PROVIDER, 'RPOW2 banker cookie/email is not configured'],
    );
    return { ok: true, processed: 0, credited: 0, unattributed: 0, skipped: 0 };
  }
  const flags = await custodyFlags(app);
  if (!flags.deposit_enabled) {
    await app.pool.query(
      `UPDATE external_sync_state SET last_run_at=now(), last_error=$2 WHERE provider_key=$1`,
      [PROVIDER, 'RPOW2 deposits are disabled'],
    );
    return { ok: true, processed: 0, credited: 0, unattributed: 0, skipped: 0 };
  }
  const client = rpow2Client(app)!;
  const state = await app.pool.query<{ cursor_at: Date; paused: boolean }>(
    `SELECT cursor_at, paused FROM external_sync_state WHERE provider_key=$1`,
    [PROVIDER],
  );
  if (state.rows[0]?.paused) {
    return { ok: true, processed: 0, credited: 0, unattributed: 0, skipped: 0 };
  }
  const since = state.rows[0]?.cursor_at ?? new Date();
  await app.pool.query(
    `UPDATE external_asset_configs SET api_base_url=$2, banker_email=$3, updated_at=now() WHERE provider_key=$1`,
    [PROVIDER, app.config.rpow2ApiBaseUrl ?? 'https://api.rpow2.com', app.config.rpow2BankerEmail],
  );
  await app.pool.query(`UPDATE external_sync_state SET last_run_at=now(), last_error=NULL WHERE provider_key=$1`, [PROVIDER]);

  try {
    const entries = await client.activitySince(since.toISOString());
    let maxAt = since;
    let credited = 0;
    let unattributed = 0;
    let skipped = 0;
    for (const entry of entries) {
      const at = new Date(entry.at);
      if (Number.isFinite(at.getTime()) && at > maxAt) maxAt = at;
      const result = await processDeposit(app, entry);
      if (result.status === 'credited') credited += 1;
      else if (result.status === 'unattributed') unattributed += 1;
      else skipped += 1;
      if (result.pubkey) app.invalidateAccount(result.pubkey);
    }
    app.invalidateLedger();
    const nextCursor = entries.length > 0
      ? new Date(maxAt.getTime() - 5_000)
      : since;
    await app.pool.query(
      `UPDATE external_sync_state SET cursor_at=$2, last_success_at=now(), last_error=NULL WHERE provider_key=$1`,
      [PROVIDER, nextCursor],
    );
    return { ok: true, processed: entries.length, credited, unattributed, skipped };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown RPOW2 sync error';
    // Pause on any auth failure (401 or 403) so we stop hammering the API
    // with a dead cookie. An admin must update the cookie and call /resume.
    const pause = err instanceof Rpow2ClientError && (err.status === 401 || err.status === 403);
    await app.pool.query(
      `UPDATE external_sync_state SET last_error=$2, paused = paused OR $3::boolean WHERE provider_key=$1`,
      [PROVIDER, msg, pause],
    );
    throw err;
  }
}

async function getCustodyStatus(app: FastifyInstance, pubkey: string | null) {
  const cfg = (await app.pool.query<{
    api_base_url: string;
    banker_email: string;
    deposit_enabled: boolean;
    withdrawal_enabled: boolean;
    cursor_at: Date | null;
    last_run_at: Date | null;
    last_success_at: Date | null;
    last_error: string | null;
    paused: boolean;
  }>(
    `SELECT c.api_base_url, c.banker_email, c.deposit_enabled, c.withdrawal_enabled,
            s.cursor_at, s.last_run_at, s.last_success_at, s.last_error, s.paused
     FROM external_asset_configs c
     LEFT JOIN external_sync_state s ON s.provider_key = c.provider_key
     WHERE c.provider_key=$1`,
    [PROVIDER],
  )).rows[0];

  const deposits = pubkey
    ? (await app.pool.query(
        `SELECT id::text, sender_external_id, raw_memo, amount_base_units::text, status,
                external_observed_at, credited_at, credited_event_id::text
         FROM external_deposits
         WHERE asset_id=$1::uuid AND account_pubkey=$2
         ORDER BY external_observed_at DESC LIMIT 25`,
        [RPOW2_ASSET_ID, pubkey],
      )).rows
    : [];
  const withdrawals = pubkey
    ? (await app.pool.query(
        `SELECT id::text, destination_external_id, amount_base_units::text, status,
                failure_reason, external_transfer_id, burn_event_id::text,
                created_at, updated_at, approved_at, sent_at, rejected_at
         FROM external_withdrawals
         WHERE asset_id=$1::uuid AND requester_pubkey=$2
         ORDER BY created_at DESC LIMIT 25`,
        [RPOW2_ASSET_ID, pubkey],
      )).rows
    : [];

  // Lightweight per-user lifetime totals so the wallet can show running
  // counters next to the activity feed without a second round trip.
  const userStats = pubkey
    ? (await app.pool.query<{
        deposits_credited: string;
        deposits_credited_amount: string;
        withdrawals_sent: string;
        withdrawals_sent_amount: string;
      }>(
        `SELECT
           COALESCE((SELECT count(*) FROM external_deposits
                     WHERE asset_id=$1::uuid AND account_pubkey=$2 AND status='credited'),0)::text AS deposits_credited,
           COALESCE((SELECT sum(amount_base_units) FROM external_deposits
                     WHERE asset_id=$1::uuid AND account_pubkey=$2 AND status='credited'),0)::text AS deposits_credited_amount,
           COALESCE((SELECT count(*) FROM external_withdrawals
                     WHERE asset_id=$1::uuid AND requester_pubkey=$2 AND status='sent'),0)::text AS withdrawals_sent,
           COALESCE((SELECT sum(amount_base_units) FROM external_withdrawals
                     WHERE asset_id=$1::uuid AND requester_pubkey=$2 AND status='sent'),0)::text AS withdrawals_sent_amount`,
        [RPOW2_ASSET_ID, pubkey],
      )).rows[0]
    : null;

  return {
    asset_id: RPOW2_ASSET_ID,
    provider_key: PROVIDER,
    configured: configured(app),
    api_base_url: app.config.rpow2ApiBaseUrl ?? cfg?.api_base_url,
    banker_email: app.config.rpow2BankerEmail,
    deposit_enabled: cfg?.deposit_enabled ?? true,
    withdrawal_enabled: cfg?.withdrawal_enabled ?? true,
    sync: {
      cursor_at: cfg?.cursor_at?.toISOString() ?? null,
      last_run_at: cfg?.last_run_at?.toISOString() ?? null,
      last_success_at: cfg?.last_success_at?.toISOString() ?? null,
      last_error: cfg?.last_error ?? null,
      paused: cfg?.paused ?? false,
    },
    user_stats: userStats
      ? {
          deposits_credited: Number(userStats.deposits_credited),
          deposits_credited_amount_base_units: userStats.deposits_credited_amount,
          withdrawals_sent: Number(userStats.withdrawals_sent),
          withdrawals_sent_amount_base_units: userStats.withdrawals_sent_amount,
        }
      : null,
    deposits: deposits.map((r: any) => ({
      ...r,
      external_observed_at: r.external_observed_at.toISOString(),
      credited_at: r.credited_at ? r.credited_at.toISOString() : null,
    })),
    withdrawals: withdrawals.map((r: any) => ({
      ...r,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
      approved_at: r.approved_at ? r.approved_at.toISOString() : null,
      sent_at: r.sent_at ? r.sent_at.toISOString() : null,
      rejected_at: r.rejected_at ? r.rejected_at.toISOString() : null,
    })),
  };
}

interface CustodyAggregates {
  deposits_credited: number;
  deposits_credited_amount_base_units: string;
  deposits_unattributed: number;
  deposits_unattributed_amount_base_units: string;
  withdrawals_pending: number;
  withdrawals_pending_amount_base_units: string;
  withdrawals_sending: number;
  withdrawals_sending_amount_base_units: string;
  withdrawals_failed: number;
  withdrawals_failed_amount_base_units: string;
  withdrawals_sent: number;
  withdrawals_sent_amount_base_units: string;
  withdrawals_rejected: number;
  withdrawals_rejected_amount_base_units: string;
  treasury_spendable_base_units: string;
}

async function getCustodyAggregates(app: FastifyInstance): Promise<CustodyAggregates> {
  const r = (await app.pool.query<CustodyAggregates>(
    `SELECT
       COALESCE((SELECT count(*) FROM external_deposits WHERE provider_key=$1 AND status='credited'),0)::int AS deposits_credited,
       COALESCE((SELECT sum(amount_base_units) FROM external_deposits WHERE provider_key=$1 AND status='credited'),0)::text AS deposits_credited_amount_base_units,
       COALESCE((SELECT count(*) FROM external_deposits WHERE provider_key=$1 AND status='unattributed'),0)::int AS deposits_unattributed,
       COALESCE((SELECT sum(amount_base_units) FROM external_deposits WHERE provider_key=$1 AND status='unattributed'),0)::text AS deposits_unattributed_amount_base_units,
       COALESCE((SELECT count(*) FROM external_withdrawals WHERE provider_key=$1 AND status='pending_approval'),0)::int AS withdrawals_pending,
       COALESCE((SELECT sum(amount_base_units) FROM external_withdrawals WHERE provider_key=$1 AND status='pending_approval'),0)::text AS withdrawals_pending_amount_base_units,
       COALESCE((SELECT count(*) FROM external_withdrawals WHERE provider_key=$1 AND status='sending'),0)::int AS withdrawals_sending,
       COALESCE((SELECT sum(amount_base_units) FROM external_withdrawals WHERE provider_key=$1 AND status='sending'),0)::text AS withdrawals_sending_amount_base_units,
       COALESCE((SELECT count(*) FROM external_withdrawals WHERE provider_key=$1 AND status='failed'),0)::int AS withdrawals_failed,
       COALESCE((SELECT sum(amount_base_units) FROM external_withdrawals WHERE provider_key=$1 AND status='failed'),0)::text AS withdrawals_failed_amount_base_units,
       COALESCE((SELECT count(*) FROM external_withdrawals WHERE provider_key=$1 AND status='sent'),0)::int AS withdrawals_sent,
       COALESCE((SELECT sum(amount_base_units) FROM external_withdrawals WHERE provider_key=$1 AND status='sent'),0)::text AS withdrawals_sent_amount_base_units,
       COALESCE((SELECT count(*) FROM external_withdrawals WHERE provider_key=$1 AND status='rejected'),0)::int AS withdrawals_rejected,
       COALESCE((SELECT sum(amount_base_units) FROM external_withdrawals WHERE provider_key=$1 AND status='rejected'),0)::text AS withdrawals_rejected_amount_base_units,
       COALESCE((SELECT spendable_base_units FROM account_balances WHERE asset_id=$2::uuid AND pubkey=$3),0)::text AS treasury_spendable_base_units`,
    [PROVIDER, RPOW2_ASSET_ID, TREASURY_PUBKEY],
  )).rows[0]!;
  return r;
}

async function settleWithdrawal(app: FastifyInstance, withdrawalId: string, adminPubkey: string) {
  const flags = await custodyFlags(app);
  if (!flags.withdrawal_enabled) {
    return { error: 'BAD_REQUEST' as const, status: 503, message: 'RPOW2 withdrawals are disabled' };
  }
  const claim = await app.pool.query<{ id: string; destination_external_id: string; amount_base_units: string; idempotency_key: string; external_transfer_id: string | null }>(
    `UPDATE external_withdrawals
     SET status='sending', admin_pubkey=$2, approved_at=COALESCE(approved_at, now()), updated_at=now(), failure_reason=NULL
     WHERE id=$1 AND status IN ('pending_approval','failed')
     RETURNING id::text, destination_external_id, amount_base_units::text, idempotency_key, external_transfer_id`,
    [withdrawalId, adminPubkey],
  );
  let row = claim.rows[0];
  if (!row) {
    const existing = await app.pool.query<{
      id: string;
      destination_external_id: string;
      amount_base_units: string;
      idempotency_key: string;
      external_transfer_id: string | null;
      status: string;
    }>(
      `SELECT id::text, destination_external_id, amount_base_units::text,
              idempotency_key, external_transfer_id, status
       FROM external_withdrawals
       WHERE id=$1`,
      [withdrawalId],
    );
    const current = existing.rows[0];
    if (!current) return { error: 'NOT_FOUND' as const, status: 404, message: 'withdrawal not found or not approvable' };
    if (current.status === 'sending' && current.external_transfer_id) {
      row = current;
    } else if (current.status === 'sending') {
      return { error: 'BAD_REQUEST' as const, status: 409, message: 'withdrawal is already sending; wait for the first approval attempt to finish' };
    } else {
      return { error: 'NOT_FOUND' as const, status: 404, message: 'withdrawal not found or not approvable' };
    }
  }
  const client = rpow2Client(app);
  if (!client || !configured(app)) {
    await app.pool.query(
      `UPDATE external_withdrawals SET status='failed', failure_reason=$2, updated_at=now() WHERE id=$1`,
      [withdrawalId, 'RPOW2 banker cookie/email is not configured'],
    );
    return { error: 'BAD_REQUEST' as const, status: 503, message: 'RPOW2 banker is not configured' };
  }

  let externalTransferId: string | null = row.external_transfer_id;
  if (!externalTransferId) {
    try {
      const sent = await client.sendWithdrawal({
        destinationEmail: row.destination_external_id,
        amountBaseUnits: row.amount_base_units,
        idempotencyKey: row.idempotency_key,
        memo: `RPOW2 withdrawal ${row.id.slice(0, 8)}`,
      });
      externalTransferId = sent.transfer_id ?? sent.id ?? `idempotency:${row.id}`;
      await app.pool.query(
        `UPDATE external_withdrawals
         SET external_transfer_id=$2, updated_at=now()
         WHERE id=$1 AND status='sending'`,
        [withdrawalId, externalTransferId],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'RPOW2 send failed';
      const pause = err instanceof Rpow2ClientError && (err.status === 401 || err.status === 403);
      await app.pool.query(
        `UPDATE external_withdrawals SET status='failed', failure_reason=$2, updated_at=now() WHERE id=$1`,
        [withdrawalId, msg],
      );
      if (pause) {
        await app.pool.query(
          `UPDATE external_sync_state SET paused=true, last_error=$2 WHERE provider_key=$1`,
          [PROVIDER, msg],
        );
      }
      return { error: 'BAD_REQUEST' as const, status: 502, message: msg };
    }
  }

  const finalized = await withTxRetry(app.pool, async (c) => {
    const w = await c.query<{ requester_pubkey: string; amount_base_units: string; destination_external_id: string }>(
      `SELECT requester_pubkey, amount_base_units::text, destination_external_id
       FROM external_withdrawals
       WHERE id=$1 AND status='sending'
       FOR UPDATE`,
      [withdrawalId],
    );
    if (!w.rows[0]) return null;
    const wr = w.rows[0];
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance:' || $1), hashtext($2))`, [RPOW2_ASSET_ID, wr.requester_pubkey]);
    const debit = await c.query(
      `UPDATE account_balances
       SET locked_base_units = locked_base_units - $3::bigint,
           events_count = events_count + 1,
           updated_at = now()
       WHERE asset_id=$1::uuid AND pubkey=$2 AND locked_base_units >= $3::bigint`,
      [RPOW2_ASSET_ID, wr.requester_pubkey, wr.amount_base_units],
    );
    if (debit.rowCount === 0) throw new Error('withdrawal locked balance invariant failed');
    await c.query(
      `UPDATE ledger_stats SET value = value - $1::bigint, updated_at=now()
       WHERE asset_id=$2::uuid AND name='circulating_supply'`,
      [wr.amount_base_units, RPOW2_ASSET_ID],
    );
    await c.query(
      `UPDATE app_counters SET value = value + $1::bigint
       WHERE asset_id=$2::uuid AND name='burned_supply'`,
      [wr.amount_base_units, RPOW2_ASSET_ID],
    );

    const eventId = randomUUID();
    await c.query(`INSERT INTO ledger_event_ids(id, asset_id) VALUES($1, $2::uuid)`, [eventId, RPOW2_ASSET_ID]);
    const inserted = await c.query<LedgerEventRow>(
      `WITH inserted AS (
         INSERT INTO ledger_events(asset_id, id, event_type, actor_pubkey, amount, memo, created_at)
         VALUES($1::uuid, $2, 'BURN', $3, $4::bigint, $5, now())
         RETURNING asset_id, event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                   amount, fee_base_units, memo, challenge_id, solution_nonce, idempotency_key,
                   client_signature_base58, server_sig, created_at
       ),
       upd_event_id AS (
         UPDATE ledger_event_ids ids SET event_seq = i.event_seq FROM inserted i WHERE ids.id = i.id
       )
       SELECT asset_id::text AS asset_id, event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
              amount::text AS amount, fee_base_units::text AS fee_base_units, memo,
              challenge_id, solution_nonce, idempotency_key, client_signature_base58, server_sig, created_at
       FROM inserted`,
      [RPOW2_ASSET_ID, eventId, wr.requester_pubkey, wr.amount_base_units, `RPOW2 withdrawal to ${wr.destination_external_id}`],
    );
    await mirrorLedgerEventHot(c, inserted.rows[0]!);
    await c.query(
      `UPDATE external_withdrawals
       SET status='sent', external_transfer_id=$2, burn_event_id=$3, sent_at=now(), updated_at=now()
       WHERE id=$1`,
      [withdrawalId, externalTransferId, eventId],
    );
    return { pubkey: wr.requester_pubkey, burn_event_id: eventId };
  });
  if (finalized) {
    app.invalidateAccount(finalized.pubkey);
    app.invalidateLedger();
  }
  return { ok: true as const, id: withdrawalId, external_transfer_id: externalTransferId, burn_event_id: finalized?.burn_event_id ?? null };
}

export async function rpow2CustodyRoutes(app: FastifyInstance) {
  app.get('/custody/rpow2', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    return getCustodyStatus(app, s.pubkey);
  });

  app.post('/custody/rpow2/sync', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    if (!configured(app)) return reply.code(503).send({ error: 'BAD_REQUEST', message: 'RPOW2 banker is not configured' });
    const now = Date.now();
    if (now - lastUserSyncAt < USER_SYNC_COOLDOWN_MS) {
      return reply.code(429).send({
        error: 'RATE_LIMITED',
        message: 'RPOW2 sync was just requested; try again in a few seconds',
        retry_after: Math.ceil((USER_SYNC_COOLDOWN_MS - (now - lastUserSyncAt)) / 1000),
      });
    }
    lastUserSyncAt = now;
    const flags = await custodyFlags(app);
    if (!flags.deposit_enabled) return reply.code(503).send({ error: 'BAD_REQUEST', message: 'RPOW2 deposits are disabled' });
    if (flags.paused) return reply.code(409).send({ error: 'BAD_REQUEST', message: 'RPOW2 sync is paused; an admin must resume it after refreshing the banker cookie' });
    return syncRpow2Deposits(app);
  });

  app.post('/custody/rpow2/withdrawals', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = WithdrawalBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    if (!configured(app)) return reply.code(503).send({ error: 'BAD_REQUEST', message: 'RPOW2 banker is not configured' });
    const flags = await custodyFlags(app);
    if (!flags.withdrawal_enabled) return reply.code(503).send({ error: 'BAD_REQUEST', message: 'RPOW2 withdrawals are disabled' });
    const { destination_email, amount_base_units } = parsed.data;
    const withdrawalId = randomUUID();
    const result = await withTxRetry(app.pool, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance:' || $1), hashtext($2))`, [RPOW2_ASSET_ID, s.pubkey]);
      const locked = await c.query(
        `UPDATE account_balances
         SET spendable_base_units = spendable_base_units - $3::bigint,
             locked_base_units = locked_base_units + $3::bigint,
             updated_at = now()
         WHERE asset_id=$1::uuid AND pubkey=$2 AND spendable_base_units >= $3::bigint`,
        [RPOW2_ASSET_ID, s.pubkey, amount_base_units],
      );
      if (locked.rowCount === 0) return { error: 'INSUFFICIENT_BALANCE' as const, message: 'not enough RPOW2 balance', status: 400 };
      await c.query(
        `INSERT INTO external_withdrawals(
           id, asset_id, provider_key, requester_pubkey, destination_external_id,
           amount_base_units, status, idempotency_key
         )
         VALUES($1::uuid, $2::uuid, $3, $4, $5, $6::bigint, 'pending_approval', $1::text)`,
        [withdrawalId, RPOW2_ASSET_ID, PROVIDER, s.pubkey, destination_email, amount_base_units],
      );
      return { ok: true as const, id: withdrawalId, status: 'pending_approval' as const };
    });
    if ('error' in result) return reply.code(result.status as number).send(result);
    app.invalidateAccount(s.pubkey);
    return result;
  });

  app.get('/admin/custody/rpow2', async (req, reply) => {
    const admin = await requireAdmin(app, req, reply);
    if (!admin) return;
    const status = await getCustodyStatus(app, null);
    const aggregates = await getCustodyAggregates(app);
    // Pending = needs admin action (`pending_approval` or `failed` after a
    // retryable error). Sending = previously approved and now finalising;
    // it's surfaced separately so admins don't accidentally double-approve.
    const pending = (await app.pool.query(
      `SELECT w.id::text, w.requester_pubkey, a.display_name AS requester_display_name,
              w.destination_external_id, w.amount_base_units::text, w.status, w.failure_reason,
              w.external_transfer_id, w.burn_event_id::text, w.created_at, w.updated_at,
              w.approved_at, w.sent_at, w.rejected_at
       FROM external_withdrawals w
       LEFT JOIN accounts a ON a.pubkey = w.requester_pubkey
       WHERE w.provider_key=$1 AND w.status IN ('pending_approval','failed')
       ORDER BY w.created_at ASC LIMIT 100`,
      [PROVIDER],
    )).rows;
    const sending = (await app.pool.query(
      `SELECT w.id::text, w.requester_pubkey, a.display_name AS requester_display_name,
              w.destination_external_id, w.amount_base_units::text, w.status, w.failure_reason,
              w.external_transfer_id, w.burn_event_id::text, w.created_at, w.updated_at,
              w.approved_at, w.sent_at, w.rejected_at
       FROM external_withdrawals w
       LEFT JOIN accounts a ON a.pubkey = w.requester_pubkey
       WHERE w.provider_key=$1 AND w.status='sending'
       ORDER BY w.updated_at ASC LIMIT 100`,
      [PROVIDER],
    )).rows;
    const unattributed = (await app.pool.query(
      `SELECT id::text, sender_external_id, raw_memo, amount_base_units::text,
              external_observed_at, created_at, note
       FROM external_deposits
       WHERE provider_key=$1 AND status='unattributed'
       ORDER BY external_observed_at DESC LIMIT 100`,
      [PROVIDER],
    )).rows;
    const wireWithdrawal = (r: any) => ({
      ...r,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
      approved_at: r.approved_at ? r.approved_at.toISOString() : null,
      sent_at: r.sent_at ? r.sent_at.toISOString() : null,
      rejected_at: r.rejected_at ? r.rejected_at.toISOString() : null,
    });
    return {
      ...status,
      aggregates,
      pending_withdrawals: pending.map(wireWithdrawal),
      sending_withdrawals: sending.map(wireWithdrawal),
      unattributed_deposits: unattributed.map((r: any) => ({
        ...r,
        external_observed_at: r.external_observed_at.toISOString(),
        created_at: r.created_at.toISOString(),
      })),
    };
  });

  app.post('/admin/custody/rpow2/sync', async (req, reply) => {
    const admin = await requireAdmin(app, req, reply);
    if (!admin) return;
    if (!configured(app)) return reply.code(503).send({ error: 'BAD_REQUEST', message: 'RPOW2 banker is not configured' });
    const flags = await custodyFlags(app);
    if (!flags.deposit_enabled) return reply.code(503).send({ error: 'BAD_REQUEST', message: 'RPOW2 deposits are disabled' });
    if (flags.paused) return reply.code(409).send({ error: 'BAD_REQUEST', message: 'RPOW2 sync is paused; refresh the banker cookie and resume sync first' });
    return syncRpow2Deposits(app);
  });

  app.post('/admin/custody/rpow2/resume', async (req, reply) => {
    const admin = await requireAdmin(app, req, reply);
    if (!admin) return;
    await app.pool.query(
      `UPDATE external_sync_state
       SET paused=false, last_error=NULL, last_run_at=now()
       WHERE provider_key=$1`,
      [PROVIDER],
    );
    return { ok: true };
  });

  app.post('/admin/custody/rpow2/withdrawals/:id/approve', async (req: any, reply) => {
    const admin = await requireAdmin(app, req, reply);
    if (!admin) return;
    const id = String(req.params.id);
    const result = await settleWithdrawal(app, id, admin);
    if ('error' in result) return reply.code(result.status as number).send(result);
    return result;
  });

  app.post('/admin/custody/rpow2/withdrawals/:id/reject', async (req: any, reply) => {
    const admin = await requireAdmin(app, req, reply);
    if (!admin) return;
    const id = String(req.params.id);
    const result = await withTxRetry(app.pool, async (c) => {
      const w = await c.query<{ requester_pubkey: string; amount_base_units: string }>(
        `UPDATE external_withdrawals
         SET status='rejected', admin_pubkey=$2, rejected_at=now(), updated_at=now()
         WHERE id=$1 AND status IN ('pending_approval','failed')
         RETURNING requester_pubkey, amount_base_units::text`,
        [id, admin],
      );
      const row = w.rows[0];
      if (!row) return null;
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance:' || $1), hashtext($2))`, [RPOW2_ASSET_ID, row.requester_pubkey]);
      const unlocked = await c.query(
        `UPDATE account_balances
         SET locked_base_units = locked_base_units - $3::bigint,
             spendable_base_units = spendable_base_units + $3::bigint,
             updated_at = now()
         WHERE asset_id=$1::uuid AND pubkey=$2 AND locked_base_units >= $3::bigint`,
        [RPOW2_ASSET_ID, row.requester_pubkey, row.amount_base_units],
      );
      if (unlocked.rowCount !== 1) throw new Error('withdrawal locked balance invariant failed');
      return row.requester_pubkey;
    });
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND', message: 'withdrawal not found or not rejectable' });
    app.invalidateAccount(result);
    return { ok: true, id, status: 'rejected' };
  });

  app.post('/admin/custody/rpow2/deposits/:id/assign', async (req: any, reply) => {
    const admin = await requireAdmin(app, req, reply);
    if (!admin) return;
    const id = String(req.params.id);
    const parsed = AssignDepositBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    const account = await app.pool.query(`SELECT 1 FROM accounts WHERE pubkey=$1`, [parsed.data.pubkey]);
    if (account.rowCount === 0) return reply.code(404).send({ error: 'NOT_FOUND', message: 'account not found' });
    try {
      const eventId = await withTxRetry(app.pool, (c) => creditDeposit(c, id, parsed.data.pubkey, null));
      app.invalidateAccount(parsed.data.pubkey);
      app.invalidateLedger();
      return { ok: true, id, credited_event_id: eventId };
    } catch {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'deposit not found or already credited' });
    }
  });

  const ManualAdjustBody = z.object({
    handle_or_pubkey: z.string().min(1).max(256),
    amount_base_units: Amount,
    memo: z.string().max(500).default(''),
  });

  async function resolveAccount(handleOrPubkey: string): Promise<{ pubkey: string; display_name: string | null } | null> {
    const r = await app.pool.query<{ pubkey: string; display_name: string | null }>(
      `SELECT pubkey, display_name FROM accounts
       WHERE pubkey=$1 OR lower(display_name)=lower($1)
       LIMIT 1`,
      [handleOrPubkey],
    );
    return r.rows[0] ?? null;
  }

  // Manual admin credit: directly mint RPOW2 to a user without requiring an
  // external deposit record. Use when you've manually verified an incoming
  // RPOW2 transfer and want to credit the recipient.
  app.post('/admin/custody/rpow2/credit', async (req, reply) => {
    const admin = await requireAdmin(app, req, reply);
    if (!admin) return;
    const parsed = ManualAdjustBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: parsed.error.errors[0]?.message ?? 'invalid body' });
    const { handle_or_pubkey, amount_base_units, memo } = parsed.data;
    const account = await resolveAccount(handle_or_pubkey);
    if (!account) return reply.code(404).send({ error: 'NOT_FOUND', message: `no account found for "${handle_or_pubkey}"` });

    const eventId = await withTxRetry(app.pool, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance:' || $1), hashtext($2))`, [RPOW2_ASSET_ID, account.pubkey]);
      const credit = await c.query(
        `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units, minted_base_units, events_count, updated_at)
         VALUES($1::uuid, $2, $3::bigint, $3::bigint, 1, now())
         ON CONFLICT (asset_id, pubkey) DO UPDATE SET
           spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
           minted_base_units = account_balances.minted_base_units + EXCLUDED.minted_base_units,
           events_count = account_balances.events_count + 1,
           updated_at = now()
         RETURNING (xmax = 0) AS was_inserted`,
        [RPOW2_ASSET_ID, account.pubkey, amount_base_units],
      );
      if (credit.rows[0]?.was_inserted) {
        await c.query(
          `UPDATE ledger_stats SET value = value + 1, updated_at = now()
           WHERE asset_id=$1::uuid AND name='user_count'`,
          [RPOW2_ASSET_ID],
        );
      }
      await c.query(
        `UPDATE app_counters SET value = value + $1::bigint WHERE asset_id=$2::uuid AND name='minted_supply'`,
        [amount_base_units, RPOW2_ASSET_ID],
      );
      await c.query(
        `UPDATE ledger_stats SET value = value + $1::bigint, updated_at = now()
         WHERE asset_id=$2::uuid AND name='circulating_supply'`,
        [amount_base_units, RPOW2_ASSET_ID],
      );
      const memoStr = memo || `manual RPOW2 credit by admin`;
      const event = await insertCustodyMintEvent(c, account.pubkey, amount_base_units, memoStr);
      await mirrorLedgerEventHot(c, event);
      return event.id;
    }, { onRetry: (err, attempt) => app.log.warn({ err, attempt }, 'admin rpow2 credit tx retry') });

    app.invalidateAccount(account.pubkey);
    app.invalidateLedger();
    return {
      ok: true,
      pubkey: account.pubkey,
      display_name: account.display_name,
      amount_base_units,
      event_id: eventId,
    };
  });

  // Manual admin debit: burn RPOW2 from a user's spendable balance.
  // Use for corrections (e.g. a credit was applied in error).
  app.post('/admin/custody/rpow2/debit', async (req, reply) => {
    const admin = await requireAdmin(app, req, reply);
    if (!admin) return;
    const parsed = ManualAdjustBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: parsed.error.errors[0]?.message ?? 'invalid body' });
    const { handle_or_pubkey, amount_base_units, memo } = parsed.data;
    const account = await resolveAccount(handle_or_pubkey);
    if (!account) return reply.code(404).send({ error: 'NOT_FOUND', message: `no account found for "${handle_or_pubkey}"` });

    const eventId = await withTxRetry(app.pool, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance:' || $1), hashtext($2))`, [RPOW2_ASSET_ID, account.pubkey]);
      const debit = await c.query(
        `UPDATE account_balances
         SET spendable_base_units = spendable_base_units - $3::bigint,
             events_count = events_count + 1,
             updated_at = now()
         WHERE asset_id=$1::uuid AND pubkey=$2 AND spendable_base_units >= $3::bigint`,
        [RPOW2_ASSET_ID, account.pubkey, amount_base_units],
      );
      if (debit.rowCount === 0) throw Object.assign(new Error('insufficient RPOW2 balance for debit'), { statusCode: 400 });
      await c.query(
        `UPDATE ledger_stats SET value = value - $1::bigint, updated_at=now()
         WHERE asset_id=$2::uuid AND name='circulating_supply'`,
        [amount_base_units, RPOW2_ASSET_ID],
      );
      await c.query(
        `UPDATE app_counters SET value = value + $1::bigint
         WHERE asset_id=$2::uuid AND name='burned_supply'`,
        [amount_base_units, RPOW2_ASSET_ID],
      );
      const memoStr = memo || `manual RPOW2 debit by admin`;
      const eventId2 = randomUUID();
      await c.query(`INSERT INTO ledger_event_ids(id, asset_id) VALUES($1, $2::uuid)`, [eventId2, RPOW2_ASSET_ID]);
      const inserted = await c.query<LedgerEventRow>(
        `WITH inserted AS (
           INSERT INTO ledger_events(asset_id, id, event_type, actor_pubkey, amount, memo, created_at)
           VALUES($1::uuid, $2, 'BURN', $3, $4::bigint, $5, now())
           RETURNING asset_id, event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                     amount, fee_base_units, memo, challenge_id, solution_nonce, idempotency_key,
                     client_signature_base58, server_sig, created_at
         ),
         upd_event_id AS (
           UPDATE ledger_event_ids ids SET event_seq = i.event_seq FROM inserted i WHERE ids.id = i.id
         )
         SELECT asset_id::text AS asset_id, event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                amount::text AS amount, fee_base_units::text AS fee_base_units, memo,
                challenge_id, solution_nonce, idempotency_key, client_signature_base58, server_sig, created_at
         FROM inserted`,
        [RPOW2_ASSET_ID, eventId2, account.pubkey, amount_base_units, memoStr],
      );
      await mirrorLedgerEventHot(c, inserted.rows[0]!);
      return eventId2;
    }, { onRetry: (err, attempt) => app.log.warn({ err, attempt }, 'admin rpow2 debit tx retry') });

    app.invalidateAccount(account.pubkey);
    app.invalidateLedger();
    return {
      ok: true,
      pubkey: account.pubkey,
      display_name: account.display_name,
      amount_base_units,
      event_id: eventId,
    };
  });
}
