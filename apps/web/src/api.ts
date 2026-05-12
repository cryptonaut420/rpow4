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
  MeResponse,
  MintRequestBody,
  MintResponse,
  MyClaimsResponse,
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
