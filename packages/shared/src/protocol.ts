// Wire-format types used by both server and web.
//
// Identity: every account is keyed by a 32-byte Ed25519 public key,
// transmitted as base58 ("publicKeyBase58"). All state-changing
// requests carry a `client_signature_base58` which is the detached
// Ed25519 signature over canonicalMessage(action, body) — see
// canonical.ts for the exact byte layout.

// ---- auth -------------------------------------------------------------------

export interface AuthChallengeRequestBody {
  pubkey: string; // base58
}

/** Server-issued, server-HMAC'd challenge envelope. Stateless — no DB row. */
export interface AuthChallengeEnvelope {
  pubkey: string;
  nonce: string;       // hex(16)
  issued_at: string;   // ISO8601
  expires_at: string;  // ISO8601 (issued_at + 5 min)
  domain: string;      // e.g. "rpow4"
}

export interface AuthChallengeResponse {
  envelope: AuthChallengeEnvelope;
  envelope_mac: string; // hex sha256-HMAC(server_secret, canonicalJson(envelope))
  message: string;      // human-readable preview the user "signs"
}

export interface AuthSessionRequestBody {
  envelope: AuthChallengeEnvelope;
  envelope_mac: string;
  signature_base58: string;
}

export interface AuthSessionResponse {
  ok: true;
  pubkey: string;
}

// ---- account ----------------------------------------------------------------

export interface MeResponse {
  pubkey: string;
  display_name: string | null;
  balance_base_units: string;
  minted_base_units: string;
  sent_base_units: string;
  received_base_units: string;
}

/**
 * /me/display_name body. Setting `display_name: null` clears the handle.
 * Server validates length (3..32), charset (alphanumerics + `._-@`),
 * uniqueness (case-insensitive), and verifies the client signature over
 * the canonical body before persisting.
 */
export interface SetDisplayNameRequestBody {
  display_name: string | null;
  client_signature_base58: string;
}
export interface SetDisplayNameResponse {
  ok: true;
  display_name: string | null;
}

/** Resolve a handle to its pubkey. 404 if unknown. */
export interface LookupResponse {
  pubkey: string;
  display_name: string;
}

// ---- signup (PoW-gated account registration) -------------------------------

/**
 * Phase 1 of the signup flow: client posts the desired handle + the
 * pubkey the wallet just generated. Server validates handle format,
 * checks availability, and issues a stateless HMAC'd PoW envelope. No
 * DB row is consumed.
 */
export interface SignupChallengeRequestBody {
  handle: string;
  pubkey: string;
}

export interface SignupChallengeEnvelope {
  handle: string;
  pubkey: string;
  nonce: string;             // hex(16)
  difficulty_bits: number;
  issued_at: string;         // ISO8601
  expires_at: string;        // ISO8601 (issued_at + 1h)
  domain: string;            // 'rpow4.signup'
}

export interface SignupChallengeResponse {
  envelope: SignupChallengeEnvelope;
  envelope_mac: string;      // hex sha256-HMAC(server_secret, canonicalJson(envelope))
  /**
   * Bytes the miner should hash, expressed as hex. The client computes
   * sha256(prefix_bytes || u64le(solution_nonce)) and looks for
   * difficulty_bits trailing zeros. Server re-derives the same prefix
   * from the envelope at submit-time so this is purely a convenience —
   * the proof binds to (envelope.nonce, handle, pubkey) regardless.
   */
  pow_prefix_hex: string;
}

/**
 * Phase 2 of the signup flow. Server verifies the envelope MAC, the PoW
 * solution, and the client's signature over { handle, pubkey, nonce },
 * then atomically inserts the account row with the handle bound to the
 * pubkey. On success, sets the session cookie.
 */
export interface SignupRequestBody {
  envelope: SignupChallengeEnvelope;
  envelope_mac: string;
  solution_nonce: string;     // decimal u64
  /** Ed25519 signature over canonicalMessage('account.signup', { handle, pubkey, nonce }). */
  client_signature_base58: string;
}

export interface SignupResponse {
  ok: true;
  pubkey: string;
  display_name: string;
}

// ---- handle validation ------------------------------------------------------

export const DISPLAY_NAME_MIN = 3;
export const DISPLAY_NAME_MAX = 32;
export const DISPLAY_NAME_PATTERN = /^[A-Za-z0-9._\-@]+$/;

/**
 * Names we never let users register, because they'd be confusing
 * (route paths, generic "user" words, the project's own brand) or
 * actively impersonating (admin / system / support). Compared
 * case-insensitively against the *whole* handle — substrings are fine
 * (e.g. "admin@example.com" is allowed because it isn't `admin`).
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // structural / route-shaped
  'api', 'app', 'www', 'auth', 'signup', 'signin', 'login', 'logout',
  'lookup', 'me', 'mine', 'send', 'wallet', 'activity', 'ledger',
  'account', 'health', 'settings', 'help', 'support', 'contact',
  // authority-impersonating
  'admin', 'administrator', 'root', 'system', 'sysadmin', 'official',
  'security', 'team', 'staff', 'mod', 'moderator',
  // brand
  'rpow', 'rpow2', 'rpow3', 'rpow4', 'srpow', 'finney', 'satoshi',
  // language placeholders
  'null', 'undefined', 'none', 'true', 'false', 'self', 'you',
]);

export function validateDisplayName(raw: string): { ok: true; normalized: string } | { ok: false; message: string } {
  const v = raw.trim();
  if (v.length < DISPLAY_NAME_MIN) return { ok: false, message: `must be at least ${DISPLAY_NAME_MIN} characters` };
  if (v.length > DISPLAY_NAME_MAX) return { ok: false, message: `must be at most ${DISPLAY_NAME_MAX} characters` };
  if (!DISPLAY_NAME_PATTERN.test(v)) return { ok: false, message: 'use letters, numbers, and . _ - @ only' };

  // Structural rules: no leading/trailing punctuation, no doubled
  // separators, must contain at least one alphanumeric. These avoid
  // confusables like ".alice", "alice." and "..bob" without baking
  // those into the regex (which would make the message worse).
  const first = v.charCodeAt(0);
  const last = v.charCodeAt(v.length - 1);
  const isAlnum = (c: number) =>
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  if (!isAlnum(first) || !isAlnum(last)) {
    return { ok: false, message: 'must start and end with a letter or number' };
  }
  if (/[._\-@]{2,}/.test(v)) {
    return { ok: false, message: 'cannot contain repeated . _ - @ characters' };
  }

  if (RESERVED_HANDLES.has(v.toLowerCase())) {
    return { ok: false, message: 'that name is reserved — please choose another' };
  }

  return { ok: true, normalized: v };
}

// ---- mining -----------------------------------------------------------------

export interface ChallengeResponse {
  challenge_id: string;
  nonce_prefix: string; // hex
  difficulty_bits: number;
  issued_at: string;    // iso8601
  expires_at: string;   // iso8601
  challenge_mac: string;
}

/**
 * /mint body. The miner signs over { challenge_id, solution_nonce } with their
 * session keypair so the resulting token's mint event is non-repudiably tied
 * to the pubkey that received the reward.
 */
export interface MintRequestBody {
  challenge_id: string;
  nonce_prefix: string;
  difficulty_bits: number;
  issued_at: string;
  expires_at: string;
  challenge_mac: string;
  solution_nonce: string; // decimal string of u64
  client_signature_base58: string;
}
export interface MintResponse { token: TokenSummary }

export interface TokenSummary {
  id: string;
  value_base_units: string; // stringified bigint
  issued_at: string;
}

// ---- transfer ---------------------------------------------------------------

/**
 * /send body. Sender signs the body (excluding `client_signature_base58`)
 * with their session keypair. The signature is persisted alongside the
 * transfer row so the public ledger exposes verifiable per-event sigs.
 */
export interface SendRequestBody {
  recipient_pubkey: string;       // base58 Ed25519
  amount_base_units: string;
  idempotency_key: string;
  client_signature_base58: string;
}
export interface SendResponse {
  ok: true;
  transferred_base_units: string;
  recipient_pubkey: string;
  transfer_id: string;
}

// ---- errors -----------------------------------------------------------------

export type ApiErrorCode =
  | 'RECIPIENT_NOT_FOUND'
  | 'INSUFFICIENT_BALANCE'
  | 'INVALID_SOLUTION'
  | 'INVALID_SIGNATURE'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_ALREADY_CLAIMED'
  | 'EXACT_SUM_REQUIRED'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'NAME_TAKEN'
  | 'NAME_NOT_FOUND'
  | 'SIGNUP_EXPIRED'
  | 'SUPPLY_EXHAUSTED'
  | 'INTERNAL';

export interface ApiError { error: ApiErrorCode; message: string; retry_after?: number }

// ---- activity / ledger ------------------------------------------------------

export interface ActivityEntry {
  type: 'mint' | 'send' | 'receive';
  amount_base_units: string;
  counterparty_pubkey?: string;
  /** Counterparty's current display name, if they have one set. */
  counterparty_display_name?: string;
  client_signature_base58?: string;
  at: string; // iso8601
}
export type ActivityResponse = ActivityEntry[];

export interface LedgerResponse {
  total_minted_base_units: string;
  total_transferred_base_units: string;
  circulating_supply_base_units: string;
  minted_supply_counter_base_units: string;
  max_supply_base_units: string;
  base_units_per_rpow: string;

  /** Block-based RPOW4 schedule. 1 mint = 1 block. */
  block_height: string;
  /** Total number of TRANSFER events ever recorded on the ledger. */
  transfer_count: string;
  halving_interval_blocks: number;
  difficulty_step_blocks: number;
  difficulty_max_bits: number;

  current_difficulty_bits: number;
  next_difficulty_bits: number;
  next_difficulty_at_block: string;
  blocks_to_next_difficulty_step: string;
  difficulty_tier: number;

  current_reward_base_units: string;
  next_reward_base_units: string;
  next_halving_at_block: string;
  blocks_to_next_halving: string;
  halving_index: number;

  is_capped: boolean;
  user_count: number;
}

export interface LeaderboardEntry {
  /** 1-indexed rank in the response (1 = highest balance). */
  rank: number;
  pubkey: string;
  display_name: string | null;
  spendable_base_units: string;
  minted_base_units: string;
  sent_base_units: string;
  received_base_units: string;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  /** ISO timestamp of when the snapshot was generated by the server. */
  generated_at: string;
  /** Maximum number of entries the server will ever return. */
  limit: number;
}

export interface LedgerEvent {
  id: string;
  type: 'mint' | 'transfer';
  actor_pubkey: string;
  counterparty_pubkey?: string;
  amount_base_units: string;
  challenge_id?: string;
  idempotency_key?: string;
  client_signature_base58?: string;
  at: string;
}

export interface LedgerEventsResponse {
  events: LedgerEvent[];
  next_cursor?: string;
}

