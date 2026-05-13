import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { CopyButton } from '../components/CopyButton.js';
import {
  api,
  type Rpow2CustodyAdminResponse,
  type Rpow2CustodyStatusResponse,
  type Rpow2CustodyWithdrawal,
  type Rpow2ManualAdjustBody,
} from '../api.js';
import { useMe } from '../hooks/useMe.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { formatRpow, parseRpowToBaseUnits } from '../lib/format.js';
import { usePageMeta } from '../hooks/usePageMeta.js';

const MEMO_SAFE_HANDLE = /^[A-Za-z0-9_-]{3,32}$/;
const POLL_MS = 15_000;

function fmtTime(s?: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleString();
}

function fmtRelative(s?: string | null): string {
  if (!s) return '—';
  const ms = Date.now() - new Date(s).getTime();
  if (!Number.isFinite(ms) || ms < 0) return new Date(s).toLocaleTimeString();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function fmtStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

// Status pills carry the only colour cue on the page that isn't theme green,
// so we keep the mapping centralised. New external_withdrawals statuses
// fall back to a neutral pill via the default branch.
function pillClass(status: string): string {
  switch (status) {
    case 'credited':
    case 'sent':
      return 'status-pill ok';
    case 'pending_approval':
      return 'status-pill warn';
    case 'sending':
      return 'status-pill info';
    case 'failed':
      return 'status-pill error';
    case 'rejected':
      return 'status-pill rejected';
    case 'unattributed':
      return 'status-pill warn';
    default:
      return 'status-pill';
  }
}

interface ManualAdjustFormProps {
  busy: string;
  adjHandle: string;
  adjAmount: string;
  adjMemo: string;
  adjPreview: { pubkey: string; display_name: string | null } | null;
  setAdjHandle: (v: string) => void;
  setAdjAmount: (v: string) => void;
  setAdjMemo: (v: string) => void;
  setAdjPreview: (v: { pubkey: string; display_name: string | null } | null) => void;
  onSubmit: (action: 'credit' | 'debit') => void;
}

function ManualAdjustForm({
  busy, adjHandle, adjAmount, adjMemo, adjPreview,
  setAdjHandle, setAdjAmount, setAdjMemo, setAdjPreview, onSubmit,
}: ManualAdjustFormProps) {
  const amountOk = (() => {
    try { return BigInt(parseRpowToBaseUnits(adjAmount)) > 0n; } catch { return false; }
  })();
  const canSubmit = !busy && adjHandle.trim().length > 0 && amountOk;

  return (
    <div className="custody-adjust-form">
      <div className="custody-form">
        <label>
          handle or pubkey
          <input
            value={adjHandle}
            onChange={(e) => { setAdjHandle(e.target.value); setAdjPreview(null); }}
            placeholder="alice  or  9aXt…pubkey…"
            onBlur={async () => {
              if (!adjHandle.trim()) return;
              try {
                const res = await api.lookup(adjHandle.trim());
                setAdjPreview({ pubkey: res.pubkey, display_name: res.display_name ?? null });
              } catch {
                setAdjPreview(null);
              }
            }}
          />
        </label>
        {adjPreview ? (
          <div className="custody-hint">
            resolved: <strong>{adjPreview.display_name ?? adjPreview.pubkey.slice(0, 16) + '…'}</strong>
            <span className="dim" style={{ marginLeft: 6 }}>{adjPreview.pubkey.slice(0, 12)}…</span>
          </div>
        ) : adjHandle.trim() ? (
          <div className="custody-hint dim">type a handle or pubkey — tab out to resolve</div>
        ) : null}
        <label>
          amount (RPOW2)
          <input
            value={adjAmount}
            onChange={(e) => setAdjAmount(e.target.value)}
            placeholder="10"
            inputMode="decimal"
          />
        </label>
        <label>
          memo <span className="dim">(optional — shown in ledger)</span>
          <input
            value={adjMemo}
            onChange={(e) => setAdjMemo(e.target.value)}
            placeholder="deposit from rpow4bank@gmail.com — manually verified"
          />
        </label>
        <div className="custody-adjust-actions">
          <button
            type="button"
            className="custody-adjust-credit"
            disabled={!canSubmit}
            onClick={() => onSubmit('credit')}
          >
            [ {busy === 'credit' ? 'crediting…' : '+ credit RPOW2'} ]
          </button>
          <button
            type="button"
            className="custody-adjust-debit"
            disabled={!canSubmit}
            onClick={() => onSubmit('debit')}
          >
            [ {busy === 'debit' ? 'debiting…' : '− debit RPOW2'} ]
          </button>
        </div>
      </div>
    </div>
  );
}

export function Rpow2CustodyPage() {
  usePageMeta('RPOW2', 'Deposit, withdraw, and track your RPOW2 balance.');
  const wallet = useWallet();
  const { me } = useMe();
  const { me: rpow2Me, refresh: refreshRpow2Balance } = useMe('rpow2');
  const [status, setStatus] = useState<Rpow2CustodyStatusResponse | null>(null);
  const [adminStatus, setAdminStatus] = useState<Rpow2CustodyAdminResponse | null>(null);
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  const [assignPubkey, setAssignPubkey] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [silentErr, setSilentErr] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string>('');
  const refreshGenRef = useRef(0);

  // Manual adjustment form state (admin only)
  const [adjHandle, setAdjHandle] = useState('');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjMemo, setAdjMemo] = useState('');
  const [adjPreview, setAdjPreview] = useState<{ pubkey: string; display_name: string | null } | null>(null);

  const handleMemoSafe = !!me?.display_name && MEMO_SAFE_HANDLE.test(me.display_name);
  const depositMemo = me?.pubkey ?? '';
  const destinationOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination.trim());
  const amountOk = (() => {
    try { return BigInt(parseRpowToBaseUnits(amount)) > 0n; } catch { return false; }
  })();

  const refresh = useCallback(async (silent = false) => {
    const myGen = ++refreshGenRef.current;
    const isFresh = () => refreshGenRef.current === myGen;
    if (!silent) setErr('');
    try {
      const s = await api.rpow2Custody();
      if (!isFresh()) return;
      setStatus(s);
      if (me?.is_admin) {
        const a = await api.adminRpow2Custody();
        if (!isFresh()) return;
        setAdminStatus(a);
      } else {
        setAdminStatus(null);
      }
      await refreshRpow2Balance();
      if (!isFresh()) return;
      setSilentErr('');
      setLastRefreshedAt(new Date().toISOString());
    } catch (e: any) {
      if (!isFresh()) return;
      const message = e?.message ?? 'failed to load RPOW2 status';
      if (silent) setSilentErr(message);
      else setErr(message);
    }
  }, [me?.is_admin, refreshRpow2Balance]);

  useEffect(() => {
    if (wallet.status !== 'unlocked') return;
    void refresh(false);
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      void refresh(true);
    };
    const id = window.setInterval(tick, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [wallet.status, refresh]);

  const pendingBalance = useMemo(() => {
    let total = 0n;
    for (const w of status?.withdrawals ?? []) {
      if (w.status === 'pending_approval' || w.status === 'sending' || w.status === 'failed') {
        total += BigInt(w.amount_base_units);
      }
    }
    return total;
  }, [status?.withdrawals]);

  const recentActivity = useMemo(() => {
    const deposits = (status?.deposits ?? []).map((d) => ({
      id: d.id,
      kind: 'deposit' as const,
      amount_base_units: d.amount_base_units,
      status: d.status,
      detail: d.raw_memo ? `memo: ${d.raw_memo}` : `from ${d.sender_external_id}`,
      at: d.external_observed_at,
    }));
    const withdrawals = (status?.withdrawals ?? []).map((w) => ({
      id: w.id,
      kind: 'withdrawal' as const,
      amount_base_units: w.amount_base_units,
      status: w.status,
      detail: w.failure_reason ? `failed: ${w.failure_reason}` : `to ${w.destination_external_id}`,
      at: w.created_at,
    }));
    return [...deposits, ...withdrawals]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, 12);
  }, [status?.deposits, status?.withdrawals]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setMsg('');
    setErr('');
    try {
      const result = await fn();
      if (result && typeof result === 'object' && 'processed' in result) {
        const r = result as { processed: number; credited: number; unattributed: number; skipped: number };
        setMsg(`sync complete: ${r.processed} seen, ${r.credited} credited, ${r.unattributed} unattributed, ${r.skipped} skipped`);
      } else if (result && typeof result === 'object' && 'amount_base_units' in result && 'display_name' in result) {
        const r = result as { amount_base_units: string; display_name: string | null; pubkey: string };
        const who = r.display_name ?? r.pubkey.slice(0, 12) + '…';
        setMsg(`${label === 'credit' ? 'credited' : 'debited'} ${formatRpow(r.amount_base_units)} RPOW2 ${label === 'credit' ? 'to' : 'from'} ${who}`);
      } else {
        setMsg('done');
      }
      await refresh(false);
    } catch (e: any) {
      setErr(e?.message ?? 'request failed');
    } finally {
      setBusy('');
    }
  }

  async function requestWithdrawal(e: FormEvent) {
    e.preventDefault();
    if (!status?.configured) {
      setErr('RPOW2 deposits are not configured yet');
      return;
    }
    if (!status.withdrawal_enabled) {
      setErr('RPOW2 withdrawals are currently disabled');
      return;
    }
    let amountBaseUnits: string;
    try {
      amountBaseUnits = parseRpowToBaseUnits(amount);
    } catch {
      setErr('enter a valid RPOW2 amount with up to 9 decimals');
      return;
    }
    if (BigInt(amountBaseUnits) <= 0n) {
      setErr('withdrawal amount must be greater than zero');
      return;
    }
    if (rpow2Me && BigInt(amountBaseUnits) > BigInt(rpow2Me.balance_base_units)) {
      setErr(`amount exceeds your spendable RPOW2 balance of ${formatRpow(rpow2Me.balance_base_units)}`);
      return;
    }
    if (!window.confirm(
      `Request a withdrawal of ${formatRpow(amountBaseUnits)} RPOW2 to ${destination.trim().toLowerCase()}?\n\n`
      + 'It will lock that amount until the withdrawal is reviewed.',
    )) return;
    await run('withdraw', async () => {
      await api.createRpow2Withdrawal({
        destination_email: destination.trim().toLowerCase(),
        amount_base_units: amountBaseUnits,
      });
      setAmount('');
      setDestination('');
    });
  }

  if (wallet.status !== 'unlocked' || !me) {
    return (
      <Panel title="RPOW2">
        <div>not signed in.</div>
        <div style={{ marginTop: 8 }}><Link to={`/login?returnTo=${encodeURIComponent('/assets/rpow2')}`}>[ login and return to RPOW2 ]</Link></div>
      </Panel>
    );
  }

  const userStats = status?.user_stats;
  const aggregates = adminStatus?.aggregates;
  const sendingWithdrawals = adminStatus?.sending_withdrawals ?? [];
  const pendingWithdrawals = adminStatus?.pending_withdrawals ?? [];
  const unattributedDeposits = adminStatus?.unattributed_deposits ?? [];
  const isStale = !!silentErr;

  return (
    <div className="rpow2-custody-page">
      <Panel title="RPOW2 DEPOSITS + WITHDRAWALS">
        <div className="custody-hero">
          <div>
            <h2>RPOW2 deposits and withdrawals</h2>
            <p>
              Send RPOW2 to the RPOW2 account email with your RPOW4 pubkey in the memo.
              Credited RPOW2 can trade on the <Link to="/markets">RPOW2/RPOW4.0 market</Link>.
              Withdrawals are reviewed before they are sent.
            </p>
            <div className="custody-stats">
              {userStats ? (
                <>
                  <div>
                    <span className="dim">total deposited</span>
                    <strong>{formatRpow(userStats.deposits_credited_amount_base_units)} RPOW2</strong>
                    <em>{userStats.deposits_credited} txns</em>
                  </div>
                  <div>
                    <span className="dim">total withdrawn</span>
                    <strong>{formatRpow(userStats.withdrawals_sent_amount_base_units)} RPOW2</strong>
                    <em>{userStats.withdrawals_sent} txns</em>
                  </div>
                </>
              ) : null}
            </div>
          </div>
          <div className="custody-balance-card">
            <div>RPOW2 BALANCE</div>
            <strong>{formatRpow(rpow2Me?.balance_base_units ?? '0')}</strong>
            <span>locked withdrawals: {formatRpow(pendingBalance)} RPOW2</span>
          </div>
        </div>
        {err ? <div className="error" style={{ marginTop: 8 }}>{err}</div> : null}
        {silentErr && !err ? <div className="custody-warning" style={{ marginTop: 8 }}>auto-refresh failed: {silentErr}</div> : null}
        {msg ? <div style={{ color: 'var(--accent)', marginTop: 8 }}>{msg}</div> : null}
        {!status && !err ? (
          <div className="custody-warning">loading RPOW2 status...</div>
        ) : null}
        {status && !status.configured ? (
          <div className="custody-warning">
            RPOW2 deposits and withdrawals are not fully configured yet. They will be available after setup is complete.
          </div>
        ) : null}
      </Panel>

      <div className="custody-grid">
        <Panel title="DEPOSIT RPOW2">
          <div className="custody-section-intro">
            Send RPOW2 to this email, and put the memo below on the transfer.
          </div>
          <div className="custody-field">
            <span>1. RPOW2 email</span>
            <div className="custody-copy-value">
              <code>{status?.banker_email ?? 'not configured'}</code>
              {status?.banker_email ? <CopyButton text={status.banker_email} label="copy" /> : null}
            </div>
          </div>
          <div className="custody-field">
            <span>2. memo</span>
            <div className="custody-copy-value">
              <code>{depositMemo}</code>
              <CopyButton text={depositMemo} label="copy" />
            </div>
          </div>
          {handleMemoSafe ? (
            <div className="custody-hint">
              Your handle <code>{me.display_name}</code> is memo-safe too, but the pubkey above is safest.
            </div>
          ) : (
            <div className="custody-hint">
              Use your pubkey as the memo. Handles with dots, @, or other symbols cannot be used as RPOW2 memos.
            </div>
          )}
          {!status?.deposit_enabled ? <div className="custody-warning">deposits are currently disabled</div> : null}
          <button disabled={!!busy || !status?.configured || !status.deposit_enabled || status.sync.paused} onClick={() => run('sync', api.syncRpow2Deposits)}>
            [ {busy === 'sync' ? 'syncing...' : 'i deposited, sync now'} ]
          </button>
          <div className="custody-hint">Auto-syncs every {Math.round(POLL_MS / 1000)}s while this page is open.</div>
        </Panel>

        <Panel title="WITHDRAW RPOW2">
          <div className="custody-section-intro">
            Request RPOW2 to be sent back to an RPOW2 email address.
          </div>
          <form onSubmit={requestWithdrawal} className="custody-form">
            <label>
              destination RPOW2 email
              <input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="you@example.com" />
            </label>
            <label>
              amount
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10" inputMode="decimal" />
            </label>
            <div className="custody-hint">
              spendable: {formatRpow(rpow2Me?.balance_base_units ?? '0')} RPOW2{' '}
              <button type="button" onClick={() => setAmount(formatRpow(rpow2Me?.balance_base_units ?? '0'))}>[ max ]</button>
            </div>
            {!status?.withdrawal_enabled ? <div className="custody-warning">withdrawals are currently disabled</div> : null}
            <button disabled={!!busy || !status?.configured || !status.withdrawal_enabled || !destinationOk || !amountOk}>[ {busy === 'withdraw' ? 'requesting...' : 'request withdrawal'} ]</button>
          </form>
          <div className="custody-hint">Withdrawal review is required before RPOW2 is sent.</div>
        </Panel>
      </div>

      <Panel title="RECENT ACTIVITY">
        <div className="custody-section-intro">
          Recent deposit and withdrawal requests. For local ledger entries, open{' '}
          <Link to="/assets/rpow2/activity">RPOW2 activity</Link>.
        </div>
        <div className="custody-list">
          {recentActivity.map((item) => (
            <div key={`${item.kind}-${item.id}`} className="custody-row">
              <strong>{item.kind}</strong>
              <span>{formatRpow(item.amount_base_units)} RPOW2</span>
              <span className={pillClass(item.status)}>{fmtStatus(item.status)}</span>
              <span className="dim" title={fmtTime(item.at)}>{fmtRelative(item.at)}</span>
              <span className="dim custody-row-detail">{item.detail}</span>
            </div>
          ))}
          {status && status.deposits.length === 0 && status.withdrawals.length === 0 ? <div style={{ color: 'var(--dim)' }}>no RPOW2 activity yet</div> : null}
        </div>
      </Panel>

      {me.is_admin && adminStatus ? (
        <Panel title="ADMIN RPOW2">
          <div className="custody-admin-toolbar">
            <button disabled={!!busy || !adminStatus.configured} onClick={() => run('admin-sync', api.adminSyncRpow2Deposits)}>
              [ {busy === 'admin-sync' ? 'syncing...' : 'sync deposits'} ]
            </button>
            {adminStatus.sync.paused ? (
              <button disabled={!!busy} onClick={() => run('resume-sync', api.adminResumeRpow2Sync)}>
                [ resume sync ]
              </button>
            ) : null}
            <span>last sync: {fmtRelative(adminStatus.sync.last_success_at)} · error: {adminStatus.sync.last_error ?? 'none'}</span>
          </div>

          {aggregates ? (
            <div className="custody-aggregates">
              <div className="custody-stat-card primary">
                <span className="dim">RPOW2 treasury</span>
                <strong>{formatRpow(aggregates.treasury_spendable_base_units)} RPOW2</strong>
                <em>fees collected from RPOW2 trading</em>
              </div>
              <div className="custody-stat-card">
                <span className="dim">deposits credited</span>
                <strong>{formatRpow(aggregates.deposits_credited_amount_base_units)} RPOW2</strong>
                <em>{aggregates.deposits_credited} txns</em>
              </div>
              <div className="custody-stat-card">
                <span className="dim">withdrawals sent</span>
                <strong>{formatRpow(aggregates.withdrawals_sent_amount_base_units)} RPOW2</strong>
                <em>{aggregates.withdrawals_sent} txns</em>
              </div>
              <div className="custody-stat-card">
                <span className="dim">action needed</span>
                <strong>{formatRpow(aggregates.withdrawals_pending_amount_base_units)} RPOW2</strong>
                <em>
                  {aggregates.withdrawals_pending} pending
                  {aggregates.withdrawals_failed ? ` · ${aggregates.withdrawals_failed} failed` : ''}
                </em>
              </div>
              <div className="custody-stat-card">
                <span className="dim">unattributed deposits</span>
                <strong>{formatRpow(aggregates.deposits_unattributed_amount_base_units)} RPOW2</strong>
                <em>{aggregates.deposits_unattributed} txns</em>
              </div>
            </div>
          ) : null}

          <h3>Pending withdrawals <small className="dim">{pendingWithdrawals.length}</small></h3>
          <div className="custody-list">
            {pendingWithdrawals.map((w: Rpow2CustodyWithdrawal) => (
              <div key={w.id} className="custody-row admin">
                <strong>{formatRpow(w.amount_base_units)} RPOW2</strong>
                <span title={w.destination_external_id}>{w.destination_external_id}</span>
                <span title={w.requester_pubkey ?? ''}>{w.requester_display_name ?? w.requester_pubkey?.slice(0, 10)}</span>
                <span className={pillClass(w.status)}>
                  {fmtStatus(w.status)}{w.failure_reason ? `: ${w.failure_reason}` : ''}
                </span>
                <button disabled={!!busy} onClick={() => {
                  if (window.confirm(`Approve ${formatRpow(w.amount_base_units)} RPOW2 withdrawal to ${w.destination_external_id}?`)) {
                    void run(`approve-${w.id}`, () => api.approveRpow2Withdrawal(w.id));
                  }
                }}>[ approve ]</button>
                <button disabled={!!busy} onClick={() => {
                  if (window.confirm(`Reject this withdrawal and return ${formatRpow(w.amount_base_units)} RPOW2 to the user?`)) {
                    void run(`reject-${w.id}`, () => api.rejectRpow2Withdrawal(w.id));
                  }
                }}>[ reject ]</button>
              </div>
            ))}
            {pendingWithdrawals.length === 0 ? <div style={{ color: 'var(--dim)' }}>no pending withdrawals</div> : null}
          </div>

          {sendingWithdrawals.length > 0 ? (
            <>
              <h3>Sending (auto-finalising) <small className="dim">{sendingWithdrawals.length}</small></h3>
              <div className="custody-list">
                {sendingWithdrawals.map((w) => (
                  <div key={w.id} className="custody-row admin sending">
                    <strong>{formatRpow(w.amount_base_units)} RPOW2</strong>
                    <span>{w.destination_external_id}</span>
                    <span>{w.requester_display_name ?? w.requester_pubkey?.slice(0, 10)}</span>
                    <span className={pillClass(w.status)}>{fmtStatus(w.status)}</span>
                    <span className="dim" title={fmtTime(w.updated_at)}>updated {fmtRelative(w.updated_at)}</span>
                    <span className="dim">{w.external_transfer_id ? 'sent · settling' : 'send in progress'}</span>
                  </div>
                ))}
              </div>
              <div className="custody-hint">
                Sending withdrawals were already approved. Re-approving is safe (idempotent) and will only finalise; it will not double-send.
              </div>
            </>
          ) : null}

          <h3>Unattributed deposits <small className="dim">{unattributedDeposits.length}</small></h3>
          <div className="custody-list">
            {unattributedDeposits.map((d) => (
              <div key={d.id} className="custody-row admin">
                <strong>{formatRpow(d.amount_base_units)} RPOW2</strong>
                <span>from {d.sender_external_id}</span>
                <span>memo: {d.raw_memo ?? 'blank'}</span>
                <span className="dim" title={fmtTime(d.external_observed_at)}>{fmtRelative(d.external_observed_at)}</span>
                <input
                  value={assignPubkey[d.id] ?? ''}
                  onChange={(e) => setAssignPubkey((m) => ({ ...m, [d.id]: e.target.value.trim() }))}
                  placeholder="RPOW4 pubkey"
                />
                <button disabled={!!busy || !assignPubkey[d.id]} onClick={() => {
                  if (window.confirm(`Credit ${formatRpow(d.amount_base_units)} RPOW2 to this RPOW4 pubkey? This is an admin correction and cannot be auto-undone.`)) {
                    void run(`assign-${d.id}`, () => api.assignRpow2Deposit(d.id, assignPubkey[d.id]!));
                  }
                }}>
                  [ assign ]
                </button>
              </div>
            ))}
            {unattributedDeposits.length === 0 ? <div style={{ color: 'var(--dim)' }}>no unattributed deposits</div> : null}
          </div>

          <h3>Manual balance adjustment</h3>
          <div className="custody-hint" style={{ marginBottom: 12 }}>
            Use when you have manually verified an RPOW2 transfer on rpow2.com and need to credit or debit a user directly.
            Credits mint RPOW2 into the user's balance. Debits burn from their spendable balance.
          </div>
          <ManualAdjustForm
            busy={busy}
            adjHandle={adjHandle}
            adjAmount={adjAmount}
            adjMemo={adjMemo}
            adjPreview={adjPreview}
            setAdjHandle={setAdjHandle}
            setAdjAmount={setAdjAmount}
            setAdjMemo={setAdjMemo}
            setAdjPreview={setAdjPreview}
            onSubmit={(action) => {
              const amountBaseUnits = (() => {
                try { return parseRpowToBaseUnits(adjAmount); } catch { return null; }
              })();
              if (!amountBaseUnits || BigInt(amountBaseUnits) <= 0n) {
                setErr('enter a valid amount');
                return;
              }
              const body: Rpow2ManualAdjustBody = {
                handle_or_pubkey: adjHandle.trim(),
                amount_base_units: amountBaseUnits,
                memo: adjMemo.trim() || undefined,
              };
              const label = action === 'credit' ? 'credit' : 'debit';
              const displayName = adjPreview?.display_name ?? adjPreview?.pubkey?.slice(0, 10) ?? adjHandle.trim();
              if (!window.confirm(
                `${action === 'credit' ? 'CREDIT' : 'DEBIT'} ${formatRpow(amountBaseUnits)} RPOW2 ${action === 'credit' ? 'to' : 'from'} "${displayName}"?\n\n`
                + (action === 'debit' ? 'This will burn tokens from their spendable balance. Make sure this is intentional.' : 'This will mint tokens into their balance.'),
              )) return;
              void run(label, async () => {
                const res = action === 'credit'
                  ? await api.adminCreditRpow2(body)
                  : await api.adminDebitRpow2(body);
                setAdjHandle('');
                setAdjAmount('');
                setAdjMemo('');
                setAdjPreview(null);
                return res;
              });
            }}
          />
        </Panel>
      ) : null}
    </div>
  );
}
