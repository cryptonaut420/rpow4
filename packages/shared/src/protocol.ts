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

// ---- assets -----------------------------------------------------------------

export interface AssetSummary {
  id: string;
  slug: string;
  display_code: string;
  nickname: string;
  description: string;
  creator_pubkey?: string;
  system_default: boolean;
  supply_mode: 'capped' | 'unlimited';
  max_supply_base_units?: string;
  base_units_per_coin: string;
  initial_reward_base_units: string;
  reward_schedule_type: string;
  reward_interval_blocks: number;
  reward_reduction_type: string;
  reward_reduction_value: string;
  difficulty_schedule_type: string;
  difficulty_start_bits: number;
  difficulty_step_blocks: number;
  difficulty_max_bits: number;
  mining_algo: 'rpow_classic';
  pool_enabled: boolean;
  pool_enable_at_difficulty_bits?: number;
  pool_fee_bps: number;
  pool_finder_bps: number;
  pool_share_bits: number;
  transfer_fee_base_units: string;
  founder_allocation_base_units: string;
  treasury_allocation_base_units: string;
  launch_burn_event_id?: string;
  created_at: string;
}

export interface AssetsResponse {
  assets: AssetSummary[];
  default_asset_slug: string;
  launch_burn_base_units: string;
}

export interface AssetDetailResponse {
  asset: AssetSummary;
  schedule: {
    block_height: string;
    current_reward_base_units: string;
    current_difficulty_bits: number;
    next_reward_base_units: string;
    next_difficulty_bits: number;
    is_mintable: boolean;
    is_capped: boolean;
  };
}

export interface LaunchAssetRequestBody {
  nickname: string;
  description?: string;
  slug?: string;
  supply_mode: 'capped' | 'unlimited';
  max_supply_base_units?: string;
  initial_reward_base_units: string;
  reward_schedule_type: 'none' | 'halving_by_blocks';
  reward_interval_blocks: number;
  difficulty_start_bits: number;
  difficulty_step_blocks: number;
  difficulty_max_bits: number;
  mining_algo: 'rpow_classic';
  pool_enabled: boolean;
  pool_enable_at_difficulty_bits?: number | null;
  pool_fee_bps: number;
  pool_finder_bps: number;
  pool_share_bits: number;
  founder_allocation_base_units: string;
}

export interface LaunchAssetResponse {
  ok: true;
  asset: AssetSummary;
  launch_burn_event_id: string;
  launch_burn_base_units: string;
}

// ---- account ----------------------------------------------------------------

export interface MeResponse {
  pubkey: string;
  asset_id?: string;
  asset_slug?: string;
  asset_code?: string;
  display_name: string | null;
  balance_base_units: string;
  minted_base_units: string;
  sent_base_units: string;
  received_base_units: string;
  /** True when ops waived per-send fees for this pubkey (`toggle-send-fees` script). */
  send_fees_waived: boolean;
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
  'explorer', 'faucet', 'trollbox', 'stats',
  // authority-impersonating
  'admin', 'administrator', 'root', 'system', 'sysadmin', 'official',
  'security', 'team', 'staff', 'mod', 'moderator',
  // brand
  'rpow', 'rpow2', 'rpow3', 'rpow4', 'srpow', 'finney', 'satoshi',
  // system accounts
  'treasury',
  // language placeholders
  'null', 'undefined', 'none', 'true', 'false', 'self', 'you',
]);

/** Base58 pubkey of the system treasury account (all-zero bytes). No keypair exists. */
export const TREASURY_PUBKEY = '11111111111111111111111111111111';

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
  asset_id?: string;
  asset_slug?: string;
  asset_code?: string;
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
  asset_id?: string;
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
  asset_id?: string;
  recipient_pubkey: string;       // base58 Ed25519
  amount_base_units: string;
  idempotency_key: string;
  client_signature_base58: string;
  memo?: string; // optional, max 64 chars, included in the signed body when present
}
export interface SendResponse {
  ok: true;
  transferred_base_units: string;
  fee_base_units: string;
  recipient_pubkey: string;
  transfer_id: string;
}

// ---- markets ----------------------------------------------------------------

export type MarketSide = 'buy' | 'sell';
export type MarketOrderType = 'limit' | 'market';
export type MarketOrderStatus = 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'expired' | 'rejected';

export interface MarketSummary {
  id: string;
  symbol: string;
  status: 'active' | 'paused' | 'archived';
  base_asset: AssetSummary;
  quote_asset: AssetSummary;
  taker_fee_bps: number;
  last_price_quote_base_units?: string;
  best_bid_quote_base_units?: string;
  best_ask_quote_base_units?: string;
  /**
   * Price at the first trade in the last 24h, used as the anchor for the
   * 24h % change displayed in the UI. Absent when no trade occurred in
   * that window.
   */
  open_price_24h_quote_base_units?: string;
  volume_24h_base_units: string;
  volume_24h_quote_base_units: string;
  trade_count_24h: number;
  created_at: string;
}

export interface MarketsResponse {
  markets: MarketSummary[];
  default_quote_asset_slug: string;
}

export interface MarketDetailResponse {
  market: MarketSummary;
}

export interface MarketBookLevel {
  price_quote_base_units: string;
  base_amount_base_units: string;
  quote_amount_base_units: string;
  order_count: number;
}

export interface MarketBookResponse {
  market_id: string;
  bids: MarketBookLevel[];
  asks: MarketBookLevel[];
  at: string;
}

export interface MarketTrade {
  id: string;
  market_id: string;
  price_quote_base_units: string;
  base_amount_base_units: string;
  quote_amount_base_units: string;
  taker_side: MarketSide;
  fee_base_units: string;
  created_at: string;
}

export interface MarketTradesResponse {
  trades: MarketTrade[];
  next_cursor?: string;
}

export interface MarketCandle {
  bucket_start: string;
  open_quote_base_units: string;
  high_quote_base_units: string;
  low_quote_base_units: string;
  close_quote_base_units: string;
  volume_base_units: string;
  volume_quote_base_units: string;
  trade_count: number;
}

export interface MarketCandlesResponse {
  market_id: string;
  interval: '1m' | '5m' | '1h' | '1d';
  candles: MarketCandle[];
}

export interface MarketBalanceSide {
  asset_id: string;
  asset_slug: string;
  asset_code: string;
  spendable_base_units: string;
  locked_base_units: string;
}

export interface MarketBalancesResponse {
  market_id: string;
  base: MarketBalanceSide;
  quote: MarketBalanceSide;
}

export interface MarketOrder {
  id: string;
  market_id: string;
  owner_pubkey: string;
  side: MarketSide;
  order_type: MarketOrderType;
  price_quote_base_units?: string;
  original_base_units: string;
  remaining_base_units: string;
  reserved_asset_id?: string;
  reserved_remaining_base_units: string;
  status: MarketOrderStatus;
  client_order_id: string;
  created_at: string;
  updated_at: string;
  cancelled_at?: string;
}

export interface MarketOrdersResponse {
  orders: MarketOrder[];
  next_cursor?: string;
}

export interface MarketOrderCreateRequestBody {
  market_id: string;
  side: MarketSide;
  order_type: MarketOrderType;
  price_quote_base_units?: string;
  base_amount_base_units: string;
  /** Optional slippage/safety cap for market buys. */
  max_quote_base_units?: string;
  client_order_id: string;
  client_signature_base58: string;
}

export interface MarketOrderCreateResponse {
  ok: true;
  order: MarketOrder;
  trades: MarketTrade[];
  filled_base_units: string;
  spent_quote_base_units: string;
  received_quote_base_units: string;
  fee_base_units: string;
}

export interface MarketOrderCancelRequestBody {
  market_id: string;
  order_id: string;
  client_signature_base58: string;
}

export interface MarketOrderCancelResponse {
  ok: true;
  order: MarketOrder;
  released_base_units: string;
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
  | 'MARKET_NOT_FOUND'
  | 'MARKET_PAUSED'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_NOT_OPEN'
  | 'ORDER_WOULD_NOT_FILL'
  | 'INTERNAL';

export interface ApiError { error: ApiErrorCode; message: string; retry_after?: number }

// ---- activity / ledger ------------------------------------------------------

export interface ActivityEntry {
  id?: string; // event UUID, present for all new events
  type: 'mint' | 'send' | 'receive' | 'burn' | 'genesis';
  amount_base_units: string;
  fee_base_units?: string; // only present on 'send' events with a non-zero fee
  memo?: string;
  counterparty_pubkey?: string;
  /** Counterparty's current display name, if they have one set. */
  counterparty_display_name?: string;
  client_signature_base58?: string;
  event_seq: string;
  at: string; // iso8601
}

export interface ActivityResponse {
  balance_base_units: string;
  total_count: number;
  items: ActivityEntry[];
  /** Cursor to pass as ?cursor= to fetch the next page (absent on last page). */
  next_cursor?: string;
}

export interface LedgerResponse {
  asset_id?: string;
  asset_slug?: string;
  asset_code?: string;
  /** 'unlimited' assets have no cap; clients should hide cap visualizations. */
  supply_mode?: 'capped' | 'unlimited';
  total_minted_base_units: string;
  total_transferred_base_units: string;
  circulating_supply_base_units: string;
  minted_supply_counter_base_units: string;
  /**
   * Cumulative base units burned for this asset (e.g. the launch fee
   * that destroys RPOW4.0 to mint a new asset family). Always present;
   * defaults to "0" for assets that have never seen a BURN event.
   */
  total_burned_base_units: string;
  /**
   * Hard cap, present for capped assets only. `null` (or omitted) for
   * unlimited assets — older clients still see the legacy `Number.MAX` style
   * sentinel, but new clients should branch on `supply_mode`.
   */
  max_supply_base_units: string | null;
  base_units_per_rpow: string;

  /** Block-based RPOW4 schedule. 1 mint = 1 block. */
  block_height: string;
  /** Total number of TRANSFER events ever recorded on the ledger. */
  transfer_count: string;
  /** Current spendable balance of the system treasury account. */
  treasury_balance_base_units: string;
  /** Lifetime aggregate of all fees collected by the treasury. */
  total_fees_collected_base_units: string;
  /** Current fee charged per send (halves with the block reward). */
  current_fee_base_units: string;
  /** Current trollbox post fee (halves with the block reward, mirrors send). */
  current_trollbox_fee_base_units: string;
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
  /** Lifetime count of trollbox messages posted. */
  trollbox_message_count: string;
  /** Lifetime count of successful faucet claims. */
  faucet_claim_count: string;
  /** Lifetime sum of RPOW (base units) dripped from the faucet. */
  faucet_total_claimed_base_units: string;
}

export type LeaderboardSort = 'balance' | 'minted';

export interface LeaderboardEntry {
  /** 1-indexed rank in the response (1 = top of the chosen sort). */
  rank: number;
  pubkey: string;
  display_name: string | null;
  spendable_base_units: string;
  minted_base_units: string;
  sent_base_units: string;
  received_base_units: string;
  /** Lifetime count of accepted PoW solutions (= blocks mined). */
  blocks_mined: string;
}

export interface LeaderboardResponse {
  asset_id?: string;
  asset_slug?: string;
  asset_code?: string;
  /** Which sort produced this snapshot. */
  sort: LeaderboardSort;
  entries: LeaderboardEntry[];
  /** ISO timestamp of when the snapshot was generated by the server. */
  generated_at: string;
  /** Maximum number of entries the server will ever return. */
  limit: number;
}

export interface LedgerEvent {
  id: string;
  type: 'mint' | 'transfer' | 'burn' | 'genesis_allocation';
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

// ---- explorer ---------------------------------------------------------------

export interface ExplorerEvent {
  event_seq: string;
  id: string;
  type: 'mint' | 'transfer' | 'burn' | 'genesis_allocation';
  actor_pubkey: string;
  actor_display_name?: string;
  counterparty_pubkey?: string;
  counterparty_display_name?: string;
  amount_base_units: string;
  fee_base_units: string;
  memo?: string;
  at: string; // iso8601
}

export interface ExplorerFeedResponse {
  events: ExplorerEvent[];
  next_cursor?: string;
}

export interface ExplorerTxResponse extends ExplorerEvent {
  challenge_id?: string;
  client_signature_base58?: string;
}

export interface ExplorerAccountSummary {
  pubkey: string;
  display_name?: string;
  spendable_base_units: string;
  minted_base_units: string;
  sent_base_units: string;
  received_base_units: string;
  blocks_mined: string;
  total_count: number;
}

export interface ExplorerAccountEvent {
  id?: string;
  event_seq: string;
  type: 'mint' | 'send' | 'receive' | 'burn' | 'genesis';
  amount_base_units: string;
  fee_base_units?: string;
  memo?: string;
  counterparty_pubkey?: string;
  counterparty_display_name?: string;
  at: string; // iso8601
}

export interface ExplorerAccountResponse extends ExplorerAccountSummary {
  items: ExplorerAccountEvent[];
  next_cursor?: string;
}

// ---- faucet -----------------------------------------------------------------

export type FaucetIneligibleReason =
  | 'disabled'
  | 'treasury_dry'
  | 'cooldown_pubkey'
  | 'cooldown_ip'
  | 'login_required';

export interface FaucetStatusResponse {
  enabled: boolean;
  /** True only when authed, treasury has funds, and no cooldown is active. */
  eligible: boolean;
  claim_amount_base_units: string;
  cooldown_hours: number;
  cooldown_seconds: number;
  treasury_balance_base_units: string;
  treasury_pubkey: string;
  /** ISO timestamp of the most recent disqualifying claim (pubkey or IP). */
  last_claim_at?: string;
  /** When the caller becomes eligible again. */
  next_claim_at?: string;
  last_claim_amount_base_units?: string;
  ineligible_reason?: FaucetIneligibleReason;
}

export interface FaucetClaimResponse {
  ok: true;
  amount_base_units: string;
  transfer_id: string;
  claim_id: string;
  claimed_at: string;
  next_claim_at: string;
}

export interface FaucetClaimError {
  error: 'COOLDOWN_ACTIVE' | 'TREASURY_DRY' | 'BAD_REQUEST' | 'UNAUTHORIZED' | 'INTERNAL';
  message: string;
  last_claim_at?: string;
  next_claim_at?: string;
  cooldown_reason?: 'pubkey' | 'ip';
}

// ---- trollbox ---------------------------------------------------------------

/** Hard upper bound on a trollbox post body. Enforced server-side. */
export const TROLLBOX_BODY_MAX = 280;

/**
 * Each trollbox post burns a fixed fee that goes to the treasury. The amount
 * is configured server-side; clients should treat it as the authoritative
 * fee from /ledger. (Constant for now; may later track halvings like /send.)
 */
export interface TrollboxPostRequestBody {
  body: string;
  idempotency_key: string;
  /** Ed25519 signature over canonicalMessage('trollbox.post', { body, idempotency_key }). */
  client_signature_base58: string;
}

export interface TrollboxMessage {
  id: string;
  /** Strictly increasing sequence used for cursor pagination. */
  seq: string;
  author_pubkey: string;
  author_display_name?: string;
  body: string;
  fee_base_units: string;
  fee_event_id: string;
  posted_at: string;
}

export interface TrollboxPostResponse {
  ok: true;
  message_id: string;
  /** Underlying TRANSFER ledger event id for the fee paid to the treasury. */
  fee_event_id: string;
  fee_base_units: string;
  posted_at: string;
  /** Full feed row — clients can prepend immediately instead of waiting on GET /trollbox. */
  message: TrollboxMessage;
}

export interface TrollboxFeedResponse {
  messages: TrollboxMessage[];
  /** Server-authoritative fee for the next post, in base units. */
  post_fee_base_units: string;
  /** Server-authoritative max body length. */
  body_max: number;
  /** Lifetime count of all messages, regardless of pagination. */
  total_count: string;
  /** Cursor to pass as ?cursor= for the next (older) page. */
  next_cursor?: string;
}

// ---- pool mining ------------------------------------------------------------

/** Pool challenge envelope returned by POST /pool/challenge. The same fields
 * are echoed back by the client when submitting a share to /pool/share so
 * the server can re-verify the MAC. */
export interface PoolChallengeResponse {
  asset_id?: string;
  asset_slug?: string;
  asset_code?: string;
  challenge_id: string;
  user_pubkey: string;
  nonce_prefix: string;
  /** Current network difficulty — the share also wins a block at this. */
  network_difficulty_bits: number;
  /** Lower threshold for "share". Each accepted share counts toward
   * the round's pro-rata payout. */
  share_difficulty_bits: number;
  issued_at: string;
  expires_at: string;
  challenge_mac: string;
}

export interface PoolShareRequestBody {
  asset_id?: string;
  challenge_id: string;
  nonce_prefix: string;
  network_difficulty_bits: number;
  share_difficulty_bits: number;
  issued_at: string;
  expires_at: string;
  challenge_mac: string;
  solution_nonce: string;
  /** Ed25519 signature over canonicalMessage('pool.share', { challenge_id, solution_nonce }). */
  client_signature_base58: string;
}

export interface PoolShareResponse {
  ok: true;
  share_id: string;
  zeros: number;
  round_id: string;
  /** True when this share also cleared network difficulty and triggered
   * a block-win + round closeout. */
  block_won: boolean;
  /** The finder's own MINT ledger event id, suitable as an explorer
   * "block tx" link. Pool payouts are recorded as per-recipient MINTs
   * (not transfers from a treasury), so each participant's MINT lives
   * independently; this id is the one most users want to see. */
  block_event_id?: string;
  finder_pubkey?: string;
  reward_base_units?: string;
  /** Caller's payout for this round (only when they were the finder; for
   * non-finders, payouts arrive via the standard /activity feed). */
  your_payout_base_units?: string;
}

export interface PoolStatsResponse {
  enabled: boolean;
  share_difficulty_bits: number;
  network_difficulty_bits: number;
  /** Treasury fee in basis points (200 = 2%). */
  pool_fee_bps: number;
  /** Finder bonus in basis points of the post-fee reward (2500 = 25%). */
  finder_bps: number;
  /** Active round; null only on a freshly-migrated DB before the seed row. */
  current_round: {
    id: string;
    started_at: string;
    total_shares: string;
    your_shares: string;
    estimated_finder_payout_base_units: string;
    estimated_pro_rata_payout_base_units: string;
  } | null;
  /** Distinct miners with at least one share in the last 60s. */
  active_miners: number;
  /** Estimated pool hashrate in hashes/sec, derived from share rate. */
  pool_hashrate_hps: number;
  /** Current full-block reward at this height (gross, before treasury cut). */
  gross_reward_base_units: string;
  /** Last 10 closed rounds, newest first, with the caller's per-round payout
   * if they participated. */
  recent_payouts: Array<{
    round_id: string;
    ended_at: string;
    finder_pubkey: string;
    finder_display_name?: string;
    reward_base_units: string;
    /**
     * The finder's TOTAL take for the round (flat finder bonus + their
     * own pro-rata share), in base units. Not just the 25% bonus.
     */
    finder_payout_base_units: string;
    participant_count: number;
    your_payout_base_units?: string;
  }>;
}

/** Single row in GET /pool/rounds — used by the full pool-rounds history view. */
export interface PoolRoundEntry {
  round_id: string;
  started_at: string;
  ended_at: string;
  finder_pubkey: string;
  finder_display_name?: string;
  /** The finder's MINT ledger event id created when the block closed
   * (explorer linkage). Pool payouts are issued as one MINT per
   * recipient; this is the finder's. */
  block_event_id?: string;
  reward_base_units: string;
  treasury_cut_base_units: string;
  /** Finder's TOTAL take (bonus + their pro-rata share). */
  finder_payout_base_units: string;
  /** 75% pool that was distributed pro-rata across ALL participants. */
  pro_rata_pool_base_units: string;
  participant_count: number;
  total_shares: string;
  /** Caller's payout for this round, only present when authed + participated. */
  your_payout_base_units?: string;
}

export interface PoolRoundsResponse {
  rounds: PoolRoundEntry[];
  /** Cursor to pass as ?cursor= to fetch the next (older) page. */
  next_cursor?: string;
}

// ---- claim tokens (offline bearer transfers) --------------------------------

export type ClaimState = 'pending' | 'redeemed' | 'cancelled';

/**
 * POST /claim body. The client generates `claim_id` (randomUUID) so it can be
 * included in the signed body before the server sees the request.
 * Signs canonicalMessage('claim.create', { claim_id, amount_base_units, memo? }).
 */
export interface ClaimCreateRequestBody {
  claim_id: string;                   // UUID, client-generated
  amount_base_units: string;          // positive bigint string
  memo?: string;                      // optional, max 64 chars
  client_signature_base58: string;
}

export interface ClaimCreateResponse {
  ok: true;
  claim_id: string;
  amount_base_units: string;
  memo?: string;
  created_at: string;
}

/** GET /claim/:id (public) */
export interface ClaimStatusResponse {
  claim_id: string;
  amount_base_units: string;
  memo?: string;
  state: ClaimState;
  created_at: string;
  redeemed_at?: string;
  cancelled_at?: string;
}

/** GET /claim?my=pending (session) — sender's own claims */
export interface MyClaimsResponse {
  claims: ClaimStatusResponse[];
}

/** POST /claim/:id/redeem (session) */
export interface ClaimRedeemResponse {
  ok: true;
  amount_base_units: string;
  transfer_id: string;
  redeemed_at: string;
}

/**
 * POST /claim/:id/cancel body (session + sig).
 * Signs canonicalMessage('claim.cancel', { claim_id }).
 */
export interface ClaimCancelRequestBody {
  client_signature_base58: string;
}

export interface ClaimCancelResponse {
  ok: true;
  amount_base_units: string;
  cancelled_at: string;
}
