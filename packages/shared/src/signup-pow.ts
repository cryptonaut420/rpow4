/**
 * Shared signup-PoW prefix construction. Server and client MUST derive
 * the same bytes from (nonce, handle, pubkey); the prefix is what the
 * miner hashes alongside its u64-LE solution_nonce, looking for
 * `difficulty_bits` trailing zeros.
 *
 * Format (UTF-8): `signup\x1f<nonce_hex>\x1f<handle>\x1f<pubkey_base58>`
 *
 * The 0x1F (Unit Separator) bytes are a domain separator that cannot
 * appear in any of the components: nonce_hex is [0-9a-f], handle is
 * validated against DISPLAY_NAME_PATTERN, and pubkey_base58 is base58.
 */
export function signupPowPrefixBytes(args: {
  nonce_hex: string;
  handle: string;
  pubkey: string;
}): Uint8Array {
  const s = `signup\x1f${args.nonce_hex}\x1f${args.handle}\x1f${args.pubkey}`;
  return new TextEncoder().encode(s);
}

export function signupPowPrefixHex(args: {
  nonce_hex: string;
  handle: string;
  pubkey: string;
}): string {
  const buf = signupPowPrefixBytes(args);
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}
