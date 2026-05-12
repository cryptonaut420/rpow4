// Canonical message serialization for client-signed payloads.
//
// Rules:
//   - object keys sorted alphabetically at every depth
//   - bigints serialize as decimal strings (so the JSON round-trips through
//     untyped JSON parsers without precision loss)
//   - undefined / function / symbol values are dropped (mirrors JSON.stringify)
//   - the final signed message is "rpow4.<action>.v1\n" + canonical-json
//
// The domain prefix prevents replay across action types.

export type CanonicalAction =
  | 'auth.session'
  | 'mint'
  | 'transfer'
  | 'account.set_display_name'
  | 'account.signup'
  | 'trollbox.post'
  | 'claim.create'
  | 'claim.cancel'
  | 'pool.share'
  | 'market.order.create'
  | 'market.order.cancel';

export const CANONICAL_VERSION = 'v1';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalJson: non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      parts.push(JSON.stringify(k) + ':' + canonicalJson(v));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}

/**
 * Build the exact byte string that the client signs (and the server verifies)
 * for a given action. The body must NOT include the signature field; signing
 * a message that contains its own signature is an unfixable chicken-and-egg.
 */
export function canonicalMessage(action: CanonicalAction, body: unknown): string {
  return `rpow4.${action}.${CANONICAL_VERSION}\n${canonicalJson(body)}`;
}
