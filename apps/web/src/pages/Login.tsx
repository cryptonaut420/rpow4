import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { CopyButton } from '../components/CopyButton.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { useMe } from '../hooks/useMe.js';
import {
  generateMnemonic,
  mnemonicToKeypair,
  signCanonical,
  shortPubkey,
  validateDisplayName,
  type RpowKeypair,
} from '@rpow/shared';
import { api } from '../api.js';
import { expectedSecondsAt, formatDuration, formatHashrate } from '../lib/hashrate.js';

type AdvancedTab = 'create' | 'import-mnemonic' | 'import-key' | 'unlock';

export function LoginPage() {
  const wallet = useWallet();
  const { me, refresh } = useMe();
  const nav = useNavigate();
  const [mode, setMode] = useState<'simple' | 'advanced'>(
    wallet.status === 'locked' ? 'advanced' : 'simple',
  );

  if (wallet.status === 'unlocked' && me) {
    return (
      <Panel title="WALLET">
        <div>
          signed in as{' '}
          <code>{me.display_name ?? shortPubkey(me.pubkey)}</code>.
        </div>
        <div style={{ marginTop: 8 }}>
          <Link to="/">[ wallet ]</Link>{' '}
          <Link to="/mine">[ mine ]</Link>{' '}
          <Link to="/send">[ send ]</Link>{' '}
          <Link to="/activity">[ activity ]</Link>
        </div>
      </Panel>
    );
  }

  async function onDone() {
    await refresh();
    nav('/');
  }

  return (
    <Panel title={mode === 'simple' ? 'CREATE ACCOUNT' : 'WALLET (advanced)'}>
      {mode === 'simple' ? (
        <SimpleSignup onDone={onDone} />
      ) : (
        <AdvancedTabs onDone={onDone} />
      )}
      <div style={{ marginTop: 16, paddingTop: 8, borderTop: '1px dashed var(--accent-dim)' }}>
        {mode === 'simple' ? (
          <button className="link-button" onClick={() => setMode('advanced')}>
            [ already have an account? sign in &rarr; ]
          </button>
        ) : (
          <button className="link-button" onClick={() => setMode('simple')}>
            [ &larr; back to create account ]
          </button>
        )}
      </div>
    </Panel>
  );
}

// ─── simple (default) signup ────────────────────────────────────────────────

type Availability =
  | { state: 'idle' }
  | { state: 'invalid'; message: string }
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'taken' };

type SimpleStep =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'mining'; hps: number; hashes: number; elapsed_ms: number; difficulty_bits: number; etaSeconds: number }
  | { kind: 'submitting' }
  | { kind: 'done' };

function SimpleSignup({ onDone }: { onDone: () => void }) {
  const wallet = useWallet();
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [step, setStep] = useState<SimpleStep>({ kind: 'idle' });
  const [error, setError] = useState('');
  const workerRef = useRef<Worker | null>(null);

  // Stop any in-flight worker on unmount.
  useEffect(() => () => { workerRef.current?.terminate(); workerRef.current = null; }, []);

  // Live availability check on the handle input. Debounced so we don't
  // spam /lookup; bypassed for syntactically-invalid input. The result
  // is purely a UX hint — server enforces uniqueness atomically at
  // signup-time regardless.
  const handleValidation = useMemo(() => validateDisplayName(handle), [handle]);
  const [availability, setAvailability] = useState<Availability>({ state: 'idle' });

  useEffect(() => {
    if (!handle) { setAvailability({ state: 'idle' }); return; }
    if (!handleValidation.ok) {
      setAvailability({ state: 'invalid', message: handleValidation.message });
      return;
    }
    setAvailability({ state: 'checking' });
    const target = handleValidation.normalized;
    const t = window.setTimeout(async () => {
      try {
        await api.lookup(target);
        // 200 = a row exists for that name → taken.
        setAvailability((prev) => prev.state === 'checking' ? { state: 'taken' } : prev);
      } catch (e: any) {
        if (e?.error === 'NAME_NOT_FOUND') {
          setAvailability((prev) => prev.state === 'checking' ? { state: 'available' } : prev);
        } else {
          setAvailability({ state: 'idle' });
        }
      }
    }, 350);
    return () => window.clearTimeout(t);
  }, [handle, handleValidation]);

  const passwordsMatch = password === confirm;
  const canSubmit =
    handleValidation.ok &&
    availability.state !== 'taken' &&
    availability.state !== 'invalid' &&
    passwordsMatch &&
    step.kind === 'idle';

  async function startSignup() {
    setError('');
    if (!handleValidation.ok) { setError(handleValidation.message); return; }
    if (!passwordsMatch) { setError("passwords don't match"); return; }

    setStep({ kind: 'starting' });

    const mnemonic = generateMnemonic();
    const kp = mnemonicToKeypair(mnemonic);

    let challenge;
    try {
      challenge = await api.signupChallenge({ handle: handleValidation.normalized, pubkey: kp.publicKeyBase58 });
    } catch (e: any) {
      setStep({ kind: 'idle' });
      if (e?.error === 'NAME_TAKEN') {
        setAvailability({ state: 'taken' });
        setError('that name was just taken — try another');
      } else {
        setError(e?.message ?? 'failed to start signup');
      }
      return;
    }

    const w = new Worker(new URL('../miner.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = w;

    setStep({
      kind: 'mining',
      hps: 0,
      hashes: 0,
      elapsed_ms: 0,
      difficulty_bits: challenge.envelope.difficulty_bits,
      etaSeconds: Infinity,
    });

    let solution_nonce: string;
    try {
      solution_nonce = await new Promise<string>((resolve, reject) => {
        w.onmessage = (e: MessageEvent<any>) => {
          const m = e.data;
          if (m.type === 'progress') {
            const hashes = Number(m.hashes);
            const elapsed = Number(m.elapsed_ms);
            const hps = elapsed > 0 ? Math.round((hashes / elapsed) * 1000) : 0;
            setStep({
              kind: 'mining',
              hps,
              hashes,
              elapsed_ms: elapsed,
              difficulty_bits: challenge.envelope.difficulty_bits,
              etaSeconds: hps > 0 ? expectedSecondsAt(challenge.envelope.difficulty_bits, hps) : Infinity,
            });
          } else if (m.type === 'found') {
            resolve(String(m.solution_nonce));
          } else if (m.type === 'aborted') {
            reject(new Error('aborted'));
          }
        };
        w.postMessage({
          type: 'start',
          nonce_prefix: challenge.pow_prefix_hex,
          difficulty_bits: challenge.envelope.difficulty_bits,
        });
      });
    } finally {
      w.terminate();
      workerRef.current = null;
    }

    setStep({ kind: 'submitting' });

    const sig = signCanonical(
      'account.signup',
      {
        handle: challenge.envelope.handle,
        pubkey: challenge.envelope.pubkey,
        nonce: challenge.envelope.nonce,
      },
      kp.secretKey,
    );

    try {
      await api.signup({
        envelope: challenge.envelope,
        envelope_mac: challenge.envelope_mac,
        solution_nonce,
        client_signature_base58: sig,
      });
    } catch (e: any) {
      setStep({ kind: 'idle' });
      if (e?.error === 'NAME_TAKEN') {
        setAvailability({ state: 'taken' });
        setError('that name was just taken — try another');
      } else {
        setError(e?.message ?? 'signup failed');
      }
      return;
    }

    // Server already issued the cookie. Adopt the keypair into wallet
    // context. Persistence is encrypted if a password was set, else
    // session-only (with the volatile-secret backup path on the wallet
    // page).
    try {
      await wallet.finalizeNewMnemonic(mnemonic, { password: password || undefined });
    } catch (e: any) {
      setError(`account created, but could not save wallet on this device: ${e?.message ?? e}`);
    }

    setStep({ kind: 'done' });
    onDone();
  }

  return (
    <>
      <div style={{ marginBottom: 10, color: 'var(--dim)', fontSize: 12 }}>
        pick a name. we'll create your account in this browser — no email,
        no password reset link, no central account database. a quick puzzle
        (~5–10s) keeps bots out.
      </div>

      <div style={{ marginTop: 12 }}>
        NAME &nbsp;&nbsp;&nbsp; :{' '}
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          style={{ width: '28ch' }}
          placeholder="3–32 chars"
          autoComplete="username"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={step.kind !== 'idle'}
          autoFocus
        />
        <AvailabilityHint a={availability} />
      </div>

      <div style={{ marginTop: 10 }}>
        PASSWORD :{' '}
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: '28ch' }}
          autoComplete="new-password"
          disabled={step.kind !== 'idle'}
        />
        <span style={{ marginLeft: 8, color: 'var(--dim)', fontSize: 12 }}>
          (optional — keeps you signed in across visits)
        </span>
      </div>
      {!!password && (
        <div style={{ marginTop: 4 }}>
          CONFIRM&nbsp; :{' '}
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            style={{ width: '28ch' }}
            autoComplete="new-password"
            disabled={step.kind !== 'idle'}
          />
          {!!confirm && !passwordsMatch && (
            <span className="error" style={{ marginLeft: 8, fontSize: 12 }}>passwords don't match</span>
          )}
        </div>
      )}
      <div style={{ marginTop: 6, color: 'var(--dim)', fontSize: 12 }}>
        {password
          ? 'your wallet will be encrypted with this password and stored on this device.'
          : 'leave the password blank to use this account in this browser tab only.'}
      </div>

      <div style={{ marginTop: 16 }}>
        {step.kind === 'idle' && (
          <button onClick={startSignup} disabled={!canSubmit}>
            [ CREATE ACCOUNT ]
          </button>
        )}
        {step.kind === 'starting' && <span>preparing...</span>}
        {step.kind === 'mining' && <ProgressBlock step={step} />}
        {step.kind === 'submitting' && <span>finalizing account...</span>}
        {step.kind === 'done' && <span>done!</span>}
      </div>

      {error && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
    </>
  );
}

function AvailabilityHint({ a }: { a: Availability }) {
  if (a.state === 'idle') return null;
  const styles: React.CSSProperties = { marginLeft: 8, fontSize: 12 };
  if (a.state === 'checking') return <span style={{ ...styles, color: 'var(--dim)' }}>checking…</span>;
  if (a.state === 'invalid') return <span className="error" style={styles}>{a.message}</span>;
  if (a.state === 'taken') return <span className="error" style={styles}>✗ taken</span>;
  return <span style={{ ...styles, color: 'var(--accent)' }}>✓ available</span>;
}

function ProgressBlock({ step }: { step: Extract<SimpleStep, { kind: 'mining' }> }) {
  // Estimate progress as elapsed/eta (capped 1.0). Geometric distribution:
  // expected attempts = 2^bits, so the running mean ETA is (2^bits - hashes)/hps.
  const fraction = step.etaSeconds > 0 && Number.isFinite(step.etaSeconds)
    ? Math.min(0.99, step.elapsed_ms / 1000 / (step.elapsed_ms / 1000 + step.etaSeconds))
    : 0;
  const bar = Math.round(fraction * 24);
  const barStr = '█'.repeat(bar) + '░'.repeat(24 - bar);

  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', padding: 10, border: '1px dashed var(--accent-dim)' }}>
      <div style={{ marginBottom: 6 }}>creating your account…</div>
      <div style={{ fontSize: 12, color: 'var(--dim)' }}>
        <div style={{ fontFamily: 'monospace' }}>[{barStr}]</div>
        <div style={{ marginTop: 4 }}>
          {step.hps > 0 ? `${formatHashrate(step.hps)} on this device · ` : ''}
          {(step.elapsed_ms / 1000).toFixed(1)}s elapsed
          {Number.isFinite(step.etaSeconds) ? ` · ~${formatDuration(Math.max(0, step.etaSeconds - step.elapsed_ms / 1000))} left` : ''}
        </div>
      </div>
    </div>
  );
}

// ─── advanced tabs (existing power-user flows) ──────────────────────────────

function AdvancedTabs({ onDone }: { onDone: () => void }) {
  const wallet = useWallet();
  const initial: AdvancedTab = wallet.status === 'locked' ? 'unlock' : 'import-mnemonic';
  const [tab, setTab] = useState<AdvancedTab>(initial);
  function tabClass(t: AdvancedTab) { return tab === t ? 'tab active' : 'tab'; }

  return (
    <>
      <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {wallet.status === 'locked' && (
          <button onClick={() => setTab('unlock')} className={tabClass('unlock')}>[ unlock ]</button>
        )}
        <button onClick={() => setTab('import-mnemonic')} className={tabClass('import-mnemonic')}>[ recovery phrase ]</button>
        <button onClick={() => setTab('import-key')} className={tabClass('import-key')}>[ private key ]</button>
        <button onClick={() => setTab('create')} className={tabClass('create')}>[ create from seed ]</button>
      </div>
      <div style={{ color: 'var(--dim)', fontSize: 12, marginBottom: 8 }}>
        sign in with an existing recovery phrase or private key. you can
        pick a name later from the wallet page.
      </div>
      {tab === 'create' && <CreateTab onDone={onDone} />}
      {tab === 'import-mnemonic' && <ImportMnemonicTab onDone={onDone} />}
      {tab === 'import-key' && <ImportPrivateKeyTab onDone={onDone} />}
      {tab === 'unlock' && <UnlockTab onDone={onDone} />}
    </>
  );
}

async function authenticate(kp: RpowKeypair): Promise<void> {
  const ch = await api.authChallenge({ pubkey: kp.publicKeyBase58 });
  const sig = signCanonical('auth.session', ch.envelope, kp.secretKey);
  await api.authSession({
    envelope: ch.envelope,
    envelope_mac: ch.envelope_mac,
    signature_base58: sig,
  });
}

function PasswordRow({
  password, setPassword, confirm, setConfirm,
}: {
  password: string;
  setPassword: (s: string) => void;
  confirm: string;
  setConfirm: (s: string) => void;
}) {
  const mismatch = !!confirm && confirm !== password;
  return (
    <>
      <div>
        PASSWORD : <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '32ch' }} autoComplete="new-password" />
      </div>
      {!!password && (
        <div>
          CONFIRM&nbsp; : <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ width: '32ch' }} autoComplete="new-password" />
          {mismatch && <span className="error" style={{ marginLeft: 8, fontSize: 12 }}>passwords don't match</span>}
        </div>
      )}
      <div style={{ marginTop: 4, color: 'var(--dim)', fontSize: 12 }}>
        encrypts your wallet on this device. leave blank to use it in
        this tab only — closing the tab will sign you out.
      </div>
    </>
  );
}

function CreateTab({ onDone }: { onDone: () => void }) {
  const wallet = useWallet();
  const [mnemonic, setMnemonic] = useState<string>(() => wallet.createNewMnemonic());
  const [confirmed, setConfirmed] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setConfirmed(false); }, [mnemonic]);

  async function finish() {
    setError('');
    if (password !== confirm) { setError('passwords do not match'); return; }
    setBusy(true);
    try {
      const kp = await wallet.finalizeNewMnemonic(mnemonic, { password: password || undefined });
      await authenticate(kp);
      onDone();
    } catch (e: any) {
      setError(e?.message ?? 'failed');
    } finally {
      setBusy(false);
    }
  }

  const words = mnemonic.trim().split(/\s+/);

  return (
    <>
      <div style={{ marginBottom: 8, color: 'var(--dim)', fontSize: 12 }}>
        write these words down somewhere safe. they're the only way to
        recover this account — there's no email reset and no support
        line. anyone with these words controls your account.
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: '4px 16px',
          background: 'rgba(255,255,255,0.025)',
          border: '1px dashed var(--accent-dim)',
          padding: 12,
        }}
      >
        {words.map((w, i) => (
          <div key={i} style={{ display: 'flex', gap: 6 }}>
            <span style={{ color: 'var(--dim)', minWidth: '2.5ch', textAlign: 'right' }}>{i + 1}.</span>
            <span>{w}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => setMnemonic(wallet.createNewMnemonic())} disabled={busy}>[ regenerate ]</button>
        <CopyButton text={mnemonic} label="copy phrase" />
        <label style={{ marginLeft: 8 }}>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          {' '}I have written these down
        </label>
      </div>
      <div style={{ marginTop: 16 }}>
        <PasswordRow password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
      </div>
      <div style={{ marginTop: 12 }}>
        <button onClick={finish} disabled={!confirmed || busy}>[ {busy ? '...' : 'CREATE WALLET'} ]</button>
      </div>
      {error && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
    </>
  );
}

function ImportMnemonicTab({ onDone }: { onDone: () => void }) {
  const wallet = useWallet();
  const [mnemonic, setMnemonic] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function finish() {
    setError('');
    if (password !== confirm) { setError('passwords do not match'); return; }
    setBusy(true);
    try {
      const kp = await wallet.importMnemonic(mnemonic, { password: password || undefined });
      await authenticate(kp);
      onDone();
    } catch (e: any) {
      setError(e?.message ?? 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div>
        PHRASE : <textarea
          value={mnemonic}
          onChange={(e) => setMnemonic(e.target.value)}
          rows={3}
          style={{ width: '60ch', display: 'block', marginTop: 4 }}
          placeholder="paste your 12 or 24 recovery words"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      <div style={{ marginTop: 8 }}>
        <PasswordRow password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
      </div>
      <div style={{ marginTop: 12 }}>
        <button onClick={finish} disabled={busy || !mnemonic.trim()}>[ {busy ? '...' : 'SIGN IN'} ]</button>
      </div>
      {error && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
    </>
  );
}

function ImportPrivateKeyTab({ onDone }: { onDone: () => void }) {
  const wallet = useWallet();
  const [pk, setPk] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function finish() {
    setError('');
    if (password !== confirm) { setError('passwords do not match'); return; }
    setBusy(true);
    try {
      const kp = await wallet.importPrivateKey(pk, { password: password || undefined });
      await authenticate(kp);
      onDone();
    } catch (e: any) {
      setError(e?.message ?? 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div>
        PRIVATE KEY : <input
          value={pk}
          onChange={(e) => setPk(e.target.value)}
          style={{ width: '60ch' }}
          placeholder="paste a base58 secret key or 32-byte hex seed"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      <div style={{ marginTop: 8 }}>
        <PasswordRow password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
      </div>
      <div style={{ marginTop: 12 }}>
        <button onClick={finish} disabled={busy || !pk.trim()}>[ {busy ? '...' : 'SIGN IN'} ]</button>
      </div>
      {error && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
    </>
  );
}

function UnlockTab({ onDone }: { onDone: () => void }) {
  const wallet = useWallet();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function finish() {
    setError(''); setBusy(true);
    try {
      const kp = await wallet.unlock(password);
      await authenticate(kp);
      onDone();
    } catch (e: any) {
      setError(e?.message ?? 'failed');
    } finally {
      setBusy(false);
    }
  }

  async function forget() {
    const ok = window.confirm(
      'Wipe the local wallet on this device?\n\n' +
      'You will need your recovery phrase or private key to sign in again. ' +
      'Your balance is unaffected.',
    );
    if (!ok) return;
    await wallet.forget();
  }

  return (
    <>
      <div style={{ color: 'var(--dim)', fontSize: 12, marginBottom: 8 }}>
        wallet stored on this device for {wallet.meta ? <code>{shortPubkey(wallet.meta.pubkey)}</code> : '???'}.
      </div>
      <div>
        PASSWORD : <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: '32ch' }}
          autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' && password && !busy) finish(); }}
          autoComplete="current-password"
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <button onClick={finish} disabled={busy || !password}>[ {busy ? '...' : 'UNLOCK'} ]</button>{' '}
        <button onClick={forget} disabled={busy}>[ forget wallet ]</button>
      </div>
      {error && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
    </>
  );
}
