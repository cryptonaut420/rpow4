import { useState } from 'react';
import { Panel } from './Panel.js';
import { PasswordPair } from './PasswordPair.js';
import { useWallet } from '../wallet/WalletProvider.js';

const MIN_PASSWORD = 4;

/**
 * Inline panel surfaced at the top of the Wallet page when the user is
 * signed in with a session-only wallet (no encrypted blob in IndexedDB)
 * but we still hold the secret in memory from this session's signup /
 * import. Lets them upgrade to encrypted persistence in one step
 * without re-entering their seed.
 *
 * Hidden when (a) a persisted blob already exists, (b) we have nothing
 * to save (volatile secret missing — e.g. wallet was unlocked from
 * storage), or (c) the user dismissed it for this session.
 */
export function SaveWalletPrompt() {
  const wallet = useWallet();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState(false);

  if (wallet.meta || !wallet.hasVolatileSecret || dismissed) return null;

  async function save() {
    setError('');
    if (password.length < MIN_PASSWORD) {
      setError(`use at least ${MIN_PASSWORD} characters`); return;
    }
    if (password !== confirm) { setError("passwords don't match"); return; }
    setBusy(true);
    try {
      await wallet.persistVolatileSecret(password);
      // Clear local state so the form doesn't briefly flash before the
      // outer `meta` update unmounts us.
      setPassword(''); setConfirm('');
    } catch (e: any) {
      setError(e?.message ?? 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="SAVE THIS WALLET">
      <div style={{ color: 'var(--dim)', fontSize: 12, marginBottom: 10 }}>
        right now this wallet only lives in this browser tab. closing the
        tab will sign you out, and you'll need your recovery phrase to
        get back in. set a password to keep it on this device.
      </div>
      <PasswordPair
        password={password}
        setPassword={setPassword}
        confirm={confirm}
        setConfirm={setConfirm}
        helperText="we'll encrypt your wallet locally with this password. nothing leaves this device."
        onSubmit={save}
      />
      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={save}
          disabled={busy || !password || password !== confirm}
        >
          [ {busy ? '...' : 'SAVE WALLET'} ]
        </button>
        <button className="link-button" onClick={() => setDismissed(true)} disabled={busy}>
          [ remind me later ]
        </button>
      </div>
      {error && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
    </Panel>
  );
}
