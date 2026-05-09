import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
import type { LedgerResponse, MeResponse } from '@rpow/shared';

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

// Throttle background /me + /ledger refreshes during continuous mining
// to about once per second.
const REFRESH_THROTTLE_MS = 1000;

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
  const lastTokenIdRef = useRef('');

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

  // Hard stop on unmount (e.g. tab closed, app HMR). The worker holds a
  // network connection-ish thing (pulls challenges + posts mints) so we
  // explicitly terminate rather than letting it leak.
  useEffect(() => () => {
    stopRequestedRef.current = true;
    workerRef.current?.terminate();
  }, []);

  // If the wallet locks (logout, lock-after-idle, etc.) while mining is
  // running, abort cleanly. Mining requires `wallet.sign(...)` to mint
  // each coin; without an unlocked wallet the next mint would throw.
  useEffect(() => {
    if (status === 'mining' && wallet.status !== 'unlocked') {
      stopRequestedRef.current = true;
      workerRef.current?.postMessage({ type: 'abort' });
      workerRef.current?.terminate();
      workerRef.current = null;
      sessionStoppedAtRef.current = performance.now();
      vizHandlesRef.current?.setActive(false);
      setStatus('idle');
    }
  }, [wallet.status, status]);

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

  const start = useCallback(() => {
    if (wallet.status !== 'unlocked' || !me) return;
    if (status === 'mining' || workerRef.current) return;
    stopRequestedRef.current = false;
    totalHashesRef.current = 0n;
    currentCycleHashesRef.current = 0n;
    sessionMintedRef.current = 0;
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
    startOne();
  }, [wallet, me, status, startOne]);

  const stop = useCallback(() => {
    stopRequestedRef.current = true;
    workerRef.current?.postMessage({ type: 'abort' });
    refreshAccount({ force: true });
  }, [refreshAccount]);

  const value: MiningContextValue = {
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
    lastTokenIdRef,
    bestHashHexRef,
    bestNonceHexRef,
    bestZerosRef,
    hashesPerSecRef,
    vizHandlesRef,
    start,
    stop,
  };

  return <MiningContext.Provider value={value}>{children}</MiningContext.Provider>;
}
