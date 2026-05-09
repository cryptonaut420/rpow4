import { useState } from 'react';
import {
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  validateDisplayName,
} from '@rpow/shared';
import { api } from '../api.js';
import { useWallet } from '../wallet/WalletProvider.js';

interface Props {
  /** Current display name from `/me` (null if unset). */
  current: string | null;
  /** Called after a successful set/clear so the parent can refresh `/me`. */
  onChanged: () => void;
}

/**
 * Inline editor for the optional account display name. Two modes:
 *   - viewing: shows the current handle (or "(none)") with an "edit" button
 *   - editing: text input + save / clear / cancel buttons
 *
 * The body is signed under canonical action `account.set_display_name`.
 * Server enforces uniqueness (case-insensitive) and charset; we mirror the
 * length/charset rules client-side for fast feedback.
 */
export function DisplayNameEditor({ current, onChanged }: Props) {
  const wallet = useWallet();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function startEdit() {
    setValue(current ?? '');
    setError('');
    setEditing(true);
  }
  function cancel() {
    setEditing(false);
    setValue(current ?? '');
    setError('');
  }

  async function save(target: string | null) {
    setError(''); setBusy(true);
    try {
      const body = { display_name: target };
      const sig = wallet.sign('account.set_display_name', body);
      await api.setDisplayName({ ...body, client_signature_base58: sig });
      setEditing(false);
      onChanged();
    } catch (e: any) {
      const code = e?.error ?? 'INTERNAL';
      const msgs: Record<string, string> = {
        NAME_TAKEN: 'that name is already taken',
        BAD_REQUEST: e?.message ?? 'invalid name',
        INVALID_SIGNATURE: 'wallet signature did not verify (try unlocking again)',
        UNAUTHORIZED: 'session expired — sign in again',
      };
      setError(msgs[code] ?? `${code}${e?.message ? `: ${e.message}` : ''}`);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const trimmed = value.trim();
    if (trimmed === '') {
      // Empty input while editing means "clear it" — send null.
      await save(null);
      return;
    }
    const v = validateDisplayName(trimmed);
    if (!v.ok) { setError(v.message); return; }
    await save(v.normalized);
  }

  if (!editing) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--dim)' }}>HANDLE :</span>
        {current ? <code>{current}</code> : <span style={{ color: 'var(--dim)' }}>(none)</span>}
        <button onClick={startEdit}>[ {current ? 'edit' : 'set' } ]</button>
        {current && (
          <button onClick={() => save(null)} disabled={busy} title="remove your handle (others will only see your pubkey)">
            [ clear ]
          </button>
        )}
      </div>
    );
  }

  const sameAsCurrent = (value.trim() || null) === current;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--dim)' }}>HANDLE :</span>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={`${DISPLAY_NAME_MIN}-${DISPLAY_NAME_MAX} chars: a-z 0-9 . _ - @`}
          style={{ width: '32ch' }}
          autoFocus
          maxLength={DISPLAY_NAME_MAX}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) submit();
            if (e.key === 'Escape' && !busy) cancel();
          }}
        />
        <button onClick={submit} disabled={busy || sameAsCurrent}>[ {busy ? '...' : 'save'} ]</button>
        <button onClick={cancel} disabled={busy}>[ cancel ]</button>
      </div>
      <div style={{ color: 'var(--dim)', fontSize: 12, marginTop: 4 }}>
        optional, case-insensitively unique. anyone can send to you using
        this handle instead of your full pubkey. clear it any time.
      </div>
      {error && <div className="error" style={{ marginTop: 6 }}>error: {error}</div>}
    </div>
  );
}
