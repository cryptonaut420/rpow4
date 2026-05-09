// Browser-and-Node-safe wallet module.
//
// Identity is a 32-byte Ed25519 keypair. Origin can be:
//   - generated from fresh CSPRNG entropy via BIP-39 mnemonic, or
//   - imported from an existing BIP-39 mnemonic (with optional passphrase), or
//   - imported from a raw 32-byte seed / 64-byte secretKey (hex or base58).
//
// HD derivation follows SLIP-0010 (Ed25519 variant) on the canonical RPOW
// path m/44'/501'/0'/0'. Coin type 501 is the SLIP-0044 registration commonly
// used for Ed25519 chains; we adopt it so any standard SLIP-0010/Ed25519
// tooling can re-derive the same keypair from a given mnemonic.

import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import {
  generateMnemonic as bip39Generate,
  mnemonicToSeedSync,
  validateMnemonic as bip39Validate,
} from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english';

import { canonicalMessage, type CanonicalAction } from './canonical.js';

export interface RpowKeypair {
  publicKey: Uint8Array;       // 32 bytes
  secretKey: Uint8Array;       // 64 bytes (NaCl format: privSeed || pubKey)
  publicKeyBase58: string;
}

const RPOW_DERIVATION_PATH = "m/44'/501'/0'/0'";

// ---- BIP-39 -----------------------------------------------------------------

/**
 * Generate a fresh BIP-39 mnemonic. Strength is in bits of entropy:
 * 128 -> 12 words, 160 -> 15, 192 -> 18, 224 -> 21, 256 -> 24.
 */
export function generateMnemonic(strengthBits: 128 | 160 | 192 | 224 | 256 = 128): string {
  return bip39Generate(english, strengthBits);
}

export function validateMnemonic(mnemonic: string): boolean {
  return bip39Validate(mnemonic.trim(), english);
}

export function mnemonicToSeed(mnemonic: string, passphrase = ''): Uint8Array {
  if (!validateMnemonic(mnemonic)) throw new Error('invalid mnemonic');
  return mnemonicToSeedSync(mnemonic.trim(), passphrase);
}

// ---- SLIP-0010 (Ed25519 variant) -------------------------------------------
//
// Spec: https://github.com/satoshilabs/slips/blob/master/slip-0010.md
// All child derivations on the Ed25519 curve are HARDENED. Path components
// MUST end with `'` (apostrophe) and we enforce that here.

export interface Slip0010Node { key: Uint8Array; chainCode: Uint8Array }

const ED25519_MASTER_KEY = new TextEncoder().encode('ed25519 seed');

function hardened(index: number): number {
  return (index | 0x80000000) >>> 0;
}

/** SLIP-0010 master key from seed (Ed25519 variant). Public for testing. */
export function slip0010MasterKeyFromSeed(seed: Uint8Array): Slip0010Node {
  const I = hmac(sha512, ED25519_MASTER_KEY, seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32, 64) };
}

function ckdPriv(parent: Slip0010Node, index: number): Slip0010Node {
  // Hardened-only: data = 0x00 || k_par || ser32(index)
  const data = new Uint8Array(1 + 32 + 4);
  data[0] = 0;
  data.set(parent.key, 1);
  data[33] = (index >>> 24) & 0xff;
  data[34] = (index >>> 16) & 0xff;
  data[35] = (index >>> 8) & 0xff;
  data[36] = index & 0xff;
  const I = hmac(sha512, parent.chainCode, data);
  return { key: I.slice(0, 32), chainCode: I.slice(32, 64) };
}

/**
 * Derive a SLIP-0010 Ed25519 node at the given path. Path must be hardened-
 * only (each segment ends with `'`).
 */
export function slip0010DerivePath(seed: Uint8Array, path: string): Slip0010Node {
  if (!path.startsWith('m/')) throw new Error('derivation path must start with m/');
  const segments = path.slice(2).split('/');
  let node = slip0010MasterKeyFromSeed(seed);
  for (const seg of segments) {
    if (!seg.endsWith("'")) throw new Error('SLIP-0010 Ed25519 requires hardened-only paths');
    const n = Number.parseInt(seg.slice(0, -1), 10);
    if (!Number.isInteger(n) || n < 0 || n > 0x7fffffff) throw new Error(`invalid path index: ${seg}`);
    node = ckdPriv(node, hardened(n));
  }
  return node;
}

// ---- keypair construction ---------------------------------------------------

function keypairFromSeed(privSeed: Uint8Array): RpowKeypair {
  if (privSeed.length !== 32) throw new Error('Ed25519 private seed must be 32 bytes');
  const kp = nacl.sign.keyPair.fromSeed(privSeed);
  return {
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    publicKeyBase58: bs58.encode(kp.publicKey),
  };
}

/**
 * Derive a keypair from a mnemonic on the canonical RPOW HD path
 * (m/44'/501'/0'/0'). Any SLIP-0010 / Ed25519 wallet using the same path
 * (and the same mnemonic + passphrase) will produce this same keypair.
 */
export function mnemonicToKeypair(mnemonic: string, passphrase = ''): RpowKeypair {
  const seed = mnemonicToSeed(mnemonic, passphrase);
  const node = slip0010DerivePath(seed, RPOW_DERIVATION_PATH);
  return keypairFromSeed(node.key);
}

/** Import a raw 32-byte private seed (hex or base58 encoded). */
export function privateKeyToKeypair(input: string | Uint8Array): RpowKeypair {
  const bytes = typeof input === 'string' ? decodeKeyBytes(input) : input;
  if (bytes.length === 32) return keypairFromSeed(bytes);
  if (bytes.length === 64) {
    // NaCl-format secretKey already (priv-seed || pubkey). Take the seed half.
    return keypairFromSeed(bytes.slice(0, 32));
  }
  throw new Error('private key must decode to 32 or 64 bytes');
}

function decodeKeyBytes(s: string): Uint8Array {
  const trimmed = s.trim();
  // 64 hex chars (32 bytes) or 128 hex chars (64 bytes).
  if (/^[0-9a-fA-F]{64}$/.test(trimmed) || /^[0-9a-fA-F]{128}$/.test(trimmed)) {
    return hexToBytes(trimmed);
  }
  // Otherwise try base58. bs58 throws for invalid alphabet.
  return bs58.decode(trimmed);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ---- canonical sign / verify ------------------------------------------------

/**
 * Sign a canonical message (action + body) and return the signature base58.
 * The caller is responsible for ensuring `body` does not include the signature
 * field itself.
 */
export function signCanonical(action: CanonicalAction, body: unknown, secretKey: Uint8Array): string {
  const msg = new TextEncoder().encode(canonicalMessage(action, body));
  const sig = nacl.sign.detached(msg, secretKey);
  return bs58.encode(sig);
}

export function verifyCanonical(
  action: CanonicalAction,
  body: unknown,
  signatureBase58: string,
  publicKeyBase58: string,
): boolean {
  let sig: Uint8Array;
  let pub: Uint8Array;
  try {
    sig = bs58.decode(signatureBase58);
    pub = bs58.decode(publicKeyBase58);
  } catch {
    return false;
  }
  if (sig.length !== 64 || pub.length !== 32) return false;
  const msg = new TextEncoder().encode(canonicalMessage(action, body));
  return nacl.sign.detached.verify(msg, sig, pub);
}

// ---- public-key helpers -----------------------------------------------------

export function pubkeyToBase58(pub: Uint8Array): string {
  if (pub.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return bs58.encode(pub);
}

export function isValidPubkeyBase58(s: string): boolean {
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/** Short display form: first4...last4 of a base58 pubkey. */
export function shortPubkey(pubBase58: string, head = 4, tail = 4): string {
  if (pubBase58.length <= head + tail + 1) return pubBase58;
  return `${pubBase58.slice(0, head)}…${pubBase58.slice(-tail)}`;
}
