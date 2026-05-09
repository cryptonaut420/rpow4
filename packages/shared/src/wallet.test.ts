import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  generateMnemonic,
  isValidPubkeyBase58,
  mnemonicToKeypair,
  privateKeyToKeypair,
  shortPubkey,
  signCanonical,
  slip0010DerivePath,
  slip0010MasterKeyFromSeed,
  validateMnemonic,
  verifyCanonical,
} from './wallet.js';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function bytesFromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('mnemonics', () => {
  it('generateMnemonic produces a valid 12-word phrase by default', () => {
    const m = generateMnemonic();
    expect(m.split(' ')).toHaveLength(12);
    expect(validateMnemonic(m)).toBe(true);
  });

  it('rejects a tampered mnemonic', () => {
    const m = generateMnemonic();
    const broken = m.replace(/\w+/, 'notarealword');
    expect(validateMnemonic(broken)).toBe(false);
  });

  it('mnemonicToKeypair is deterministic for the same mnemonic + passphrase', () => {
    const m = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const a = mnemonicToKeypair(m);
    const b = mnemonicToKeypair(m);
    expect(a.publicKeyBase58).toBe(b.publicKeyBase58);
  });

  it('different passphrases derive different keypairs', () => {
    const m = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const k1 = mnemonicToKeypair(m, '');
    const k2 = mnemonicToKeypair(m, 'cheese');
    expect(k1.publicKeyBase58).not.toBe(k2.publicKeyBase58);
  });

  it('rejects an invalid mnemonic at derivation time', () => {
    expect(() => mnemonicToKeypair('not actually a real mnemonic')).toThrow(/invalid mnemonic/);
  });
});

describe('SLIP-0010 Ed25519 against official spec test vectors', () => {
  // Source: https://github.com/satoshilabs/slips/blob/master/slip-0010.md
  // "Test vector 1 for ed25519". These vectors prove our derivation is
  // bit-exact correct against the spec — independent of any wallet
  // implementation. If these pass, the BIP-39 → SLIP-0010 → Ed25519
  // pipeline is canonically correct.
  const seed1 = bytesFromHex('000102030405060708090a0b0c0d0e0f');

  it('master node from seed1 matches the spec', () => {
    const m = slip0010MasterKeyFromSeed(seed1);
    expect(hex(m.chainCode)).toBe('90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb');
    expect(hex(m.key)).toBe('2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
  });

  it("m/0' from seed1 matches the spec", () => {
    const n = slip0010DerivePath(seed1, "m/0'");
    expect(hex(n.chainCode)).toBe('8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69');
    expect(hex(n.key)).toBe('68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3');
  });

  it("m/0'/1'/2'/2'/1000000000' from seed1 matches the spec", () => {
    const n = slip0010DerivePath(seed1, "m/0'/1'/2'/2'/1000000000'");
    expect(hex(n.chainCode)).toBe('68789923a0cac2cd5a29172a475fe9e0fb14cd6adb5ad98a3fa70333e7afa230');
    expect(hex(n.key)).toBe('8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793');
  });

  // Regression vector: BIP-39 + SLIP-0010 + tweetnacl pipeline. The mnemonic
  // is the BIP-39 reference all-zero phrase; on Solana's path m/44'/501'/0'/0'
  // it derives the value below. Reproducible by any spec-compliant
  // implementation (e.g. solana-keygen, ed25519-hd-key + bip39).
  it('all-zero mnemonic on m/44\'/501\'/0\'/0\' is stable', () => {
    const m = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const kp = mnemonicToKeypair(m);
    expect(kp.publicKeyBase58).toBe('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  });
});

describe('privateKeyToKeypair', () => {
  it('accepts a 32-byte hex seed', () => {
    const seedHex = '00'.repeat(32);
    const kp = privateKeyToKeypair(seedHex);
    // First 32 bytes of NaCl secretKey === input seed
    const seed = kp.secretKey.slice(0, 32);
    expect(Buffer.from(seed).toString('hex')).toBe(seedHex);
  });

  it('accepts a 64-byte NaCl secretKey hex (priv-seed || pub)', () => {
    const real = nacl.sign.keyPair();
    const hex = Buffer.from(real.secretKey).toString('hex');
    const kp = privateKeyToKeypair(hex);
    expect(kp.publicKeyBase58).toBe(bs58.encode(real.publicKey));
  });

  it('accepts a base58-encoded 32-byte seed', () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = i;
    const b58 = bs58.encode(bytes);
    const kp = privateKeyToKeypair(b58);
    const seed = kp.secretKey.slice(0, 32);
    expect(Array.from(seed)).toEqual(Array.from(bytes));
  });

  it('rejects a key of the wrong length', () => {
    expect(() => privateKeyToKeypair('00'.repeat(16))).toThrow();
  });
});

describe('canonical signing round-trip', () => {
  it('signCanonical → verifyCanonical succeeds for the same action + body', () => {
    const kp = mnemonicToKeypair(generateMnemonic());
    const body = { recipient_pubkey: 'abc', amount_base_units: '1000000000', idempotency_key: 'k1' };
    const sig = signCanonical('transfer', body, kp.secretKey);
    expect(verifyCanonical('transfer', body, sig, kp.publicKeyBase58)).toBe(true);
  });

  it('verifyCanonical rejects a signature against a different action (domain separation)', () => {
    const kp = mnemonicToKeypair(generateMnemonic());
    const body = { x: 1 };
    const sig = signCanonical('transfer', body, kp.secretKey);
    expect(verifyCanonical('mint', body, sig, kp.publicKeyBase58)).toBe(false);
  });

  it('verifyCanonical rejects a tampered body', () => {
    const kp = mnemonicToKeypair(generateMnemonic());
    const sig = signCanonical('transfer', { amount_base_units: '100' }, kp.secretKey);
    expect(verifyCanonical('transfer', { amount_base_units: '101' }, sig, kp.publicKeyBase58)).toBe(false);
  });

  it('verifyCanonical rejects malformed sig / pub strings without throwing', () => {
    const kp = mnemonicToKeypair(generateMnemonic());
    const sig = signCanonical('transfer', { x: 1 }, kp.secretKey);
    expect(verifyCanonical('transfer', { x: 1 }, '!not-base58!', kp.publicKeyBase58)).toBe(false);
    expect(verifyCanonical('transfer', { x: 1 }, sig, '!not-base58!')).toBe(false);
  });

  it('signature is stable across key-order permutations of the same body', () => {
    const kp = mnemonicToKeypair(generateMnemonic());
    const sigA = signCanonical('transfer', { a: 1, b: 2, c: 3 }, kp.secretKey);
    const sigB = signCanonical('transfer', { c: 3, b: 2, a: 1 }, kp.secretKey);
    expect(sigA).toBe(sigB);
  });
});

describe('pubkey helpers', () => {
  it('isValidPubkeyBase58 accepts a real pubkey and rejects garbage', () => {
    const kp = mnemonicToKeypair(generateMnemonic());
    expect(isValidPubkeyBase58(kp.publicKeyBase58)).toBe(true);
    expect(isValidPubkeyBase58('not a real key')).toBe(false);
    // Right alphabet, wrong length
    expect(isValidPubkeyBase58('111')).toBe(false);
  });

  it('shortPubkey shortens with an ellipsis but leaves short values alone', () => {
    expect(shortPubkey('Hj6BBmvhECT7sN8wRNQjWyuk7w2WsiZWeT24DXEpc6gw')).toBe('Hj6B…c6gw');
    expect(shortPubkey('abc')).toBe('abc');
  });
});
