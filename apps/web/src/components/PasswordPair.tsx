/**
 * Shared "set a password" + "confirm" pair, used wherever the user is
 * about to encrypt a wallet to IndexedDB. The confirm field is hidden
 * until the password field is non-empty so the form doesn't shout
 * "fill out two more boxes" when the user just wants session-only.
 *
 * Pure presentation; the parent owns the values + decides whether
 * empty is allowed.
 */
interface Props {
  password: string;
  setPassword: (s: string) => void;
  confirm: string;
  setConfirm: (s: string) => void;
  /** Override the default explainer line below the inputs. */
  helperText?: string;
  /** Override the password input label. Defaults to "PASSWORD". */
  label?: string;
  /** Width of the inputs in `ch` units. */
  widthCh?: number;
  /** Submit on Enter while focused in either input. */
  onSubmit?: () => void;
}

export function PasswordPair({
  password, setPassword, confirm, setConfirm,
  helperText, label = 'PASSWORD', widthCh = 32, onSubmit,
}: Props) {
  const mismatch = !!confirm && confirm !== password;
  const handleEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && onSubmit && password && password === confirm) onSubmit();
  };
  return (
    <>
      <div>
        {label} : <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={handleEnter}
          style={{ width: `${widthCh}ch` }}
          autoComplete="new-password"
        />
      </div>
      {!!password && (
        <div>
          CONFIRM&nbsp; : <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={handleEnter}
            style={{ width: `${widthCh}ch` }}
            autoComplete="new-password"
          />
          {mismatch && <span className="error" style={{ marginLeft: 8, fontSize: 12 }}>passwords don't match</span>}
        </div>
      )}
      <div style={{ marginTop: 4, color: 'var(--dim)', fontSize: 12 }}>
        {helperText ?? 'encrypts your wallet on this device. leave blank to use it in this tab only — closing the tab will sign you out.'}
      </div>
    </>
  );
}
