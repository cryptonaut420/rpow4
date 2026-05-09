import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { CopyButton } from '../components/CopyButton.js';
import { api } from '../api.js';
import { useMe } from '../hooks/useMe.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { formatRpow, parseRpowToBaseUnits } from '../lib/format.js';
import { isValidPubkeyBase58, shortPubkey, validateDisplayName } from '@rpow/shared';
import type { LedgerResponse, SendRequestBody } from '@rpow/shared';

type Resolution =
  | { kind: 'idle' }
  | { kind: 'looking-up' }
  | { kind: 'pubkey'; pubkey: string }                              // typed value already a pubkey
  | { kind: 'handle'; pubkey: string; display_name: string }        // typed handle resolved to a pubkey
  | { kind: 'unknown-handle' }
  | { kind: 'invalid' };

export function SendPage() {
  const wallet = useWallet();
  const { me, refresh } = useMe();
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('1');
  const [memo, setMemo] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const [transferId, setTransferId] = useState('');
  const [sentFee, setSentFee] = useState('');
  const [sentTo, setSentTo] = useState<{ pubkey: string; display_name: string | null } | null>(null);
  const [sentAmt, setSentAmt] = useState('');
  const [resolution, setResolution] = useState<Resolution>({ kind: 'idle' });
  const lookupAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.ledger().then((l) => { if (!cancelled) setLedger(l); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Debounced resolution: if the user types a pubkey we can use it directly;
  // if they type something that looks like a handle we hit /lookup/:name.
  useEffect(() => {
    lookupAbort.current?.abort();
    const trimmed = recipient.trim();
    if (trimmed === '') { setResolution({ kind: 'idle' }); return; }
    if (isValidPubkeyBase58(trimmed)) { setResolution({ kind: 'pubkey', pubkey: trimmed }); return; }
    const handleCheck = validateDisplayName(trimmed);
    if (!handleCheck.ok) { setResolution({ kind: 'invalid' }); return; }
    setResolution({ kind: 'looking-up' });
    const ctrl = new AbortController();
    lookupAbort.current = ctrl;
    const t = window.setTimeout(async () => {
      try {
        const r = await api.lookup(handleCheck.normalized);
        if (ctrl.signal.aborted) return;
        setResolution({ kind: 'handle', pubkey: r.pubkey, display_name: r.display_name });
      } catch (e: any) {
        if (ctrl.signal.aborted) return;
        if (e?.error === 'NAME_NOT_FOUND') setResolution({ kind: 'unknown-handle' });
        else setResolution({ kind: 'invalid' });
      }
    }, 250);
    return () => { window.clearTimeout(t); ctrl.abort(); };
  }, [recipient]);

  if (wallet.status !== 'unlocked' || !me) {
    return (
      <Panel title="SEND">
        <div>not signed in.</div>
        <div style={{ marginTop: 8 }}>
          <Link to="/login">[ {wallet.status === 'locked' ? 'unlock wallet' : 'create or import wallet'} ]</Link>
        </div>
      </Panel>
    );
  }

  const balance = BigInt(me.balance_base_units);
  const balanceDisplay = formatRpow(me.balance_base_units);

  const resolvedPubkey: string | null =
    resolution.kind === 'pubkey' ? resolution.pubkey :
    resolution.kind === 'handle' ? resolution.pubkey : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!me) return;
    setStatus('sending'); setError('');

    if (!resolvedPubkey) {
      setStatus('error');
      setError(
        resolution.kind === 'unknown-handle'
          ? 'no account with that handle — double-check the spelling, or paste their pubkey instead'
          : resolution.kind === 'looking-up'
            ? 'still looking up that handle — try again in a moment'
            : 'recipient must be a base58 pubkey or a registered handle',
      );
      return;
    }
    if (resolvedPubkey === me.pubkey) {
      setStatus('error');
      setError('cannot send to yourself');
      return;
    }

    let amount_base_units: string;
    try {
      amount_base_units = parseRpowToBaseUnits(amount);
    } catch {
      setStatus('error');
      setError('amount must be a positive number with up to 9 decimal places');
      return;
    }
    if (BigInt(amount_base_units) <= 0n) {
      setStatus('error');
      setError('amount must be greater than zero');
      return;
    }
    if (BigInt(amount_base_units) > balance) {
      setStatus('error');
      setError(`amount exceeds your balance of ${balanceDisplay} RPOW`);
      return;
    }

    const idempotency_key = crypto.randomUUID();
    const trimmedMemo = memo.trim();
    if (trimmedMemo.length > 64) {
      setStatus('error');
      setError('memo must be 64 characters or fewer');
      return;
    }
    // Build the signable body (the part the wallet signs, before the sig field).
    const sigBody: Record<string, string> = { recipient_pubkey: resolvedPubkey, amount_base_units, idempotency_key };
    if (trimmedMemo) sigBody.memo = trimmedMemo;

    try {
      const r = await api.send({
        ...sigBody,
        client_signature_base58: wallet.sign('transfer', sigBody),
      } as SendRequestBody);
      setStatus('sent');
      setTransferId(r.transfer_id);
      setSentFee(r.fee_base_units);
      setSentTo({
        pubkey: r.recipient_pubkey,
        display_name: resolution.kind === 'handle' ? resolution.display_name : null,
      });
      setSentAmt(formatRpow(r.transferred_base_units));
      setMemo('');
      await refresh();
    } catch (err: any) {
      setStatus('error');
      const code = err?.error ?? 'INTERNAL';
      const msgs: Record<string, string> = {
        INSUFFICIENT_BALANCE: 'not enough tokens in your wallet',
        EXACT_SUM_REQUIRED:
          err?.message ?? 'no token combination matches that exact amount — try mining a smaller token first or sending a different amount',
        BAD_REQUEST: err?.message ?? 'bad request',
        INVALID_SIGNATURE: 'wallet signature did not verify (try unlocking again)',
        UNAUTHORIZED: 'session expired — sign in again',
      };
      setError(msgs[code] ?? `${code}${err?.message ? `: ${err.message}` : ''}`);
    }
  }

  return (
    <>
      <Panel title="SEND">
        <div style={{ marginBottom: 12, color: 'var(--dim)', fontSize: 12 }}>
          your balance is{' '}
          <strong style={{ color: 'var(--fg)' }}>{balanceDisplay} RPOW</strong>.
          you can address the recipient by their full pubkey or by their handle.
          {ledger && (
            <> a <strong style={{ color: 'var(--fg)' }}>{formatRpow(ledger.current_fee_base_units)} RPOW</strong> network
            fee is deducted from your balance in addition to the amount.</>
          )}
        </div>
        <form onSubmit={submit}>
          <div>
            TO     : <input
              type="text"
              required
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="recipient pubkey or handle (e.g. alice)"
              style={{ width: '50ch', fontFamily: 'inherit' }}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <div style={{ marginTop: 4, minHeight: 18 }}>
            <RecipientHint resolution={resolution} />
          </div>
          <div style={{ marginTop: 6 }}>
            AMOUNT : <input
              type="text"
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{ width: '14ch' }}
            /> RPOW
          </div>
          <div style={{ marginTop: 6 }}>
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
            <button type="submit" disabled={status === 'sending' || resolution.kind === 'looking-up'}>
              [ {status === 'sending' ? 'sending...' : 'SEND'} ]
            </button>
          </div>
        </form>
        {status === 'sent' && sentTo && (
          <div style={{ marginTop: 12 }}>
            <div style={{ color: 'var(--accent)' }}>
              sent {sentAmt} RPOW → <code>{sentTo.display_name ?? sentTo.pubkey}</code>
            </div>
            <div style={{ color: 'var(--dim)', fontSize: 12, marginTop: 4 }}>
              {sentTo.display_name && <>recipient pubkey: <code>{sentTo.pubkey}</code><br /></>}
              {sentFee !== '0' && <>fee: {formatRpow(sentFee)} RPOW<br /></>}
              transfer id: <code>{transferId}</code>{' '}
              <CopyButton text={transferId} />
            </div>
          </div>
        )}
        {status === 'error' && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
      </Panel>

      <Panel title="YOUR PUBKEY / HANDLE">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--dim)' }}>HANDLE :</span>
          {me.display_name ? (
            <>
              <code>{me.display_name}</code>
              <CopyButton text={me.display_name} />
            </>
          ) : (
            <>
              <span style={{ color: 'var(--dim)' }}>(none)</span>
              <Link to="/">[ set one ]</Link>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
          <span style={{ color: 'var(--dim)' }}>PUBKEY :</span>
          <code style={{ wordBreak: 'break-all' }}>{me.pubkey}</code>
          <CopyButton text={me.pubkey} />
        </div>
        <div style={{ color: 'var(--dim)', fontSize: 12, marginTop: 6 }}>
          share either with anyone who wants to send you RPOW.
        </div>
      </Panel>
    </>
  );
}

function RecipientHint({ resolution }: { resolution: Resolution }) {
  switch (resolution.kind) {
    case 'idle': return null;
    case 'looking-up': return <span style={{ color: 'var(--dim)', fontSize: 12 }}>looking up handle…</span>;
    case 'pubkey':
      return <span style={{ color: 'var(--accent)', fontSize: 12 }}>✓ valid pubkey ({shortPubkey(resolution.pubkey)})</span>;
    case 'handle':
      return (
        <span style={{ color: 'var(--accent)', fontSize: 12 }} title={resolution.pubkey}>
          ✓ <code>{resolution.display_name}</code> → <code>{shortPubkey(resolution.pubkey)}</code>
        </span>
      );
    case 'unknown-handle':
      return <span className="error" style={{ fontSize: 12 }}>no account with that handle</span>;
    case 'invalid':
      return <span className="error" style={{ fontSize: 12 }}>not a valid pubkey or handle</span>;
  }
}
