import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalMessage } from './canonical.js';

describe('canonicalJson', () => {
  it('sorts object keys alphabetically at every depth', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(
      canonicalJson({ outer: { z: 1, a: { y: 1, x: 0 } } }),
    ).toBe('{"outer":{"a":{"x":0,"y":1},"z":1}}');
  });

  it('serializes bigints as decimal strings', () => {
    expect(canonicalJson({ amount: 12345678901234567890n })).toBe('{"amount":"12345678901234567890"}');
  });

  it('skips undefined values, like JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('handles arrays in declaration order', () => {
    expect(canonicalJson([3, 2, 1])).toBe('[3,2,1]');
    expect(canonicalJson({ list: [{ b: 1, a: 2 }, { d: 4, c: 3 }] }))
      .toBe('{"list":[{"a":2,"b":1},{"c":3,"d":4}]}');
  });

  it('produces identical output for equal objects with different key order', () => {
    const a = { recipient_pubkey: 'X', amount_base_units: 1n, idempotency_key: 'k' };
    const b = { idempotency_key: 'k', amount_base_units: 1n, recipient_pubkey: 'X' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('rejects non-finite numbers (which JSON.stringify silently coerces to null)', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });
});

describe('canonicalMessage', () => {
  it('prefixes the canonical JSON with the action + version domain separator', () => {
    const msg = canonicalMessage('transfer', { a: 1 });
    expect(msg).toBe('rpow4.transfer.v1\n{"a":1}');
  });

  it('produces distinct messages for different actions, even with identical bodies', () => {
    const body = { x: 1 };
    expect(canonicalMessage('transfer', body)).not.toBe(canonicalMessage('mint', body));
  });
});
