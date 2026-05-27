import type {
  ActivityResponse,
  ApiError,
  AuthChallengeRequestBody,
  AuthChallengeResponse,
  AuthSessionRequestBody,
  AuthSessionResponse,
  ChallengeResponse,
  ClaimCancelRequestBody,
  ClaimCancelResponse,
  ClaimCreateRequestBody,
  ClaimCreateResponse,
  ClaimRedeemResponse,
  ClaimStatusResponse,
  ExplorerAccountResponse,
  ExplorerFeedResponse,
  ExplorerTxResponse,
  FaucetClaimResponse,
  FaucetStatusResponse,
  PoolChallengeResponse,
  PoolRoundsResponse,
  PoolShareRequestBody,
  PoolShareResponse,
  PoolStatsResponse,
  LeaderboardResponse,
  LeaderboardSort,
  LedgerEventsResponse,
  LedgerResponse,
  LookupResponse,
  MarketBalancesResponse,
  MarketBookResponse,
  MarketCandlesResponse,
  MarketDetailResponse,
  MarketOrderCancelRequestBody,
  MarketOrderCancelResponse,
  MarketOrderCreateRequestBody,
  MarketOrderCreateResponse,
  MarketOrdersResponse,
  MarketTradesResponse,
  MarketsResponse,
  MeBalancesResponse,
  MeResponse,
  MintRequestBody,
  MintResponse,
  MyClaimsResponse,
  NewsCreateRequestBody,
  NewsCreateResponse,
  NewsDetailResponse,
  NewsListResponse,
  SendRequestBody,
  SendResponse,
  SetDisplayNameRequestBody,
  SetDisplayNameResponse,
  SignupChallengeRequestBody,
  SignupChallengeResponse,
  SignupRequestBody,
  SignupResponse,
  TrollboxFeedResponse,
  TrollboxPostRequestBody,
  TrollboxPostResponse,
} from '@rpow/shared';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080';

export interface AssetSummary {
  id: string;
  slug: string;
  display_code: string;
  nickname: string;
  description: string;
  asset_kind: 'mineable' | 'external_custodial';
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
export interface AssetsResponse { assets: AssetSummary[]; default_asset_slug: string; launch_burn_base_units: string }
export interface AssetDetailResponse { asset: AssetSummary; schedule: Record<string, unknown> }
export type LaunchAssetRequestBody = Record<string, unknown> & { nickname: string };
export interface LaunchAssetResponse { ok: true; asset: AssetSummary; launch_burn_event_id: string; launch_burn_base_units: string }

export interface Rpow2CustodyDeposit {
  id: string;
  sender_external_id: string;
  raw_memo: string | null;
  amount_base_units: string;
  status: 'credited' | 'unattributed' | 'ignored';
  external_observed_at: string;
  credited_at: string | null;
  credited_event_id: string | null;
}
export interface Rpow2CustodyWithdrawal {
  id: string;
  requester_pubkey?: string;
  requester_display_name?: string | null;
  destination_external_id: string;
  amount_base_units: string;
  status: 'pending_approval' | 'sending' | 'sent' | 'rejected' | 'failed';
  failure_reason: string | null;
  external_transfer_id: string | null;
  burn_event_id: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  sent_at: string | null;
  rejected_at: string | null;
}
export interface Rpow2UnattributedDeposit {
  id: string;
  sender_external_id: string;
  raw_memo: string | null;
  amount_base_units: string;
  external_observed_at: string;
  created_at: string;
  note: string | null;
}
export interface Rpow2CustodyUserStats {
  deposits_credited: number;
  deposits_credited_amount_base_units: string;
  withdrawals_sent: number;
  withdrawals_sent_amount_base_units: string;
}
export interface Rpow2CustodyAggregates {
  deposits_credited: number;
  deposits_credited_amount_base_units: string;
  deposits_unattributed: number;
  deposits_unattributed_amount_base_units: string;
  withdrawals_pending: number;
  withdrawals_pending_amount_base_units: string;
  withdrawals_sending: number;
  withdrawals_sending_amount_base_units: string;
  withdrawals_failed: number;
  withdrawals_failed_amount_base_units: string;
  withdrawals_sent: number;
  withdrawals_sent_amount_base_units: string;
  withdrawals_rejected: number;
  withdrawals_rejected_amount_base_units: string;
  treasury_spendable_base_units: string;
  manual_credits: number;
  manual_credits_amount_base_units: string;
  manual_debits: number;
  manual_debits_amount_base_units: string;
  total_user_balance_base_units: string;
}
export interface Rpow2CustodyStatusResponse {
  asset_id: string;
  provider_key: 'rpow2';
  configured: boolean;
  api_base_url?: string;
  banker_email?: string;
  deposit_enabled: boolean;
  withdrawal_enabled: boolean;
  sync: {
    cursor_at: string | null;
    last_run_at: string | null;
    last_success_at: string | null;
    last_error: string | null;
    paused: boolean;
  };
  user_stats: Rpow2CustodyUserStats | null;
  deposits: Rpow2CustodyDeposit[];
  withdrawals: Rpow2CustodyWithdrawal[];
}
export interface Rpow2CustodyAdminResponse extends Rpow2CustodyStatusResponse {
  aggregates: Rpow2CustodyAggregates;
  pending_withdrawals: Rpow2CustodyWithdrawal[];
  sending_withdrawals: Rpow2CustodyWithdrawal[];
  unattributed_deposits: Rpow2UnattributedDeposit[];
}
export interface Rpow2DepositSyncResponse { ok: true; processed: number; credited: number; unattributed: number; skipped: number }
export interface Rpow2WithdrawalRequestBody { destination_email: string; amount_base_units: string }
export interface Rpow2WithdrawalCreateResponse { ok: true; id: string; status: 'pending_approval' }
export interface Rpow2WithdrawalActionResponse { ok: true; id: string; status?: string; external_transfer_id?: string | null; burn_event_id?: string | null }
export interface Rpow2ManualAdjustBody { handle_or_pubkey: string; amount_base_units: string; memo?: string }
export interface Rpow2ManualAdjustResponse { ok: true; pubkey: string; display_name: string | null; amount_base_units: string; event_id: string }

function assetPath(assetSlug: string | undefined, path: string): string {
  if (!assetSlug || assetSlug === 'rpow4-0') return path;
  return `/assets/${encodeURIComponent(assetSlug)}${path}`;
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  init?: Pick<RequestInit, 'cache' | 'headers'>,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    cache: init?.cache ?? 'default',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let err: ApiError;
    try { err = await res.json(); } catch { err = { error: 'INTERNAL', message: res.statusText }; }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  assets: () => call<AssetsResponse>('GET', '/assets'),
  asset: (slug: string) => call<AssetDetailResponse>('GET', `/assets/${encodeURIComponent(slug)}`),
  launchAsset: (b: LaunchAssetRequestBody) => call<LaunchAssetResponse>('POST', '/assets', b),

  // Auth — pubkey-based two-step flow
  authChallenge: (b: AuthChallengeRequestBody) =>
    call<AuthChallengeResponse>('POST', '/auth/challenge', b),
  authSession: (b: AuthSessionRequestBody) =>
    call<AuthSessionResponse>('POST', '/auth/session', b),
  logout: () => call<{ ok: true }>('POST', '/auth/logout'),

  // Signup — handle reservation + PoW-gated account registration
  signupChallenge: (b: SignupChallengeRequestBody) =>
    call<SignupChallengeResponse>('POST', '/signup/challenge', b),
  signup: (b: SignupRequestBody) => call<SignupResponse>('POST', '/signup', b),

  // Read endpoints
  me: (assetSlug?: string) => call<MeResponse>('GET', assetPath(assetSlug, '/me')),
  balances: () => call<MeBalancesResponse>('GET', '/me/balances', undefined, { cache: 'no-store' }),
  activity: (cursor?: string, limit?: number, type?: 'mint' | 'send' | 'receive' | 'burn' | 'genesis', assetSlug?: string) => {
    const qs = new URLSearchParams();
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    if (type) qs.set('type', type);
    const suffix = qs.toString();
    return call<ActivityResponse>('GET', `${assetPath(assetSlug, '/activity')}${suffix ? `?${suffix}` : ''}`);
  },
  ledger: (assetSlug?: string) => call<LedgerResponse>('GET', assetPath(assetSlug, '/ledger')),
  ledgerStats: (assetSlug?: string) => call<LedgerResponse>('GET', assetPath(assetSlug, '/ledger/stats')),
  ledgerEvents: (cursor?: string, limit?: number, assetSlug?: string) => {
    const qs = new URLSearchParams();
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    const suffix = qs.toString();
    return call<LedgerEventsResponse>('GET', `${assetPath(assetSlug, '/ledger/events')}${suffix ? `?${suffix}` : ''}`);
  },
  leaderboard: (sort: LeaderboardSort = 'balance', assetSlug?: string) =>
    call<LeaderboardResponse>('GET', `${assetPath(assetSlug, '/stats/leaderboard')}?sort=${sort}`),
  lookup: (name: string) => call<LookupResponse>('GET', `/lookup/${encodeURIComponent(name)}`),

  // Explorer (public)
  explorerFeed: (
    cursor?: string,
    limit?: number,
    type: 'all' | 'mint' | 'transfer' | 'burn' | 'genesis_allocation' = 'all',
    assetSlug?: string,
  ) => {
    const qs = new URLSearchParams();
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    if (type !== 'all') qs.set('type', type);
    const suffix = qs.toString();
    return call<ExplorerFeedResponse>('GET', `${assetPath(assetSlug, '/explorer/feed')}${suffix ? `?${suffix}` : ''}`);
  },
  explorerTx: (id: string, assetSlug?: string) => call<ExplorerTxResponse>('GET', assetPath(assetSlug, `/explorer/tx/${encodeURIComponent(id)}`)),
  explorerAccount: (
    pubkey: string,
    cursor?: string,
    limit?: number,
    type: 'all' | 'mint' | 'send' | 'receive' | 'burn' | 'genesis' = 'all',
    assetSlug?: string,
  ) => {
    const qs = new URLSearchParams();
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    if (type !== 'all') qs.set('type', type);
    const suffix = qs.toString();
    return call<ExplorerAccountResponse>('GET', `${assetPath(assetSlug, `/explorer/account/${encodeURIComponent(pubkey)}`)}${suffix ? `?${suffix}` : ''}`);
  },

  // Faucet (public)
  faucet: () => call<FaucetStatusResponse>('GET', '/faucet'),
  faucetClaim: () => call<FaucetClaimResponse>('POST', '/faucet/claim', {}),

  // Pool mining (auth required for challenge / share; stats has anon view)
  poolChallenge: (assetSlug?: string) => call<PoolChallengeResponse>('POST', assetPath(assetSlug, '/pool/challenge'), {}),
  poolShare: (b: PoolShareRequestBody, assetSlug?: string) => call<PoolShareResponse>('POST', assetPath(assetSlug, '/pool/share'), b),
  poolStats: (assetSlug?: string) => call<PoolStatsResponse>('GET', assetPath(assetSlug, '/pool/stats')),
  poolRounds: (cursor?: string, limit?: number, assetSlug?: string) => {
    const qs = new URLSearchParams();
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    const suffix = qs.toString();
    return call<PoolRoundsResponse>('GET', `${assetPath(assetSlug, '/pool/rounds')}${suffix ? `?${suffix}` : ''}`);
  },

  // Internal RPOW markets
  markets: () => call<MarketsResponse>('GET', '/markets', undefined, { cache: 'no-store' }),
  market: (marketId: string) => call<MarketDetailResponse>('GET', `/markets/${encodeURIComponent(marketId)}`, undefined, { cache: 'no-store' }),
  marketBook: (marketId: string) => call<MarketBookResponse>('GET', `/markets/${encodeURIComponent(marketId)}/book`, undefined, { cache: 'no-store' }),
  marketTrades: (marketId: string, limit = 50) => call<MarketTradesResponse>('GET', `/markets/${encodeURIComponent(marketId)}/trades?limit=${limit}`, undefined, { cache: 'no-store' }),
  marketCandles: (marketId: string, interval: '1m' | '5m' | '1h' | '1d' = '1m', limit = 80) =>
    call<MarketCandlesResponse>('GET', `/markets/${encodeURIComponent(marketId)}/candles?interval=${interval}&limit=${limit}`, undefined, { cache: 'no-store' }),
  marketBalances: (marketId: string) => call<MarketBalancesResponse>('GET', `/markets/${encodeURIComponent(marketId)}/balances`, undefined, { cache: 'no-store' }),
  myMarketOrders: (marketId: string) => call<MarketOrdersResponse>('GET', `/markets/${encodeURIComponent(marketId)}/my-orders`, undefined, { cache: 'no-store' }),
  createMarketOrder: (marketId: string, b: MarketOrderCreateRequestBody) =>
    call<MarketOrderCreateResponse>('POST', `/markets/${encodeURIComponent(marketId)}/orders`, b),
  cancelMarketOrder: (marketId: string, orderId: string, b: MarketOrderCancelRequestBody) =>
    call<MarketOrderCancelResponse>('POST', `/markets/${encodeURIComponent(marketId)}/orders/${encodeURIComponent(orderId)}/cancel`, b),

  // News / changelog
  news: (limit = 25) => call<NewsListResponse>('GET', `/news?limit=${limit}`, undefined, { cache: 'no-store' }),
  newsPost: (slug: string) => call<NewsDetailResponse>('GET', `/news/${encodeURIComponent(slug)}`, undefined, { cache: 'no-store' }),
  createNewsPost: (b: NewsCreateRequestBody) => call<NewsCreateResponse>('POST', '/news', b),

  // RPOW2 deposits + withdrawals
  rpow2Custody: () => call<Rpow2CustodyStatusResponse>('GET', '/custody/rpow2', undefined, { cache: 'no-store' }),
  syncRpow2Deposits: () => call<Rpow2DepositSyncResponse>('POST', '/custody/rpow2/sync', {}),
  createRpow2Withdrawal: (b: Rpow2WithdrawalRequestBody) =>
    call<Rpow2WithdrawalCreateResponse>('POST', '/custody/rpow2/withdrawals', b),
  adminRpow2Custody: () => call<Rpow2CustodyAdminResponse>('GET', '/admin/custody/rpow2', undefined, { cache: 'no-store' }),
  adminSyncRpow2Deposits: () => call<Rpow2DepositSyncResponse>('POST', '/admin/custody/rpow2/sync', {}),
  adminResumeRpow2Sync: () => call<{ ok: true }>('POST', '/admin/custody/rpow2/resume', {}),
  approveRpow2Withdrawal: (id: string) =>
    call<Rpow2WithdrawalActionResponse>('POST', `/admin/custody/rpow2/withdrawals/${encodeURIComponent(id)}/approve`, {}),
  completeRpow2Withdrawal: (id: string) =>
    call<Rpow2WithdrawalActionResponse>('POST', `/admin/custody/rpow2/withdrawals/${encodeURIComponent(id)}/complete`, {}),
  rejectRpow2Withdrawal: (id: string) =>
    call<Rpow2WithdrawalActionResponse>('POST', `/admin/custody/rpow2/withdrawals/${encodeURIComponent(id)}/reject`, {}),
  assignRpow2Deposit: (id: string, pubkey: string) =>
    call<Rpow2WithdrawalActionResponse>('POST', `/admin/custody/rpow2/deposits/${encodeURIComponent(id)}/assign`, { pubkey }),
  adminCreditRpow2: (body: Rpow2ManualAdjustBody) =>
    call<Rpow2ManualAdjustResponse>('POST', '/admin/custody/rpow2/credit', body),
  adminDebitRpow2: (body: Rpow2ManualAdjustBody) =>
    call<Rpow2ManualAdjustResponse>('POST', '/admin/custody/rpow2/debit', body),

  // Trollbox (public read, signed write)
  trollbox: (cursor?: string, limit?: number) => {
    const qs = new URLSearchParams();
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    const suffix = qs.toString();
    return call<TrollboxFeedResponse>('GET', `/trollbox${suffix ? `?${suffix}` : ''}`, undefined, {
      cache: 'no-store',
    });
  },
  trollboxPost: (b: TrollboxPostRequestBody) =>
    call<TrollboxPostResponse>('POST', '/trollbox', b),

  // Claim tokens (offline bearer transfers)
  createClaim: (b: ClaimCreateRequestBody) =>
    call<ClaimCreateResponse>('POST', '/claim', b),
  getClaim: (id: string) =>
    call<ClaimStatusResponse>('GET', `/claim/${encodeURIComponent(id)}`),
  myClaims: () =>
    call<MyClaimsResponse>('GET', '/claim'),
  redeemClaim: (id: string) =>
    call<ClaimRedeemResponse>('POST', `/claim/${encodeURIComponent(id)}/redeem`, {}),
  cancelClaim: (id: string, b: ClaimCancelRequestBody) =>
    call<ClaimCancelResponse>('POST', `/claim/${encodeURIComponent(id)}/cancel`, b),

  // Write endpoints — bodies must already include client_signature_base58
  challenge: (assetSlug?: string) => call<ChallengeResponse>('POST', assetPath(assetSlug, '/challenge')),
  mint: (b: MintRequestBody, assetSlug?: string) => call<MintResponse>('POST', assetPath(assetSlug, '/mint'), b),
  send: (b: SendRequestBody, assetSlug?: string) => call<SendResponse>('POST', assetPath(assetSlug, '/send'), b),
  setDisplayName: (b: SetDisplayNameRequestBody) =>
    call<SetDisplayNameResponse>('POST', '/me/display_name', b),
};
