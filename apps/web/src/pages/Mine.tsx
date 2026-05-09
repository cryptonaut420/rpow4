import { useEffect, useReducer, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { CopyButton } from '../components/CopyButton.js';
import { MiningVisualizer, type MiningVisualizerHandles } from '../components/MiningVisualizer.js';
import { useMe } from '../hooks/useMe.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { api } from '../api.js';
import { formatRpow } from '../lib/format.js';
import {
  estimateHashrate,
  expectedSecondsAt,
  formatDuration,
  formatHashrate,
  type HashrateEstimate,
} from '../lib/hashrate.js';
import type { LedgerResponse } from '@rpow/shared';

type Status = 'idle' | 'mining' | 'error';

// Visible mining stats are repainted at this rate while a run is in
// flight. At dev difficulty (DIFFICULTY_BITS=14) a CPU mines a coin
// every ~16 ms, so every per-coin setState would otherwise re-render
// the whole MinePage tree 60+ times a second. Counters live in refs;
// the page reads them on each tick.
const DISPLAY_TICK_MS = 250;

// Throttle background /me + /ledger refreshes during continuous mining
// to about once per second.
const REFRESH_THROTTLE_MS = 1000;

export function MinePage() {
  const wallet = useWallet();
  const { me, loading, refresh } = useMe();
  const nav = useNavigate();
  const [status, setStatus] = useState<Status>('idle');
  const [target, setTarget] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [bench, setBench] = useState<HashrateEstimate | null>(null);

  // Worker handle + stop signal. Refs (not state) so the recursive
  // worker callback always sees the latest value without restarting.
  const workerRef = useRef<Worker | null>(null);
  const stopRequestedRef = useRef(false);

  // Per-run counters that move every coin. Held in refs and read by the
  // 250 ms display tick to keep React out of the per-coin write path.
  const sessionStartedAtRef = useRef(0);
  const sessionStoppedAtRef = useRef(0);
  const totalHashesRef = useRef(0n);
  const currentCycleHashesRef = useRef(0n);
  const sessionMintedRef = useRef(0);
  const lastTokenIdRef = useRef('');

  // Single repaint trigger that the display-tick interval calls.
  const [, forceTick] = useReducer((x: number) => (x + 1) | 0, 0);

  // /me + /ledger background refresh throttle.
  const lastRefreshAtRef = useRef(0);

  // Imperative handle for the cypherpunk visualizer. Driven from worker
  // progress events and the mint success path, never via React state, so
  // hash-rain frames and per-block FX don't trigger a Mine page re-render.
  const vizHandlesRef = useRef<MiningVisualizerHandles | null>(null);

  useEffect(() => () => {
    stopRequestedRef.current = true;
    workerRef.current?.terminate();
  }, []);

  // Pull halving info on mount and after each successful refresh batch
  // so the "next halving at" countdown stays roughly current.
  const refreshLedger = () => { api.ledger().then(setLedger).catch(() => {}); };
  useEffect(() => { refreshLedger(); }, []);

  // Combined throttled balance + ledger refresh. Pass `force: true` to
  // bypass the throttle (e.g. on STOP).
  const refreshAccount = (opts: { force?: boolean } = {}) => {
    const now = performance.now();
    if (!opts.force && now - lastRefreshAtRef.current < REFRESH_THROTTLE_MS) return;
    lastRefreshAtRef.current = now;
    void refresh();
    refreshLedger();
  };

  // While mining, repaint the stats panel at DISPLAY_TICK_MS. The cleanup
  // path schedules one final tick so the frozen post-stop totals are the
  // last thing the user sees.
  useEffect(() => {
    if (status !== 'mining') return;
    const id = window.setInterval(forceTick, DISPLAY_TICK_MS);
    return () => {
      clearInterval(id);
      forceTick();
    };
  }, [status]);

  // One-shot CPU benchmark on mount so we can show the user how long a
  // typical solve will take at the current difficulty *before* they
  // start. Not wired into the actual mining loop — purely informational.
  useEffect(() => {
    let cancelled = false;
    estimateHashrate({ duration_ms: 1200 }).then((r) => { if (!cancelled) setBench(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function startOne() {
    if (stopRequestedRef.current) {
      sessionStoppedAtRef.current = performance.now();
      setStatus('idle');
      return;
    }
    // Fresh cycle counter. Session totals roll forward across cycles.
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
    // setTarget is a no-op when the difficulty hasn't changed (React
    // bails on identical-state updates) — safe to call every cycle.
    setTarget(ch.difficulty_bits);

    const w = new Worker(new URL('../miner.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = w;
    w.onmessage = async (e: MessageEvent<any>) => {
      const m = e.data;
      if (m.type === 'progress') {
        // 250 ms cadence inside the worker; bumps the running cycle
        // hash count without poking React state.
        currentCycleHashesRef.current = BigInt(m.hashes);
        // Forward to the visualizer (RAF-driven, no React re-render).
        if (vizHandlesRef.current) {
          const elapsedSec = Math.max(1, m.elapsed_ms) / 1000;
          const cycleHashes = Number(BigInt(m.hashes));
          vizHandlesRef.current.setProgress({
            bestZeros: typeof m.best_zeros === 'number' ? m.best_zeros : -1,
            bestHashHex: typeof m.best_hash_hex === 'string' ? m.best_hash_hex : '',
            bestNonceHex: typeof m.best_nonce_hex === 'string' ? m.best_nonce_hex : '',
            hashesPerSec: cycleHashes / elapsedSec,
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
          // Roll the cycle's hashes into the running session total.
          totalHashesRef.current += BigInt(m.hashes);
          currentCycleHashesRef.current = 0n;
          sessionMintedRef.current += 1;
          lastTokenIdRef.current = r.token.id;
          // Cypherpunk win FX. Reads the freshest ledger snapshot if we have
          // one for the block height label, but doesn't block on it.
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
          // Throttled to once / second; sessionMintedRef updates every coin.
          refreshAccount();

          if (!stopRequestedRef.current) {
            // Status stays 'mining' across the recursion — no flicker.
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
  }

  function start() {
    if (wallet.status !== 'unlocked' || !me) { nav('/login'); return; }
    // Defensive: a second click while a worker or mint is in flight
    // would spawn a parallel loop that doubles the request rate.
    if (status === 'mining' || workerRef.current) return;
    stopRequestedRef.current = false;
    totalHashesRef.current = 0n;
    currentCycleHashesRef.current = 0n;
    sessionMintedRef.current = 0;
    lastTokenIdRef.current = '';
    sessionStartedAtRef.current = performance.now();
    sessionStoppedAtRef.current = 0;
    lastRefreshAtRef.current = 0;
    setError('');
    setStatus('mining');
    vizHandlesRef.current?.setActive(true);
    startOne();
  }

  function stop() {
    stopRequestedRef.current = true;
    workerRef.current?.postMessage({ type: 'abort' });
    refreshAccount({ force: true });
  }

  // Stats read straight from refs so renders are cheap. While mining,
  // elapsed pulls from `now`; after stop it freezes at the recorded
  // sessionStoppedAt so the panel shows the final summary.
  const totalHashes = totalHashesRef.current + currentCycleHashesRef.current;
  const endTime = status === 'mining'
    ? performance.now()
    : (sessionStoppedAtRef.current || sessionStartedAtRef.current);
  const sessionElapsedMs = sessionStartedAtRef.current
    ? Math.max(0, Math.round(endTime - sessionStartedAtRef.current))
    : 0;
  const sessionMinted = sessionMintedRef.current;
  const lastTokenId = lastTokenIdRef.current;

  function fmtRate(): string {
    if (!sessionElapsedMs) return '0';
    const mhs = (Number(totalHashes) / 1e6) / (sessionElapsedMs / 1000);
    return mhs.toFixed(2) + ' MH/s';
  }
  function fmtElapsed(): string {
    const s = Math.floor(sessionElapsedMs / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `00:${mm}:${ss}`;
  }

  if (loading || wallet.status === 'loading') return <Panel><div>loading...</div></Panel>;
  if (wallet.status !== 'unlocked' || !me) {
    return (
      <Panel title="MINE">
        <div>not signed in.</div>
        <div style={{ marginTop: 8 }}>
          <Link to="/login">[ {wallet.status === 'locked' ? 'unlock wallet' : 'create or import wallet'} ]</Link>
        </div>
      </Panel>
    );
  }

  const running = status === 'mining';

  // Block / reward block (when ledger has loaded). Shown above the per-run
  // mining stats so users see what they're actually mining for. RPOW4
  // tokenomics are Bitcoin-flavored: 50 RPOW initial reward, halves every
  // 210k blocks, difficulty +1 bit every 164,062 blocks.
  let rewardBlock = '';
  if (ledger) {
    const currentReward = formatRpow(ledger.current_reward_base_units);
    const nextReward = formatRpow(ledger.next_reward_base_units);
    const yourRate = bench ? formatHashrate(bench.hps) : 'measuring…';
    const eta = bench
      ? formatDuration(expectedSecondsAt(ledger.current_difficulty_bits, bench.hps))
      : '—';
    rewardBlock = `  BLOCK HEIGHT     : ${ledger.block_height}
  CURRENT REWARD   : ${currentReward} RPOW per solution  (halving #${ledger.halving_index})
  CURRENT DIFFICULTY: ${ledger.current_difficulty_bits} trailing zero bits
  YOUR HASHRATE    : ${yourRate}  (~${eta} per solution on this CPU)
  NEXT HALVING AT  : block ${ledger.next_halving_at_block}  (${ledger.blocks_to_next_halving} to go)
  NEXT REWARD      : ${ledger.is_capped ? 'CAPPED' : `${nextReward} RPOW`}
  NEXT DIFFICULTY  : +1 bit at block ${ledger.next_difficulty_at_block}  (${ledger.blocks_to_next_difficulty_step} to go)

`;
  }

  // Approximate session reward = current_reward × coins mined this run.
  // It's an approximation if a halving boundary is crossed mid-run; the
  // authoritative value still comes from /me's balance_base_units below.
  const sessionRewardLabel = ledger && sessionMinted > 0
    ? ` (+${formatRpow(BigInt(ledger.current_reward_base_units) * BigInt(sessionMinted))} RPOW)`
    : '';

  return (
    <Panel title="MINE">
      <pre style={{ margin: 0 }}>
{`  BALANCE          : ${formatRpow(me.balance_base_units)} RPOW
  TOTAL MINTED     : ${formatRpow(me.minted_base_units)} RPOW

${rewardBlock}  TARGET           : ${target ?? '--'} trailing zero bits
  HASHES (session) : ${Number(totalHashes).toLocaleString()}
  RATE             : ${fmtRate()}
  ELAPSED          : ${fmtElapsed()}
  STATUS           : ${status.toUpperCase()}
  MINED THIS RUN   : ${sessionMinted}${sessionRewardLabel}${error ? `\n  ERROR            : ${error}` : ''}
`}
      </pre>
      <MiningVisualizer
        target={target ?? (ledger?.current_difficulty_bits ?? 0)}
        handlesRef={vizHandlesRef}
      />
      {lastTokenId && (
        <div style={{ marginTop: 4, color: 'var(--dim)', fontSize: 12 }}>
          last token: <code>{lastTokenId}</code> <CopyButton text={lastTokenId} />
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        {running ? (
          <button onClick={stop}>[ STOP ]</button>
        ) : (
          <button onClick={start}>[ MINE ]</button>
        )}
      </div>
    </Panel>
  );
}
