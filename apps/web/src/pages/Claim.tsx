import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Panel } from '../components/Panel.js';
import { CopyButton } from '../components/CopyButton.js';
import { usePageMeta } from '../hooks/usePageMeta.js';
import { api } from '../api.js';
import { useMe } from '../hooks/useMe.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { formatRpow, parseRpowToBaseUnits } from '../lib/format.js';
import type { ClaimStatusResponse } from '@rpow/shared';
import { Link } from 'react-router-dom';

/** Try to parse a user-typed RPOW string into base units. Returns null on any error. */
function tryParseAmount(raw: string): bigint | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const bu = BigInt(parseRpowToBaseUnits(s));
    return bu > 0n ? bu : null;
  } catch {
    return null;
  }
}

function redeemUrl(claimId: string): string {
  return `${window.location.origin}${window.location.pathname}#/redeem/${claimId}`;
}

export function ClaimPage() {
  usePageMeta('Claim', 'Create bearer claim tokens — shareable codes or QR codes that anyone can redeem to their wallet.');
  const wallet = useWallet();
  const { me, refresh } = useMe();

  // Create form
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Newly created claim
  const [created, setCreated] = useState<{ claim_id: string; amount_base_units: string; memo?: string } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // Pending claims list
  const [claims, setClaims] = useState<ClaimStatusResponse[]>([]);
  const [loadingClaims, setLoadingClaims] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  async function loadClaims() {
    setLoadingClaims(true);
    try {
      const r = await api.myClaims();
      setClaims(r.claims);
    } catch {
      // ignore — not logged in yet
    } finally {
      setLoadingClaims(false);
    }
  }

  useEffect(() => {
    if (wallet.status === 'unlocked') loadClaims();
  }, [wallet.status]);

  // Generate QR code whenever a new claim is created.
  useEffect(() => {
    if (!created) { setQrDataUrl(null); return; }
    QRCode.toDataURL(redeemUrl(created.claim_id), { width: 256, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [created]);

  if (wallet.status !== 'unlocked' || !me) {
    return (
      <Panel title="CLAIM TOKENS">
        <div>not signed in.</div>
        <div style={{ marginTop: 8 }}>
          <Link to="/login">[ create or import wallet ]</Link>
        </div>
      </Panel>
    );
  }

  const balance = BigInt(me.balance_base_units);
  const amountBu = tryParseAmount(amount);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet || wallet.status !== 'unlocked') return;

    const amBu = amountBu;
    if (!amBu || amBu <= 0n) {
      setCreateError('enter a valid amount greater than zero');
      return;
    }
    if (amBu > balance) {
      setCreateError(`amount exceeds your balance of ${formatRpow(me!.balance_base_units)} RPOW`);
      return;
    }

    setCreating(true);
    setCreateError('');

    const claim_id = crypto.randomUUID();
    const amount_base_units = amBu.toString();
    const trimmedMemo = memo.trim();
    const sigBody: Record<string, string> = { claim_id, amount_base_units };
    if (trimmedMemo) sigBody.memo = trimmedMemo;

    try {
      const r = await api.createClaim({
        claim_id,
        amount_base_units,
        ...(trimmedMemo ? { memo: trimmedMemo } : {}),
        client_signature_base58: wallet.sign('claim.create', sigBody),
      });
      setCreated({ claim_id: r.claim_id, amount_base_units: r.amount_base_units, memo: r.memo });
      setAmount('');
      setMemo('');
      await refresh();
      await loadClaims();
    } catch (err: any) {
      const code = err?.error ?? 'INTERNAL';
      const msgMap: Record<string, string> = {
        INSUFFICIENT_BALANCE: 'not enough balance',
        INVALID_SIGNATURE: 'wallet signature did not verify (try unlocking again)',
        UNAUTHORIZED: 'session expired — sign in again',
      };
      setCreateError(msgMap[code] ?? (err?.message ?? code));
    } finally {
      setCreating(false);
    }
  }

  async function handleCancel(claimId: string, claimAmountBaseUnits: string) {
    if (!wallet || wallet.status !== 'unlocked') return;
    setCancellingId(claimId);
    try {
      await api.cancelClaim(claimId, {
        client_signature_base58: wallet.sign('claim.cancel', { claim_id: claimId }),
      });
      await refresh();
      await loadClaims();
    } catch (err: any) {
      alert(`cancel failed: ${err?.message ?? err?.error ?? 'unknown error'}`);
    } finally {
      setCancellingId(null);
    }
  }

  const pendingClaims = claims.filter((c) => c.state === 'pending');
  const pastClaims = claims.filter((c) => c.state !== 'pending');

  return (
    <>
      <Panel title="CREATE CLAIM TOKEN">
        <div style={{ marginBottom: 10, color: 'var(--dim)', fontSize: 12 }}>
          A claim token is a one-time code (QR or link) that{' '}
          <strong style={{ color: 'var(--fg)' }}>any signed-in account</strong> can redeem to receive
          RPOW. Funds are locked immediately; you can cancel any time to recover them.
        </div>
        <div style={{ marginBottom: 10, color: 'var(--dim)', fontSize: 12 }}>
          balance: <strong style={{ color: 'var(--fg)' }}>{formatRpow(me.balance_base_units)} RPOW</strong>
        </div>
        <form onSubmit={handleCreate}>
          <div>
            AMOUNT : <input
              type="text"
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setCreateError(''); }}
              placeholder="e.g. 0.5"
              style={{ width: '14ch' }}
            /> RPOW{' '}
            {balance > 0n && (
              <button
                type="button"
                onClick={() => setAmount(formatRpow(balance))}
                style={{ fontSize: 11, padding: '1px 6px' }}
              >
                [ max ]
              </button>
            )}
          </div>
          {amount.trim() !== '' && amountBu !== null && (
            <div style={{ fontSize: 11, color: amountBu > balance ? 'var(--accent)' : 'var(--dim)', marginTop: 3 }}>
              {amountBu > balance ? 'exceeds balance' : `≈ ${formatRpow(amountBu)} RPOW will be locked`}
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            MEMO   : <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="optional, up to 64 characters"
              style={{ width: '50ch', fontFamily: 'inherit' }}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
            />
            {memo.length > 0 && (
              <span style={{ color: memo.length > 60 ? 'var(--accent)' : 'var(--dim)', fontSize: 11, marginLeft: 8 }}>
                {memo.length}/64
              </span>
            )}
          </div>
          <div style={{ marginTop: 12 }}>
            <button type="submit" disabled={creating || !amountBu || amountBu > balance}>
              [ {creating ? 'creating...' : 'create claim'} ]
            </button>
          </div>
          {createError && <div className="error" style={{ marginTop: 8 }}>error: {createError}</div>}
        </form>

        {created && (
          <div style={{ marginTop: 20, borderTop: '1px solid var(--dim)', paddingTop: 16 }}>
            <div style={{ color: 'var(--accent)', marginBottom: 8 }}>
              claim created — {formatRpow(created.amount_base_units)} RPOW locked
              {created.memo && <> · memo: &ldquo;{created.memo}&rdquo;</>}
            </div>

            <div style={{ marginBottom: 8, fontSize: 12 }}>
              <strong>Redeem link:</strong>{' '}
              <code style={{ wordBreak: 'break-all', fontSize: 11 }}>{redeemUrl(created.claim_id)}</code>{' '}
              <CopyButton text={redeemUrl(created.claim_id)} />
            </div>

            <div style={{ marginBottom: 8, fontSize: 12 }}>
              <strong>Claim ID:</strong>{' '}
              <code style={{ fontSize: 11 }}>{created.claim_id}</code>{' '}
              <CopyButton text={created.claim_id} />
            </div>

            {qrDataUrl && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--dim)', marginBottom: 6 }}>
                  QR code (scan to open redeem page):
                </div>
                <img
                  src={qrDataUrl}
                  alt="claim QR code"
                  style={{ display: 'block', imageRendering: 'pixelated', width: 160, height: 160 }}
                />
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              <button type="button" onClick={() => setCreated(null)} style={{ fontSize: 11 }}>
                [ create another ]
              </button>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="YOUR PENDING CLAIMS">
        {loadingClaims ? (
          <div style={{ color: 'var(--dim)' }}>loading…</div>
        ) : pendingClaims.length === 0 ? (
          <div style={{ color: 'var(--dim)', fontSize: 12 }}>no pending claims.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--dim)', textAlign: 'left' }}>
                <th style={{ paddingBottom: 6, fontWeight: 'normal' }}>amount</th>
                <th style={{ paddingBottom: 6, fontWeight: 'normal' }}>memo</th>
                <th style={{ paddingBottom: 6, fontWeight: 'normal' }}>created</th>
                <th style={{ paddingBottom: 6, fontWeight: 'normal' }}>link</th>
                <th style={{ paddingBottom: 6, fontWeight: 'normal' }}></th>
              </tr>
            </thead>
            <tbody>
              {pendingClaims.map((c) => (
                <tr key={c.claim_id} style={{ borderTop: '1px solid var(--dim)' }}>
                  <td style={{ padding: '6px 8px 6px 0' }}>
                    <strong>{formatRpow(c.amount_base_units)}</strong>
                  </td>
                  <td style={{ padding: '6px 8px', color: c.memo ? 'var(--fg)' : 'var(--dim)' }}>
                    {c.memo ?? '—'}
                  </td>
                  <td style={{ padding: '6px 8px', color: 'var(--dim)' }}>
                    {new Date(c.created_at).toLocaleString()}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <Link to={`/redeem/${c.claim_id}`} style={{ fontSize: 11 }}>[ open ]</Link>
                    {' '}
                    <CopyButton text={redeemUrl(c.claim_id)} label="copy link" />
                  </td>
                  <td style={{ padding: '6px 0 6px 8px' }}>
                    <button
                      type="button"
                      disabled={cancellingId === c.claim_id}
                      onClick={() => handleCancel(c.claim_id, c.amount_base_units)}
                      style={{ fontSize: 11, color: 'var(--accent)' }}
                    >
                      [ {cancellingId === c.claim_id ? 'cancelling…' : 'cancel'} ]
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {pastClaims.length > 0 && (
        <Panel title="PAST CLAIMS">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--dim)', textAlign: 'left' }}>
                <th style={{ paddingBottom: 6, fontWeight: 'normal' }}>amount</th>
                <th style={{ paddingBottom: 6, fontWeight: 'normal' }}>memo</th>
                <th style={{ paddingBottom: 6, fontWeight: 'normal' }}>status</th>
                <th style={{ paddingBottom: 6, fontWeight: 'normal' }}>date</th>
              </tr>
            </thead>
            <tbody>
              {pastClaims.map((c) => (
                <tr key={c.claim_id} style={{ borderTop: '1px solid var(--dim)' }}>
                  <td style={{ padding: '6px 8px 6px 0' }}>{formatRpow(c.amount_base_units)}</td>
                  <td style={{ padding: '6px 8px', color: c.memo ? 'var(--fg)' : 'var(--dim)' }}>
                    {c.memo ?? '—'}
                  </td>
                  <td style={{ padding: '6px 8px', color: c.state === 'redeemed' ? 'var(--accent)' : 'var(--dim)' }}>
                    {c.state}
                  </td>
                  <td style={{ padding: '6px 8px', color: 'var(--dim)' }}>
                    {new Date(c.redeemed_at ?? c.cancelled_at ?? c.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}
