/**
 * Symmetric encryption used by the optional persistent wallet store.
 *
 * Layout on disk (per blob):
 *   salt   16 bytes  — random per save
 *   iv     12 bytes  — random per save
 *   ct     N bytes   — AES-GCM(plaintext) including the GCM auth tag
 *
 * Key derivation: PBKDF2 over the user's passphrase with SHA-256 and
 * 200_000 iterations. PBKDF2 is the most portable option that ships in
 * WebCrypto without polyfills; argon2id would be stronger but we'd have
 * to wasm-load it. 200k SHA-256 rounds is well above the OWASP floor and
 * keeps unlock under ~250ms on a laptop.
 */

const ITERATIONS = 200_000;
const SALT_LEN = 16;
const IV_LEN = 12;

async function deriveAesKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt as any,
      iterations: ITERATIONS,
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface EncryptedBlob {
  salt: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

export async function encryptString(plaintext: string, password: string): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveAesKey(password, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as any },
      key,
      new TextEncoder().encode(plaintext) as any,
    ),
  );
  return { salt, iv, ciphertext };
}

export async function decryptString(blob: EncryptedBlob, password: string): Promise<string> {
  const key = await deriveAesKey(password, blob.salt);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: blob.iv as any },
      key,
      blob.ciphertext as any,
    ),
  );
  return new TextDecoder().decode(plain);
}
