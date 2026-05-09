import { decryptString, encryptString, type EncryptedBlob } from './crypto.js';

/**
 * IndexedDB wallet store. Two object stores in DB `rpow2-wallet`:
 *
 *   - meta    : keyPath `id` (always 'self'), holds non-secret hints —
 *               `pubkey`, `createdAt`, `kind` ('mnemonic' | 'privateKey').
 *               Lets the UI decide whether to show a "Create" or "Unlock"
 *               screen on load without asking for the password first.
 *
 *   - secret  : keyPath `id` (always 'self'), holds the AES-GCM ciphertext
 *               of the mnemonic OR the raw 32-byte private key seed,
 *               plus the salt and iv. Decrypting requires the password.
 *
 * If you wipe `secret` (e.g. via /forget) the wallet is gone forever —
 * back up your mnemonic somewhere offline.
 */

const DB_NAME = 'rpow2-wallet';
const DB_VERSION = 1;
const META_STORE = 'meta';
const SECRET_STORE = 'secret';
const KEY = 'self';

export type WalletKind = 'mnemonic' | 'privateKey';

export interface WalletMeta {
  id: typeof KEY;
  pubkey: string;
  kind: WalletKind;
  createdAt: number;
}

export interface WalletSecret extends EncryptedBlob {
  id: typeof KEY;
  kind: WalletKind;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SECRET_STORE)) {
        db.createObjectStore(SECRET_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function loadMeta(): Promise<WalletMeta | null> {
  const m = (await tx(META_STORE, 'readonly', (s) => s.get(KEY))) as WalletMeta | undefined;
  return m ?? null;
}

async function saveMeta(meta: Omit<WalletMeta, 'id'>): Promise<void> {
  await tx(META_STORE, 'readwrite', (s) => s.put({ id: KEY, ...meta }));
}

export async function saveEncryptedSecret(opts: {
  pubkey: string;
  kind: WalletKind;
  plaintext: string;
  password: string;
}): Promise<void> {
  const blob = await encryptString(opts.plaintext, opts.password);
  const record: WalletSecret = { id: KEY, kind: opts.kind, ...blob };
  await tx(SECRET_STORE, 'readwrite', (s) => s.put(record));
  await saveMeta({ pubkey: opts.pubkey, kind: opts.kind, createdAt: Date.now() });
}

export async function loadEncryptedSecret(password: string): Promise<{
  plaintext: string;
  kind: WalletKind;
} | null> {
  const rec = (await tx(SECRET_STORE, 'readonly', (s) => s.get(KEY))) as WalletSecret | undefined;
  if (!rec) return null;
  try {
    const plaintext = await decryptString(rec, password);
    return { plaintext, kind: rec.kind };
  } catch {
    return null;
  }
}

export async function clearWallet(): Promise<void> {
  await tx(META_STORE, 'readwrite', (s) => s.delete(KEY));
  await tx(SECRET_STORE, 'readwrite', (s) => s.delete(KEY));
}
