import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { useMe } from '../hooks/useMe.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { api } from '../api.js';
import { formatRpow } from '../lib/format.js';
import { estimateHashrate, type HashrateEstimate } from '../lib/hashrate.js';
import type { MiningVisualizerHandles } from '../components/MiningVisualizer.js';
import type { LedgerResponse, MeResponse, PoolStatsResponse } from '@rpow/shared';

// ---------------------------------------------------------------------------
// MiningProvider
//
// Lifts the entire mining state machine out of <MinePage> into a singleton
// context that lives for the lifetime of the app shell. This is what makes
// mining "sticky" across page navigation: the worker, all per-run counters,
// and the refresh loop keep running while the user browses to /send,
// /activity, etc.
//
// Consumers (currently <MiningBar>) read live counters from refs to avoid
// triggering provider-wide re-renders on every coin solved.
// ---------------------------------------------------------------------------

type MiningStatus = 'idle' | 'mining' | 'error';
export type MiningMode = 'solo' | 'pool';

const MODE_STORAGE_KEY = 'rpow.mining.mode';

function loadMode(): MiningMode {
  // Default: pool. Pool mode pays out more often, has lower variance,
  // and is the friendlier first experience for anyone who hasn't
  // explicitly chosen. A previously-saved preference (including the
  // earlier solo default) wins — once a user has clicked the MODE
  // toggle, we honour their choice.
  try {
    const v = localStorage.getItem(MODE_STORAGE_KEY);
    if (v === 'solo' || v === 'pool') return v;
  } catch { /* private mode / SSR */ }
  return 'pool';
}

// Throttle background /me + /ledger refreshes during continuous mining
// to about once per second.
const REFRESH_THROTTLE_MS = 1000;
// Pool stats poll cadence while pool-mining. The server caches at 2s so
// 3s is a safe rate that doesn't flood the cache miss path.
const POOL_STATS_POLL_MS = 3000;

export interface MiningContextValue {
  // ── React state ──────────────────────────────────────────────────────────
  // These trigger re-renders when they change.
  status: MiningStatus;
  target: number | null;
  error: string;
  ledger: LedgerResponse | null;
  bench: HashrateEstimate | null;

  // /me proxied from the provider's own useMe so the bar's balance stays
  // current after every successful mint without each consumer needing its
  // own refresh logic.
  me: MeResponse | null;
  refresh(): Promise<void>;

  // ── Live refs ────────────────────────────────────────────────────────────
  // High-frequency counters held in refs. Consumers tick at ~250ms and read
  // these directly so mining doesn't dirty the React tree on every hash.
  totalHashesRef: MutableRefObject<bigint>;
  currentCycleHashesRef: MutableRefObject<bigint>;
  sessionStartedAtRef: MutableRefObject<number>;
  sessionStoppedAtRef: MutableRefObject<number>;
  sessionMintedRef: MutableRefObject<number>;
  /** Pool-only: count of accepted shares submitted this run. */
  sessionSharesRef: MutableRefObject<number>;
  /** Pool-only: aggregate base-units credited to the caller across all
   * payouts (finder bonus + pro-rata) since this mining session started. */
  sessionPoolPayoutBaseUnitsRef: MutableRefObject<bigint>;
  lastTokenIdRef: MutableRefObject<string>;

  // Latest hash observed by the worker. The bar's collapsed view samples
  // these refs to render the running hash stream without going through React.
  bestHashHexRef: MutableRefObject<string>;
  bestNonceHexRef: MutableRefObject<string>;
  bestZerosRef: MutableRefObject<number>;
  hashesPerSecRef: MutableRefObject<number>;

  // The full <MiningVisualizer> mounts only when the bar is expanded; this
  // ref is what wires its imperative API back to the worker callback in
  // the provider. While the visualizer isn't mounted the calls become no-ops.
  vizHandlesRef: MutableRefObject<MiningVisualizerHandles | null>;

  // ── Mode + pool state ────────────────────────────────────────────────────
  /** 'solo' = current behaviour (100% to finder, network difficulty).
   * 'pool' = shares submitted to /pool/share, rewards split per the
   * server distribution rules. */
  mode: MiningMode;
  setMode(mode: MiningMode): void;
  /** Latest snapshot from /pool/stats while pool-mining. null until first
   * poll completes. */
  poolStats: PoolStatsResponse | null;

  // ── Actions ──────────────────────────────────────────────────────────────
  start(): void;
  stop(): void;
}

const MiningContext = createContext<MiningContextValue | null>(null);

export function useMining(): MiningContextValue {
  const ctx = useContext(MiningContext);
  if (!ctx) throw new Error('useMining() must be inside <MiningProvider>');
  return ctx;
}

export function MiningProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const { me, refresh } = useMe();

  const [status, setStatus] = useState<MiningStatus>('idle');
  const [target, setTarget] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [bench, setBench] = useState<HashrateEstimate | null>(null);
  const [mode, setModeState] = useState<MiningMode>(() => loadMode());
  const [poolStats, setPoolStats] = useState<PoolStatsResponse | null>(null);
  const setMode = useCallback((next: MiningMode) => {
    try { localStorage.setItem(MODE_STORAGE_KEY, next); } catch { /* private mode */ }
    setModeState(next);
  }, []);

  // Worker handle + stop signal. Refs (not state) so the recursive
  // worker callback always sees the latest value without restarting.
  const workerRef = useRef<Worker | null>(null);
  const stopRequestedRef = useRef(false);

  // Per-run counters that move every coin. Held in refs and read by the
  // bar's display tick to keep React out of the per-coin write path.
  const sessionStartedAtRef = useRef(0);
  const sessionStoppedAtRef = useRef(0);
  const totalHashesRef = useRef(0n);
  const currentCycleHashesRef = useRef(0n);
  const sessionMintedRef = useRef(0);
  const sessionSharesRef = useRef(0);
  const sessionPoolPayoutBaseUnitsRef = useRef(0n);
  const lastTokenIdRef = useRef('');
  // Track the last round id we've observed so the polling loop can
  // detect "a round we participated in just closed" and surface the
  // payout to the user (the worker only knows about its own block-
  // finding shares, not pool wins by other miners).
  const lastSeenRoundIdRef = useRef<string | null>(null);

  // Live progress mirrored from worker `progress` events. The expanded
  // visualizer also receives these via its imperative handle, but the
  // collapsed bar reads these refs directly.
  const bestHashHexRef = useRef('');
  const bestNonceHexRef = useRef('');
  const bestZerosRef = useRef(-1);
  const hashesPerSecRef = useRef(0);

  // Imperative handle for the cypherpunk visualizer. Driven from worker
  // progress events and the mint success path, never via React state, so
  // hash-rain frames and per-block FX don't trigger a tree re-render.
  const vizHandlesRef = useRef<MiningVisualizerHandles | null>(null);

  // /me + /ledger background refresh throttle.
  const lastRefreshAtRef = useRef(0);

  // Pull halving info on mount and after each successful refresh batch
  // so the "next halving at" countdown stays roughly current.
  const refreshLedger = useCallback(() => {
    api.ledger().then(setLedger).catch(() => {});
  }, []);

  useEffect(() => {
    refreshLedger();
  }, [refreshLedger]);

  // One-shot CPU benchmark on mount so we can show the user how long a
  // typical solve will take at the current difficulty *before* they
  // start. Not wired into the actual mining loop — purely informational.
  useEffect(() => {
    let cancelled = false;
    estimateHashrate({ duration_ms: 1200 })
      .then((r) => { if (!cancelled) setBench(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Single source of truth for "tear down any running mining cycle". The
  // worker's busy SHA loop is fully synchronous, so postMessage({type:'abort'})
  // would just sit in its incoming queue until the next solve completes —
  // worker.terminate() is the only primitive that interrupts a CPU-bound
  // worker promptly. Used by stop(), the wallet-lock guard, and the unmount
  // teardown so all three paths behave identically.
  const tearDownMining = useCallback(() => {
    stopRequestedRef.current = true;
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    sessionStoppedAtRef.current = performance.now();
    vizHandlesRef.current?.setActive(false);
    setStatus('idle');
  }, []);

  // Hard stop on unmount (e.g. tab closed, app HMR). The worker holds a
  // network connection-ish thing (pulls challenges + posts mints) so we
  // explicitly terminate rather than letting it leak.
  useEffect(() => () => {
    stopRequestedRef.current = true;
    workerRef.current?.terminate();
    if (challengeRenewTimerRef.current !== null) {
      window.clearTimeout(challengeRenewTimerRef.current);
      challengeRenewTimerRef.current = null;
    }
  }, []);

  // If the wallet locks (logout, lock-after-idle, etc.) while mining is
  // running, abort cleanly. Mining requires `wallet.sign(...)` to mint
  // each coin; without an unlocked wallet the next mint would throw.
  useEffect(() => {
    if (status === 'mining' && wallet.status !== 'unlocked') {
      tearDownMining();
    }
  }, [wallet.status, status, tearDownMining]);

  // Combined throttled balance + ledger refresh. Pass `force: true` to
  // bypass the throttle (e.g. on STOP).
  const refreshAccount = useCallback((opts: { force?: boolean } = {}) => {
    const now = performance.now();
    if (!opts.force && now - lastRefreshAtRef.current < REFRESH_THROTTLE_MS) return;
    lastRefreshAtRef.current = now;
    void refresh();
    refreshLedger();
  }, [refresh, refreshLedger]);

  // Recursive solve loop. Identical to the previous MinePage logic so the
  // existing UX (visualizer FX, mint flow, error handling) is preserved.
  const startOne = useCallback(async () => {
    if (stopRequestedRef.current) {
      sessionStoppedAtRef.current = performance.now();
      setStatus('idle');
      return;
    }
    currentCycleHashesRef.current = 0n;

    let ch;
    try {
      ch = await api.challenge();
    } catch (err: any) {
      sessionStoppedAtRef.current = performance.now();
      vizHandlesRef.current?.setActive(false);
      setError(err?.message ?? 'failed to fetch challenge');
      setStatus('error');
      return;
    }
    // The user can click STOP while we were awaiting the challenge fetch.
    // Honor it before we even create the next worker — otherwise we'd
    // spawn a new busy loop the user just asked us not to.
    if (stopRequestedRef.current) {
      sessionStoppedAtRef.current = performance.now();
      vizHandlesRef.current?.setActive(false);
      setStatus('idle');
      return;
    }
    setTarget(ch.difficulty_bits);

    const w = new Worker(new URL('../miner.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = w;
    w.onmessage = async (e: MessageEvent<any>) => {
      const m = e.data;
      if (m.type === 'progress') {
        currentCycleHashesRef.current = BigInt(m.hashes);
        // Mirror progress into the provider's own refs so collapsed
        // consumers (the bar) can read without an imperative handle.
        if (typeof m.best_hash_hex === 'string') bestHashHexRef.current = m.best_hash_hex;
        if (typeof m.best_nonce_hex === 'string') bestNonceHexRef.current = m.best_nonce_hex;
        if (typeof m.best_zeros === 'number') bestZerosRef.current = m.best_zeros;
        const elapsedSec = Math.max(1, m.elapsed_ms) / 1000;
        const cycleHashes = Number(BigInt(m.hashes));
        hashesPerSecRef.current = cycleHashes / elapsedSec;
        // And forward to the visualizer if it's currently mounted.
        if (vizHandlesRef.current) {
          vizHandlesRef.current.setProgress({
            bestZeros: typeof m.best_zeros === 'number' ? m.best_zeros : -1,
            bestHashHex: typeof m.best_hash_hex === 'string' ? m.best_hash_hex : '',
            bestNonceHex: typeof m.best_nonce_hex === 'string' ? m.best_nonce_hex : '',
            currentHashHex: typeof m.current_hash_hex === 'string' ? m.current_hash_hex : '',
            currentZeros: typeof m.current_zeros === 'number' ? m.current_zeros : -1,
            currentNonceHex: typeof m.current_nonce_hex === 'string' ? m.current_nonce_hex : '',
            hashesPerSec: hashesPerSecRef.current,
            cycleHashes,
          });
        }
        return;
      }
      if (m.type === 'aborted') {
        w.terminate(); workerRef.current = null;
        sessionStoppedAtRef.current = performance.now();
        vizHandlesRef.current?.setActive(false);
        setStatus('idle');
        return;
      }
      if (m.type === 'found') {
        w.terminate(); workerRef.current = null;
        try {
          const mintBody = { challenge_id: ch.challenge_id, solution_nonce: m.solution_nonce };
          const r = await api.mint({
            challenge_id: ch.challenge_id,
            nonce_prefix: ch.nonce_prefix,
            difficulty_bits: ch.difficulty_bits,
            issued_at: ch.issued_at,
            expires_at: ch.expires_at,
            challenge_mac: ch.challenge_mac,
            solution_nonce: m.solution_nonce,
            client_signature_base58: wallet.sign('mint', mintBody),
          });
          totalHashesRef.current += BigInt(m.hashes);
          currentCycleHashesRef.current = 0n;
          sessionMintedRef.current += 1;
          lastTokenIdRef.current = r.token.id;
          if (vizHandlesRef.current) {
            const reward = ledger
              ? `+${formatRpow(ledger.current_reward_base_units)} RPOW credited`
              : 'block credited';
            const nonceHex = BigInt(m.solution_nonce).toString(16).padStart(16, '0');
            vizHandlesRef.current.triggerWin({
              hashHex: typeof m.hash_hex === 'string' ? m.hash_hex : '',
              nonceHex,
              rewardLabel: reward,
              blockHeight: ledger?.block_height,
            });
          }
          refreshAccount();

          if (!stopRequestedRef.current) {
            startOne();
          } else {
            sessionStoppedAtRef.current = performance.now();
            vizHandlesRef.current?.setActive(false);
            setStatus('idle');
            refreshAccount({ force: true });
          }
        } catch (err: any) {
          sessionStoppedAtRef.current = performance.now();
          vizHandlesRef.current?.setActive(false);
          setError(err?.message ?? 'mint failed');
          setStatus('error');
        }
      }
    };
    w.postMessage({ type: 'start', nonce_prefix: ch.nonce_prefix, difficulty_bits: ch.difficulty_bits });
  }, [ledger, refreshAccount, wallet]);

  // Pool-mode cycle. The worker streams `share` messages instead of a
  // single terminal `found`; each share gets POSTed to /pool/share. The
  // server attributes the share to the active round and, if the same
  // hash also clears network difficulty, atomically closes the round
  // and fans out per-miner payouts via TRANSFER ledger events.
  const challengeRenewTimerRef = useRef<number | null>(null);
  const startPoolCycle = useCallback(async () => {
    if (stopRequestedRef.current) {
      sessionStoppedAtRef.current = performance.now();
      setStatus('idle');
      return;
    }
    currentCycleHashesRef.current = 0n;

    let ch;
    try {
      ch = await api.poolChallenge();
    } catch (err: any) {
      // If the operator disabled the pool, fall through to solo so the
      // user keeps mining instead of getting stuck in an error state.
      if (err?.error === 'POOL_DISABLED') {
        setMode('solo');
        setError('pool mining is disabled — switched to solo mode');
        startOne();
        return;
      }
      sessionStoppedAtRef.current = performance.now();
      vizHandlesRef.current?.setActive(false);
      setError(err?.message ?? 'failed to fetch pool challenge');
      setStatus('error');
      return;
    }
    if (stopRequestedRef.current) {
      sessionStoppedAtRef.current = performance.now();
      vizHandlesRef.current?.setActive(false);
      setStatus('idle');
      return;
    }
    setTarget(ch.network_difficulty_bits);

    // Renew the challenge ~30s before expiry so the worker doesn't burn
    // CPU on hashes that would be rejected with CHALLENGE_EXPIRED. The
    // server gives us 5 min by default; we cut it short to leave slack
    // for in-flight share submissions.
    if (challengeRenewTimerRef.current !== null) {
      window.clearTimeout(challengeRenewTimerRef.current);
    }
    const expiresMs = Date.parse(ch.expires_at);
    const renewInMs = Math.max(15_000, expiresMs - Date.now() - 30_000);
    challengeRenewTimerRef.current = window.setTimeout(() => {
      if (stopRequestedRef.current) return;
      // Tear the current worker down and start a fresh cycle. The new
      // challenge gets a new nonce_prefix so there's no collision risk
      // with shares already submitted under the old challenge.
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      startPoolCycle();
    }, renewInMs) as unknown as number;

    const w = new Worker(new URL('../miner.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = w;
    w.onmessage = async (e: MessageEvent<any>) => {
      const m = e.data;
      if (m.type === 'progress') {
        currentCycleHashesRef.current = BigInt(m.hashes);
        if (typeof m.best_hash_hex === 'string') bestHashHexRef.current = m.best_hash_hex;
        if (typeof m.best_nonce_hex === 'string') bestNonceHexRef.current = m.best_nonce_hex;
        if (typeof m.best_zeros === 'number') bestZerosRef.current = m.best_zeros;
        const elapsedSec = Math.max(1, m.elapsed_ms) / 1000;
        const cycleHashes = Number(BigInt(m.hashes));
        hashesPerSecRef.current = cycleHashes / elapsedSec;
        if (vizHandlesRef.current) {
          vizHandlesRef.current.setProgress({
            bestZeros: typeof m.best_zeros === 'number' ? m.best_zeros : -1,
            bestHashHex: typeof m.best_hash_hex === 'string' ? m.best_hash_hex : '',
            bestNonceHex: typeof m.best_nonce_hex === 'string' ? m.best_nonce_hex : '',
            currentHashHex: typeof m.current_hash_hex === 'string' ? m.current_hash_hex : '',
            currentZeros: typeof m.current_zeros === 'number' ? m.current_zeros : -1,
            currentNonceHex: typeof m.current_nonce_hex === 'string' ? m.current_nonce_hex : '',
            hashesPerSec: hashesPerSecRef.current,
            cycleHashes,
          });
        }
        return;
      }
      if (m.type === 'aborted') {
        w.terminate();
        if (workerRef.current === w) workerRef.current = null;
        sessionStoppedAtRef.current = performance.now();
        vizHandlesRef.current?.setActive(false);
        setStatus('idle');
        return;
      }
      if (m.type === 'share') {
        // Submit asynchronously; the worker keeps mining. We tally
        // hashes against totalHashesRef as if every share represents
        // 2^share_bits work, since the server only sees shares.
        const shareWork = BigInt(Math.max(1, Math.pow(2, ch.share_difficulty_bits)));
        totalHashesRef.current += shareWork;
        try {
          const sigBody = { challenge_id: ch.challenge_id, solution_nonce: m.solution_nonce };
          const r = await api.poolShare({
            challenge_id: ch.challenge_id,
            nonce_prefix: ch.nonce_prefix,
            network_difficulty_bits: ch.network_difficulty_bits,
            share_difficulty_bits: ch.share_difficulty_bits,
            issued_at: ch.issued_at,
            expires_at: ch.expires_at,
            challenge_mac: ch.challenge_mac,
            solution_nonce: m.solution_nonce,
            client_signature_base58: wallet.sign('pool.share', sigBody),
          });
          // Count any accepted share against the run.
          sessionSharesRef.current += 1;
          if (r.block_won) {
            sessionMintedRef.current += 1;
            if (r.your_payout_base_units) {
              sessionPoolPayoutBaseUnitsRef.current += BigInt(r.your_payout_base_units);
            }
            if (r.round_id) lastSeenRoundIdRef.current = r.round_id;
            if (r.block_event_id) lastTokenIdRef.current = r.block_event_id;
            if (vizHandlesRef.current) {
              const reward = r.your_payout_base_units
                ? `+${formatRpow(r.your_payout_base_units)} RPOW (you found the block!)`
                : 'pool round closed';
              vizHandlesRef.current.triggerWin({
                hashHex: typeof m.hash_hex === 'string' ? m.hash_hex : '',
                nonceHex: BigInt(m.solution_nonce).toString(16).padStart(16, '0'),
                rewardLabel: reward,
                blockHeight: ledger?.block_height,
              });
            }
            refreshAccount();
            // Round closeout invalidates pool stats; refetch eagerly.
            api.poolStats().then(setPoolStats).catch(() => {});
          }
        } catch (err: any) {
          const code = err?.error;
          if (code === 'CHALLENGE_EXPIRED') {
            // Server-side expiry beat the client renewal timer. Restart
            // the cycle with a fresh challenge.
            w.terminate();
            if (workerRef.current === w) workerRef.current = null;
            if (!stopRequestedRef.current) startPoolCycle();
          } else if (code === 'DUPLICATE_SHARE') {
            // Idempotent — the share was already counted on the server.
            // Don't bump our local counter to keep numbers in sync.
          } else if (code === 'POOL_DISABLED') {
            // Operator turned the subsystem off mid-run; fall back to solo.
            tearDownMining();
            setError('pool mining was disabled — switch to solo to keep mining');
          }
          // Any other error is logged but doesn't tear down the worker.
        }
        return;
      }
    };
    w.postMessage({
      type: 'start',
      nonce_prefix: ch.nonce_prefix,
      difficulty_bits: ch.network_difficulty_bits,
      share_difficulty_bits: ch.share_difficulty_bits,
    });
  }, [ledger, refreshAccount, wallet, tearDownMining]);

  const start = useCallback(() => {
    if (wallet.status !== 'unlocked' || !me) return;
    if (status === 'mining' || workerRef.current) return;
    stopRequestedRef.current = false;
    totalHashesRef.current = 0n;
    currentCycleHashesRef.current = 0n;
    sessionMintedRef.current = 0;
    sessionSharesRef.current = 0;
    sessionPoolPayoutBaseUnitsRef.current = 0n;
    lastSeenRoundIdRef.current = null;
    lastTokenIdRef.current = '';
    bestHashHexRef.current = '';
    bestNonceHexRef.current = '';
    bestZerosRef.current = -1;
    hashesPerSecRef.current = 0;
    sessionStartedAtRef.current = performance.now();
    sessionStoppedAtRef.current = 0;
    lastRefreshAtRef.current = 0;
    setError('');
    setStatus('mining');
    vizHandlesRef.current?.setActive(true);
    if (mode === 'pool') startPoolCycle(); else startOne();
  }, [wallet, me, status, mode, startOne, startPoolCycle]);

  const stop = useCallback(() => {
    if (challengeRenewTimerRef.current !== null) {
      window.clearTimeout(challengeRenewTimerRef.current);
      challengeRenewTimerRef.current = null;
    }
    tearDownMining();
    refreshAccount({ force: true });
  }, [tearDownMining, refreshAccount]);

  // Switching modes mid-run: cleanly stop the old worker and restart
  // under the new mode. We don't auto-restart — the user explicitly
  // chose to switch, so let them re-press [ MINE ] consciously.
  const switchMode = useCallback((next: MiningMode) => {
    if (next === mode) return;
    if (status === 'mining') {
      stop();
    }
    setMode(next);
  }, [mode, status, stop, setMode]);

  // Stash the dependencies the polling-tick needs in refs that always
  // hold the latest value. The polling effect itself only depends on
  // `mode` (and pubkey), so it doesn't churn-and-restart on every
  // block-height refresh or refresh-callback identity change. Without
  // this, an unstable `useMe.refresh` (or any future change to those
  // deps) would put the polling loop into a tight render-fetch-render
  // spiral that floods the server and starves /pool/share submissions.
  const pollingDepsRef = useRef({ refreshAccount, blockHeight: ledger?.block_height, mePubkey: me?.pubkey });
  useEffect(() => {
    pollingDepsRef.current = { refreshAccount, blockHeight: ledger?.block_height, mePubkey: me?.pubkey };
  });

  // Pool stats polling — runs whenever the user is on pool mode (not
  // just while mining) so the visualizer can show live pool size /
  // hashrate / round info even when idle. Solo mode skips entirely.
  // Gated on tab visibility so background tabs don't burn requests.
  useEffect(() => {
    if (mode !== 'pool') {
      setPoolStats(null);
      lastSeenRoundIdRef.current = null;
      return;
    }
    let cancelled = false;
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      api.poolStats()
        .then((r) => {
          if (cancelled) return;
          // Detect rounds we participated in that closed since the last
          // poll. The share handler already fires a win FX for rounds
          // WE found, so we filter out our own wins here to avoid
          // double-celebrating. Only mining users get the FX so an idle
          // pool spectator isn't blasted with notifications.
          const { refreshAccount: ra, blockHeight, mePubkey } = pollingDepsRef.current;
          const isActivelyMining = workerRef.current !== null && !stopRequestedRef.current;
          const seen = lastSeenRoundIdRef.current;
          if (seen !== null && isActivelyMining && r.recent_payouts.length > 0) {
            // recent_payouts is newest-first. Walk until we hit the
            // round we already acknowledged.
            for (const p of r.recent_payouts) {
              if (BigInt(p.round_id) <= BigInt(seen)) break;
              if (!p.your_payout_base_units) continue;
              if (p.finder_pubkey === mePubkey) continue; // already celebrated
              sessionPoolPayoutBaseUnitsRef.current += BigInt(p.your_payout_base_units);
              vizHandlesRef.current?.triggerWin({
                hashHex: '',
                nonceHex: '',
                rewardLabel: `+${formatRpow(p.your_payout_base_units)} RPOW pool round payout`,
                blockHeight,
              });
              ra();
            }
          }
          // Always advance the watermark so a poll after sleep doesn't
          // celebrate everything that happened while the tab was idle.
          if (r.recent_payouts.length > 0) {
            lastSeenRoundIdRef.current = r.recent_payouts[0]!.round_id;
          } else if (lastSeenRoundIdRef.current === null) {
            lastSeenRoundIdRef.current = '0';
          }
          setPoolStats(r);
        })
        .catch(() => { /* tolerate transient failures */ });
    };
    tick();
    const id = window.setInterval(tick, POOL_STATS_POLL_MS);
    // Re-tick when the tab becomes visible after being hidden, so the
    // user sees fresh stats immediately rather than waiting up to 3s.
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [mode]);

  // Memoize the context value so consumers don't re-render on every
  // unrelated provider state change. Refs are stable across renders, so
  // only the React state primitives + actions need to be in deps.
  const value = useMemo<MiningContextValue>(() => ({
    status,
    target,
    error,
    ledger,
    bench,
    me,
    refresh,
    totalHashesRef,
    currentCycleHashesRef,
    sessionStartedAtRef,
    sessionStoppedAtRef,
    sessionMintedRef,
    sessionSharesRef,
    sessionPoolPayoutBaseUnitsRef,
    lastTokenIdRef,
    bestHashHexRef,
    bestNonceHexRef,
    bestZerosRef,
    hashesPerSecRef,
    vizHandlesRef,
    mode,
    setMode: switchMode,
    poolStats,
    start,
    stop,
  }), [status, target, error, ledger, bench, me, refresh, mode, switchMode, poolStats, start, stop]);

  return <MiningContext.Provider value={value}>{children}</MiningContext.Provider>;
}
