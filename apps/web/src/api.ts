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
  me: () => call<MeResponse>('GET', '/me'),
  activity: (cursor?: string, limit?: number, type?: 'mint' | 'send' | 'receive') => {
    const qs = new URLSearchParams();
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    if (type) qs.set('type', type);
    const suffix = qs.toString();
    return call<ActivityResponse>('GET', `/activity${suffix ? `?${suffix}` : ''}`);
  },
  ledger: () => call<LedgerResponse>('GET', '/ledger'),
  ledgerStats: () => call<LedgerResponse>('GET', '/ledger/stats'),
  ledgerEvents: (cursor?: string, limit?: number) => {
    const qs = new URLSearchParams();
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    const suffix = qs.toString();
    return call<LedgerEventsResponse>('GET', `/ledger/events${suffix ? `?${suffix}` : ''}`);
  },
  leaderboard: (sort: LeaderboardSort = 'balance') =>
    call<LeaderboardResponse>('GET', `/stats/leaderboard?sort=${sort}`),
  lookup: (name: string) => call<LookupResponse>('GET', `/lookup/${encodeURIComponent(name)}`),

  // Explorer (public)
  explorerFeed: (
    cursor?: string,
    limit?: number,
    type: 'all' | 'mint' | 'transfer' = 'all',
  ) => {
    const qs = new URLSearchParams();
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    if (type !== 'all') qs.set('type', type);
    const suffix = qs.toString();
    return call<ExplorerFeedResponse>('GET', `/explorer/feed${suffix ? `?${suffix}` : ''}`);
  },
  explorerTx: (id: string) => call<ExplorerTxResponse>('GET', `/explorer/tx/${encodeURIComponent(id)}`),
  explorerAccount: (pubkey: string, cursor?: string, limit?: number) => {
    const qs = new URLSearchParams();
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    const suffix = qs.toString();
    return call<ExplorerAccountResponse>('GET', `/explorer/account/${encodeURIComponent(pubkey)}${suffix ? `?${suffix}` : ''}`);
  },

  // Faucet (public)
  faucet: () => call<FaucetStatusResponse>('GET', '/faucet'),
  faucetClaim: () => call<FaucetClaimResponse>('POST', '/faucet/claim', {}),

  // Pool mining (auth required for challenge / share; stats has anon view)
  poolChallenge: () => call<PoolChallengeResponse>('POST', '/pool/challenge', {}),
  poolShare: (b: PoolShareRequestBody) => call<PoolShareResponse>('POST', '/pool/share', b),
  poolStats: () => call<PoolStatsResponse>('GET', '/pool/stats'),

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
  challenge: () => call<ChallengeResponse>('POST', '/challenge'),
  mint: (b: MintRequestBody) => call<MintResponse>('POST', '/mint', b),
  send: (b: SendRequestBody) => call<SendResponse>('POST', '/send', b),
  setDisplayName: (b: SetDisplayNameRequestBody) =>
    call<SetDisplayNameResponse>('POST', '/me/display_name', b),
};
