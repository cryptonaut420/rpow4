import type { PoolClient } from 'pg';

export interface LedgerEventRow {
  event_seq: string;
  id: string;
  event_type: 'MINT' | 'TRANSFER';
  actor_pubkey: string;
  counterparty_pubkey: string | null;
  amount: string;
  fee_base_units: string;
  memo: string | null;
  challenge_id: string | null;
  solution_nonce: string | null;
  idempotency_key: string | null;
  client_signature_base58: string | null;
  server_sig: Buffer | null;
  created_at: Date;
}

const GLOBAL_RECENT_LIMIT = 100_000;
const ACCOUNT_RECENT_LIMIT = 200;
const GLOBAL_TRIM_INTERVAL = 256n;
const ACCOUNT_TRIM_INTERVAL = 32n;

/**
 * Mirror one durable ledger event into the bounded hot tables. These hot
 * tables keep public feed and per-account activity reads independent of
 * the total historical ledger size.
 */
export async function mirrorLedgerEventHot(c: PoolClient, event: LedgerEventRow): Promise<void> {
  const eventSeq = BigInt(event.event_seq);
  const shouldTrimGlobal = eventSeq % GLOBAL_TRIM_INTERVAL === 0n;
  const shouldTrimAccount = eventSeq % ACCOUNT_TRIM_INTERVAL === 0n;

  await c.query(
    `INSERT INTO ledger_recent_events(
       event_seq, id, event_type, actor_pubkey, counterparty_pubkey, amount,
       fee_base_units, memo,
       challenge_id, solution_nonce, idempotency_key, client_signature_base58,
       server_sig, created_at
     )
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (event_seq) DO NOTHING`,
    [
      event.event_seq,
      event.id,
      event.event_type,
      event.actor_pubkey,
      event.counterparty_pubkey,
      event.amount,
      event.fee_base_units,
      event.memo,
      event.challenge_id,
      event.solution_nonce,
      event.idempotency_key,
      event.client_signature_base58,
      event.server_sig,
      event.created_at,
    ],
  );

  if (event.event_type === 'MINT') {
    await insertAccountRecentRows(c, [
      {
        id: event.id,
        pubkey: event.actor_pubkey,
        eventSeq: event.event_seq,
        type: 'mint',
        amount: event.amount,
        feeBaseUnits: '0',
        memo: null,
        counterpartyPubkey: null,
        clientSignatureBase58: null,
        createdAt: event.created_at,
      },
    ]);
    if (shouldTrimAccount) await trimAccountRecent(c, event.actor_pubkey);
  } else {
    // Sender + recipient mirrored in a single multi-row INSERT. Treasury
    // fees go to the treasury account_balances balance directly; we do NOT
    // mirror a hot activity row for the treasury (it has no activity feed).
    const rows: AccountRecentRow[] = [
      {
        id: event.id,
        pubkey: event.actor_pubkey,
        eventSeq: event.event_seq,
        type: 'send',
        amount: event.amount,
        feeBaseUnits: event.fee_base_units,
        memo: event.memo,
        counterpartyPubkey: event.counterparty_pubkey,
        clientSignatureBase58: event.client_signature_base58,
        createdAt: event.created_at,
      },
    ];
    if (event.counterparty_pubkey) {
      rows.push({
        id: event.id,
        pubkey: event.counterparty_pubkey,
        eventSeq: event.event_seq,
        type: 'receive',
        amount: event.amount,
        feeBaseUnits: '0',
        memo: event.memo,
        counterpartyPubkey: event.actor_pubkey,
        clientSignatureBase58: event.client_signature_base58,
        createdAt: event.created_at,
      });
    }
    await insertAccountRecentRows(c, rows);
    if (shouldTrimAccount) {
      if (event.counterparty_pubkey) await trimAccountRecent(c, event.counterparty_pubkey);
      await trimAccountRecent(c, event.actor_pubkey);
    }
  }

  // Global hot-feed trim is deliberately amortized. Doing a count/offset
  // delete on every event would make the write path pay for the read cache.
  // Every 256 events is frequent enough to keep the table near the limit.
  if (shouldTrimGlobal) {
    await c.query(
      `DELETE FROM ledger_recent_events
       WHERE event_seq < (
         SELECT event_seq
         FROM ledger_recent_events
         ORDER BY event_seq DESC
         OFFSET $1
         LIMIT 1
       )`,
      [GLOBAL_RECENT_LIMIT],
    );
  }
}

interface AccountRecentRow {
  id: string;
  pubkey: string;
  eventSeq: string;
  type: 'mint' | 'send' | 'receive';
  amount: string;
  feeBaseUnits: string;
  memo: string | null;
  counterpartyPubkey: string | null;
  clientSignatureBase58: string | null;
  createdAt: Date;
}

async function insertAccountRecentRows(
  c: PoolClient,
  rows: AccountRecentRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const valuesSql: string[] = [];
  for (const row of rows) {
    const i = params.length;
    valuesSql.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},$${i + 8},$${i + 9},$${i + 10})`);
    params.push(
      row.id,
      row.pubkey,
      row.eventSeq,
      row.type,
      row.amount,
      row.feeBaseUnits,
      row.memo,
      row.counterpartyPubkey,
      row.clientSignatureBase58,
      row.createdAt,
    );
  }
  await c.query(
    `INSERT INTO account_recent_events(
       id, pubkey, event_seq, type, amount, fee_base_units, memo,
       counterparty_pubkey, client_signature_base58, created_at
     )
     VALUES ${valuesSql.join(',')}
     ON CONFLICT (pubkey, event_seq, type) DO NOTHING`,
    params,
  );
}

async function trimAccountRecent(c: PoolClient, pubkey: string): Promise<void> {
  await c.query(
    `DELETE FROM account_recent_events
     WHERE pubkey=$1
       AND event_seq < (
         SELECT event_seq
         FROM account_recent_events
         WHERE pubkey=$1
         ORDER BY event_seq DESC
         OFFSET $2
         LIMIT 1
       )`,
    [pubkey, ACCOUNT_RECENT_LIMIT],
  );
}
