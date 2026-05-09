import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  generateMnemonic,
  isValidPubkeyBase58,
  mnemonicToKeypair,
  privateKeyToKeypair,
  signCanonical,
  validateMnemonic,
  type CanonicalAction,
  type RpowKeypair,
} from '@rpow/shared';
import {
  clearSessionWallet,
  clearWallet,
  loadEncryptedSecret,
  loadMeta,
  loadSessionWallet,
  saveEncryptedSecret,
  saveSessionWallet,
  type WalletKind,
  type WalletMeta,
} from './store.js';

/**
 * Wallet state machine:
 *
 *   - 'loading'  : checking IndexedDB for an existing meta record
 *   - 'empty'    : no wallet stored — show Create / Import screen
 *   - 'locked'   : a wallet is stored, but we don't have the secret
 *                  in memory yet — show Unlock screen
 *   - 'unlocked' : keypair is in memory and ready to sign
 */
export type WalletStatus = 'loading' | 'empty' | 'locked' | 'unlocked';

export interface WalletContextValue {
  status: WalletStatus;
  /** Public-facing metadata (always safe to render). */
  meta: WalletMeta | null;
  /** Set when status === 'unlocked'. NEVER persist this on disk yourself. */
  keypair: RpowKeypair | null;
  /**
   * True when the original mnemonic / private key plaintext is held in
   * memory for this session (e.g. just after a fresh signup or import).
   * Lets backup UI offer a no-password reveal for session-only wallets,
   * since there's nothing to decrypt against. Drops to false on lock /
   * forget, and on the next page load.
   */
  hasVolatileSecret: boolean;

  /** Create a fresh BIP-39 mnemonic, returning it so the user can record it. */
  createNewMnemonic(): string;

  /** Persist a freshly-created mnemonic and unlock the wallet in memory. */
  finalizeNewMnemonic(mnemonic: string, opts: { password?: string }): Promise<RpowKeypair>;

  /** Import an existing mnemonic. */
  importMnemonic(mnemonic: string, opts: { password?: string }): Promise<RpowKeypair>;

  /** Import a raw private key (base58 or hex). */
  importPrivateKey(privateKey: string, opts: { password?: string }): Promise<RpowKeypair>;

  /** Unlock a stored wallet by decrypting with the password. */
  unlock(password: string): Promise<RpowKeypair>;

  /**
   * Take the in-memory secret (set when the wallet was first adopted
   * this session) and write an encrypted copy to IndexedDB under the
   * given password. Lets a session-only wallet upgrade to persistent
   * storage without re-entering the seed phrase.
   *
   * Throws if there's no in-memory secret (e.g. the wallet was unlocked
   * from an existing encrypted blob — change-password is a separate
   * flow), or if the password is empty.
   */
  persistVolatileSecret(password: string): Promise<void>;

  /**
   * Reveal the stored secret (mnemonic OR raw private key) by re-deriving
   * it from the encrypted blob. Requires the wallet password. Returns the
   * plaintext + kind without changing in-memory state — the caller is
   * responsible for wiping it from any UI/state once the user is done.
   *
   * Throws if no wallet is stored, the password is wrong, or the wallet
   * was created in session-only mode (no persisted blob).
   */
  revealSecret(password: string): Promise<{ plaintext: string; kind: WalletKind }>;

  /** Drop the in-memory keypair (keeps the encrypted store). */
  lock(): void;

  /**
   * Wipe the stored wallet entirely. The user MUST have backed up their
   * mnemonic — there's no recovery path on the server side.
   */
  forget(): Promise<void>;

  /** Sign a canonical body with the in-memory keypair. */
  sign(action: CanonicalAction, body: unknown): string;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet() must be inside <WalletProvider>');
  return ctx;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WalletStatus>('loading');
  const [meta, setMeta] = useState<WalletMeta | null>(null);
  const keypairRef = useRef<RpowKeypair | null>(null);
  // In-memory copy of the secret for the lifetime of this unlocked
  // session. Lets `revealSecret()` show a backup even when the wallet
  // was created in session-only mode (no IndexedDB blob to decrypt).
  // Cleared on lock(), forget(), and when persistAndAdopt sets a new
  // wallet so the previous one's secret can't leak.
  const volatileSecretRef = useRef<{ plaintext: string; kind: WalletKind } | null>(null);
  const [, setRevision] = useState(0); // force re-render when keypair changes
  const bumpRevision = useCallback(() => setRevision((n) => n + 1), []);

  useEffect(() => {
    (async () => {
      try {
        const m = await loadMeta();

        // Try to auto-restore the key from the session cache first.
        // This covers both session-only wallets and password-protected wallets
        // that have already been unlocked once during this browser session.
        const session = loadSessionWallet();
        if (session) {
          // If there IS an encrypted wallet in IndexedDB, verify pubkeys match
          // before trusting the cache — guards against stale/mismatched data.
          if (!m || m.pubkey === session.pubkey) {
            try {
              const kp =
                session.kind === 'mnemonic'
                  ? mnemonicToKeypair(session.plaintext)
                  : privateKeyToKeypair(session.plaintext);
              if (m) setMeta(m);
              keypairRef.current = kp;
              volatileSecretRef.current = { plaintext: session.plaintext, kind: session.kind };
              setStatus('unlocked');
              return;
            } catch {
              // Corrupt session cache — fall through to normal flow.
              clearSessionWallet();
            }
          } else {
            // Pubkey mismatch (different account?) — discard stale cache.
            clearSessionWallet();
          }
        }

        setMeta(m);
        setStatus(m ? 'locked' : 'empty');
      } catch {
        setStatus('empty');
      }
    })();
  }, []);

  const setKeypair = useCallback((kp: RpowKeypair | null) => {
    keypairRef.current = kp;
    bumpRevision();
  }, [bumpRevision]);

  /**
   * Persist or just hold the secret in memory. If `password` is omitted we
   * stay session-only — the user must re-enter the secret on every reload.
   */
  const persistAndAdopt = useCallback(
    async (opts: {
      kp: RpowKeypair;
      kind: WalletKind;
      plaintext: string;
      password?: string;
    }): Promise<RpowKeypair> => {
      if (opts.password) {
        await saveEncryptedSecret({
          pubkey: opts.kp.publicKeyBase58,
          kind: opts.kind,
          plaintext: opts.plaintext,
          password: opts.password,
        });
        setMeta(await loadMeta());
      }
      // Stash plaintext in memory so /backup can re-show it during the
      // session even when no encrypted blob was written. This is the
      // ONLY in-memory copy of the secret (the keypair only holds the
      // 64-byte secretKey, not the originating mnemonic).
      volatileSecretRef.current = { plaintext: opts.plaintext, kind: opts.kind };
      // Also cache in sessionStorage so page refreshes (same tab) don't
      // drop the user back to the login screen.
      saveSessionWallet({ pubkey: opts.kp.publicKeyBase58, kind: opts.kind, plaintext: opts.plaintext });
      setKeypair(opts.kp);
      setStatus('unlocked');
      return opts.kp;
    },
    [setKeypair],
  );

  const value = useMemo<WalletContextValue>(() => ({
    status,
    meta,
    keypair: keypairRef.current,
    hasVolatileSecret: volatileSecretRef.current !== null,

    createNewMnemonic(): string {
      return generateMnemonic();
    },

    async finalizeNewMnemonic(mnemonic: string, opts: { password?: string }) {
      if (!validateMnemonic(mnemonic)) throw new Error('invalid mnemonic');
      const kp = mnemonicToKeypair(mnemonic);
      return persistAndAdopt({ kp, kind: 'mnemonic', plaintext: mnemonic.trim(), password: opts.password });
    },

    async importMnemonic(mnemonic: string, opts: { password?: string }) {
      const trimmed = mnemonic.trim().replace(/\s+/g, ' ');
      if (!validateMnemonic(trimmed)) throw new Error('invalid mnemonic');
      const kp = mnemonicToKeypair(trimmed);
      return persistAndAdopt({ kp, kind: 'mnemonic', plaintext: trimmed, password: opts.password });
    },

    async importPrivateKey(privateKey: string, opts: { password?: string }) {
      const kp = privateKeyToKeypair(privateKey.trim());
      return persistAndAdopt({ kp, kind: 'privateKey', plaintext: privateKey.trim(), password: opts.password });
    },

    async unlock(password: string) {
      const decrypted = await loadEncryptedSecret(password);
      if (!decrypted) throw new Error('wrong password or no wallet stored');
      const kp = decrypted.kind === 'mnemonic'
        ? mnemonicToKeypair(decrypted.plaintext)
        : privateKeyToKeypair(decrypted.plaintext);
      const m = await loadMeta();
      if (m && !isValidPubkeyBase58(m.pubkey)) {
        throw new Error('stored wallet metadata is corrupt');
      }
      if (m && m.pubkey !== kp.publicKeyBase58) {
        // Defense in depth: decrypted secret derives a different pubkey
        // than what meta says. Should never happen unless storage was
        // tampered with.
        throw new Error('decrypted wallet does not match stored pubkey');
      }
      // Cache in sessionStorage so this tab doesn't need a password on refresh.
      saveSessionWallet({ pubkey: kp.publicKeyBase58, kind: decrypted.kind, plaintext: decrypted.plaintext });
      setKeypair(kp);
      setStatus('unlocked');
      return kp;
    },

    async persistVolatileSecret(password: string) {
      const v = volatileSecretRef.current;
      const kp = keypairRef.current;
      if (!v || !kp) throw new Error('no in-memory wallet to save (try signing in again)');
      if (!password) throw new Error('password is required');
      await saveEncryptedSecret({
        pubkey: kp.publicKeyBase58,
        kind: v.kind,
        plaintext: v.plaintext,
        password,
      });
      setMeta(await loadMeta());
    },

    async revealSecret(password: string) {
      const m = await loadMeta();
      if (m) {
        const decrypted = await loadEncryptedSecret(password);
        if (!decrypted) throw new Error('wrong password');
        return decrypted;
      }
      // Session-only wallet: there's no encrypted blob to decrypt, but
      // we may still hold the plaintext from when the wallet was first
      // adopted in this tab. Password input is ignored in this branch
      // since there's nothing to decrypt against.
      const v = volatileSecretRef.current;
      if (!v) throw new Error('no in-memory secret to reveal — wallet was unlocked from storage');
      return { plaintext: v.plaintext, kind: v.kind };
    },

    lock() {
      clearSessionWallet();
      volatileSecretRef.current = null;
      setKeypair(null);
      setStatus(meta ? 'locked' : 'empty');
    },

    async forget() {
      clearSessionWallet();
      volatileSecretRef.current = null;
      await clearWallet();
      setKeypair(null);
      setMeta(null);
      setStatus('empty');
    },

    sign(action, body) {
      const kp = keypairRef.current;
      if (!kp) throw new Error('wallet is locked');
      return signCanonical(action, body, kp.secretKey);
    },
  }), [status, meta, persistAndAdopt, setKeypair]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
