import type {
  ActivityResponse,
  ApiError,
  AuthChallengeRequestBody,
  AuthChallengeResponse,
  AuthSessionRequestBody,
  AuthSessionResponse,
  ChallengeResponse,
  LeaderboardResponse,
  LeaderboardSort,
  LedgerEventsResponse,
  LedgerResponse,
  LookupResponse,
  MeResponse,
  MintRequestBody,
  MintResponse,
  SendRequestBody,
  SendResponse,
  SetDisplayNameRequestBody,
  SetDisplayNameResponse,
  SignupChallengeRequestBody,
  SignupChallengeResponse,
  SignupRequestBody,
  SignupResponse,
} from '@rpow/shared';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
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
  activity: (cursor?: string, limit?: number) => {
    const qs = new URLSearchParams();
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
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

  // Write endpoints — bodies must already include client_signature_base58
  challenge: () => call<ChallengeResponse>('POST', '/challenge'),
  mint: (b: MintRequestBody) => call<MintResponse>('POST', '/mint', b),
  send: (b: SendRequestBody) => call<SendResponse>('POST', '/send', b),
  setDisplayName: (b: SetDisplayNameRequestBody) =>
    call<SetDisplayNameResponse>('POST', '/me/display_name', b),
};
