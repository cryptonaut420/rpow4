import { useEffect, useRef, useState } from 'react';
import { useWallet } from '../wallet/WalletProvider.js';
import type { WalletKind } from '../wallet/store.js';
import { CopyButton } from './CopyButton.js';

const AUTO_HIDE_MS = 60_000;

interface Revealed {
  plaintext: string;
  kind: WalletKind;
}

/**
 * Inline, in-place backup panel for the Wallet page. Three states:
 *
 *   - collapsed   : just a "Show backup" affordance + warning copy
 *   - prompting   : password input
 *   - revealed    : numbered word list (or private key), copy button,
 *                   auto-hides after 60s
 *
 * Never shown for session-only wallets (meta === null while signed in
 * means the secret was never persisted to IndexedDB and isn't recoverable
 * from this device — back up by importing into another tool while still
 * unlocked).
 */
export function WalletBackupPanel() {
  const wallet = useWallet();
  const [stage, setStage] = useState<'collapsed' | 'prompting' | 'revealed'>('collapsed');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => () => { if (hideTimer.current) window.clearTimeout(hideTimer.current); }, []);

  function hide() {
    if (hideTimer.current) { window.clearTimeout(hideTimer.current); hideTimer.current = null; }
    setRevealed(null);
    setPassword('');
    setError('');
    setStage('collapsed');
  }

  async function reveal() {
    setError(''); setBusy(true);
    try {
      const r = await wallet.revealSecret(password);
      setRevealed(r);
      setPassword('');
      setStage('revealed');
      hideTimer.current = window.setTimeout(hide, AUTO_HIDE_MS);
    } catch (e: any) {
      setError(e?.message ?? 'failed');
    } finally {
      setBusy(false);
    }
  }

  // Three states the backup panel can be in:
  //   1. No persisted blob, no in-memory secret  → nothing to back up
  //      from this device. Tell the user.
  //   2. No persisted blob, but volatile secret  → fresh signup with no
  //      password. Offer no-password reveal; remind them session ends
  //      on tab close.
  //   3. Persisted blob                          → password-gated reveal
  //      (existing behavior).
  const sessionOnly = !wallet.meta;
  const canRevealVolatile = sessionOnly && wallet.hasVolatileSecret;

  if (sessionOnly && !canRevealVolatile) {
    return (
      <div style={{ color: 'var(--dim)', fontSize: 12 }}>
        no encrypted backup on this device — wallet was unlocked from
        another source. import the same mnemonic / private key elsewhere
        if you want a recoverable copy.
      </div>
    );
  }

  async function revealVolatile() {
    setError(''); setBusy(true);
    try {
      // password is ignored by revealSecret() in the volatile branch.
      const r = await wallet.revealSecret('');
      setRevealed(r);
      setStage('revealed');
      hideTimer.current = window.setTimeout(hide, AUTO_HIDE_MS);
    } catch (e: any) {
      setError(e?.message ?? 'failed');
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'collapsed') {
    return (
      <div>
        <button onClick={canRevealVolatile ? revealVolatile : () => setStage('prompting')} disabled={busy}>
          [ show backup ]
        </button>{' '}
        <span style={{ color: 'var(--dim)', fontSize: 12 }}>
          {canRevealVolatile
            ? 'this wallet is session-only — back it up before closing the tab'
            : 'requires your wallet password — re-derives the seed from local encrypted storage'}
        </span>
        {error && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
      </div>
    );
  }

  if (stage === 'prompting') {
    return (
      <div>
        <div style={{ marginBottom: 6, color: 'var(--dim)', fontSize: 12 }}>
          enter the password you set when creating / importing this wallet.
        </div>
        <div>
          PASSWORD : <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: '36ch' }}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && password && !busy) reveal(); }}
          />
        </div>
        <div style={{ marginTop: 8 }}>
          <button onClick={reveal} disabled={busy || !password}>[ {busy ? '...' : 'reveal'} ]</button>{' '}
          <button onClick={hide} disabled={busy}>[ cancel ]</button>
        </div>
        {error && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 6, color: 'var(--error)', fontSize: 12 }}>
        anyone with these {revealed!.kind === 'mnemonic' ? 'words' : 'bytes'} controls
        your account. write them down offline. do not paste into a website,
        chat, or password manager you don't trust. this panel auto-hides in
        60 seconds.
      </div>
      {revealed!.kind === 'mnemonic' ? (
        <MnemonicReveal mnemonic={revealed!.plaintext} />
      ) : (
        <PrivateKeyReveal privateKey={revealed!.plaintext} />
      )}
      <div style={{ marginTop: 10 }}>
        <CopyButton text={revealed!.plaintext} label="copy" />{' '}
        <button onClick={hide}>[ hide ]</button>
      </div>
    </div>
  );
}

function MnemonicReveal({ mnemonic }: { mnemonic: string }) {
  const words = mnemonic.trim().split(/\s+/);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: '4px 16px',
        background: 'rgba(255,255,255,0.025)',
        border: '1px dashed var(--accent-dim)',
        padding: 12,
        fontFamily: 'inherit',
      }}
    >
      {words.map((w, i) => (
        <div key={i} style={{ display: 'flex', gap: 6 }}>
          <span style={{ color: 'var(--dim)', minWidth: '2.5ch', textAlign: 'right' }}>{i + 1}.</span>
          <span>{w}</span>
        </div>
      ))}
    </div>
  );
}

function PrivateKeyReveal({ privateKey }: { privateKey: string }) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.025)',
        border: '1px dashed var(--accent-dim)',
        padding: 12,
        fontFamily: 'inherit',
        wordBreak: 'break-all',
      }}
    >
      {privateKey}
    </div>
  );
}
