import { useEffect, useReducer, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useMining } from '../mining/MiningProvider.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { MiningVisualizer } from './MiningVisualizer.js';
import { Panel } from './Panel.js';
import { CopyButton } from './CopyButton.js';
import { formatRpow } from '../lib/format.js';
import {
  expectedSecondsAt,
  formatDuration,
  formatHashrate,
} from '../lib/hashrate.js';

// ---------------------------------------------------------------------------
// MiningBar
//
// Sticky, app-wide widget. The full <MiningVisualizer> is mounted ONCE here
// and never unmounted across the lifetime of the app shell — that's what
// keeps the hash-rain animation running smoothly while the user navigates,
// and what keeps mining itself sticky.
//
// The visualizer renders in `compact` mode while the bar is docked, and
// switches to full mode when the user expands the panel. Expanding adds
// the stats text block and "MINING ORIGINS" blurb above the visualizer.
// The visualizer itself is just toggled between modes; its RAF loop and
// internal animation state survive the toggle.
// ---------------------------------------------------------------------------

const TICK_MS = 250;

export function MiningBar() {
  const wallet = useWallet();
  const mining = useMining();
  const location = useLocation();
  const [expanded, setExpanded] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  // Drive a 250 ms repaint while mining so the live ref-backed counters
  // (hashrate, elapsed time, total hashes) actually visibly update. When
  // idle there's nothing to repaint, so we let React rest.
  const [, forceTick] = useReducer((x: number) => (x + 1) | 0, 0);
  useEffect(() => {
    if (mining.status !== 'mining') return;
    const id = window.setInterval(forceTick, TICK_MS);
    return () => {
      clearInterval(id);
      forceTick();
    };
  }, [mining.status]);

  // Publish the bar's actual rendered height as a CSS variable so the
  // app-shell's padding-bottom is always exact — across mobile vs desktop,
  // collapsed vs expanded, hidden vs visible. Using a magic number here was
  // bound to be wrong somewhere (e.g. when the strip wraps onto a second
  // row on a 320px-wide phone) and either let content slip behind the bar
  // or leave a permanent ugly gap above it.
  const signedIn = wallet.status === 'unlocked' && !!mining.me;
  const visible = signedIn && location.pathname !== '/login';
  useEffect(() => {
    const root = document.documentElement;
    const el = barRef.current;
    if (!visible || !el) {
      root.style.removeProperty('--mining-bar-h');
      return;
    }
    const update = () => {
      root.style.setProperty('--mining-bar-h', `${el.offsetHeight}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--mining-bar-h');
    };
  }, [visible]);

  // We deliberately do NOT auto-collapse on navigation. Mining is meant to
  // be sticky; if the user expanded the bar to read details, slamming it
  // shut behind their back when they click a link would be jarring.

  // Hide on /login (the bar would just be noise on the auth screen) and
  // when the user isn't ready to mine. `visible` is computed above so the
  // height-publishing effect can react to the same condition.
  if (!visible) return null;

  const me = mining.me!;
  const running = mining.status === 'mining';

  // Live ref reads — captured per render so JSX doesn't re-touch the refs.
  const totalHashes = mining.totalHashesRef.current + mining.currentCycleHashesRef.current;
  const sessionMinted = mining.sessionMintedRef.current;
  const lastTokenId = mining.lastTokenIdRef.current;

  const endTime = running
    ? performance.now()
    : (mining.sessionStoppedAtRef.current || mining.sessionStartedAtRef.current);
  const sessionElapsedMs = mining.sessionStartedAtRef.current
    ? Math.max(0, Math.round(endTime - mining.sessionStartedAtRef.current))
    : 0;

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

  const sessionRewardLabel =
    mining.ledger && sessionMinted > 0
      ? ` (+${formatRpow(BigInt(mining.ledger.current_reward_base_units) * BigInt(sessionMinted))} RPOW)`
      : '';

  return (
    <div className="mining-bar" data-expanded={expanded ? 'true' : 'false'} ref={barRef}>
      <div className="mining-bar-inner">
        {/* ── Expanded details — scrollable, only mounted when expanded.
              Sits above the always-visible strip + visualizer so the user
              can read mining stats / origins without losing the controls
              or the live animation. ─────────────────────────────────── */}
        {expanded && (
          <div className="mining-bar-expanded-content">
            <ExpandedDetails
              ledger={mining.ledger}
              bench={mining.bench}
              status={mining.status}
              error={mining.error}
              target={mining.target ?? mining.ledger?.current_difficulty_bits ?? 0}
              totalHashes={totalHashes}
              sessionMinted={sessionMinted}
              sessionRewardLabel={sessionRewardLabel}
              fmtElapsed={fmtElapsed()}
              fmtRate={fmtRate()}
              meBalance={me.balance_base_units}
              meMinted={me.minted_base_units}
              lastTokenId={lastTokenId}
            />
          </div>
        )}

        {/* ── Control strip — always visible ─────────────────────────── */}
        <div className="mining-bar-strip">
          <span className={`mining-status-pill ${running ? 'is-running' : 'is-idle'}`}>
            <span className="mining-status-dot" />
            {running ? 'MINING' : mining.status === 'error' ? 'STOPPED' : 'IDLE'}
          </span>

          <span className="mining-bar-balance" title="your spendable balance">
            <span className="mining-bar-label-text">BALANCE</span>{' '}
            <strong>{formatRpow(me.balance_base_units)}</strong> RPOW
          </span>

          {running && (
            <span className="mining-bar-stat" title="elapsed time / minted this run">
              <span className="mining-bar-label-text">RUN</span>{' '}
              {fmtElapsed()} · {sessionMinted}{sessionRewardLabel}
            </span>
          )}

          <span className="mining-bar-spacer" />

          {running ? (
            <button
              type="button"
              className="mining-bar-action stop"
              onClick={mining.stop}
              title="stop mining"
            >
              [ STOP ]
            </button>
          ) : (
            <button
              type="button"
              className="mining-bar-action go"
              onClick={mining.start}
              title="start mining"
            >
              [ MINE ]
            </button>
          )}

          <button
            type="button"
            className="mining-bar-action expand"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            title={expanded ? 'collapse mining details' : 'show full mining details'}
          >
            {expanded ? '[ collapse ▼ ]' : '[ details ▲ ]'}
          </button>
        </div>

        {/* ── The full visualizer — ALWAYS mounted, just toggles compact mode.
              Mounting once preserves the rain animation across page nav and
              across the expand/collapse toggle. ─────────────────────────── */}
        <div className="mining-bar-viz">
          <MiningVisualizer
            target={mining.target ?? mining.ledger?.current_difficulty_bits ?? 0}
            handlesRef={mining.vizHandlesRef}
            compact={!expanded}
          />
        </div>
      </div>
    </div>
  );
}

interface ExpandedDetailsProps {
  ledger: ReturnType<typeof useMining>['ledger'];
  bench: ReturnType<typeof useMining>['bench'];
  status: ReturnType<typeof useMining>['status'];
  error: string;
  target: number;
  totalHashes: bigint;
  sessionMinted: number;
  sessionRewardLabel: string;
  fmtElapsed: string;
  fmtRate: string;
  meBalance: string;
  meMinted: string;
  lastTokenId: string;
}

function ExpandedDetails(props: ExpandedDetailsProps) {
  let rewardBlock = '';
  if (props.ledger) {
    const currentReward = formatRpow(props.ledger.current_reward_base_units);
    const nextReward = formatRpow(props.ledger.next_reward_base_units);
    const yourRate = props.bench ? formatHashrate(props.bench.hps) : 'measuring…';
    const eta = props.bench
      ? formatDuration(expectedSecondsAt(props.ledger.current_difficulty_bits, props.bench.hps))
      : '—';
    rewardBlock = `  BLOCK HEIGHT      : ${props.ledger.block_height}
  CURRENT REWARD    : ${currentReward} RPOW per solution  (halving #${props.ledger.halving_index})
  CURRENT DIFFICULTY: ${props.ledger.current_difficulty_bits} trailing zero bits
  YOUR HASHRATE     : ${yourRate}  (~${eta} per solution on this CPU)
  NEXT HALVING AT   : block ${props.ledger.next_halving_at_block}  (${props.ledger.blocks_to_next_halving} to go)
  NEXT REWARD       : ${props.ledger.is_capped ? 'CAPPED' : `${nextReward} RPOW`}
  NEXT DIFFICULTY   : +1 bit at block ${props.ledger.next_difficulty_at_block}  (${props.ledger.blocks_to_next_difficulty_step} to go)

`;
  }

  return (
    <>
      <Panel title="MINE">
        <pre style={{ margin: 0 }}>
{`  BALANCE           : ${formatRpow(props.meBalance)} RPOW
  TOTAL MINTED      : ${formatRpow(props.meMinted)} RPOW

${rewardBlock}  TARGET            : ${props.target || '--'} trailing zero bits
  HASHES (session)  : ${Number(props.totalHashes).toLocaleString()}
  RATE              : ${props.fmtRate}
  ELAPSED           : ${props.fmtElapsed}
  STATUS            : ${props.status.toUpperCase()}
  MINED THIS RUN    : ${props.sessionMinted}${props.sessionRewardLabel}${props.error ? `\n  ERROR             : ${props.error}` : ''}
`}
        </pre>
        {props.lastTokenId && (
          <div style={{ marginTop: 4, color: 'var(--dim)', fontSize: 12 }}>
            last token: <code>{props.lastTokenId}</code> <CopyButton text={props.lastTokenId} />
          </div>
        )}
      </Panel>

      <Panel title="MINING ORIGINS">
        <div style={{ color: 'var(--dim)', fontSize: 12, lineHeight: 1.6 }}>
          Proof-of-work started as an anti-abuse idea before it became mining.
          Cynthia Dwork and Moni Naor described CPU-pricing for junk mail in the
          early 1990s; Adam Back's Hashcash made the pattern famous for email:
          spend a little computation to create a stamp that is expensive to make
          and cheap to verify. Hal Finney's RPOW made those proofs reusable, and
          Bitcoin turned proof-of-work into a public timestamping race with rewards.
          <br /><br />
          RPOW4 keeps the primitive deliberately simple. Your browser receives a
          server-signed challenge with a random{' '}
          <code style={{ color: 'var(--fg)' }}>nonce_prefix</code>, then scans
          integer nonces. For each attempt it hashes{' '}
          <code style={{ color: 'var(--fg)' }}>SHA-256(nonce_prefix || u64le(nonce))</code>.
          A block is won when the hash has at least the current difficulty's
          number of trailing zero bits. The worker uses{' '}
          <code style={{ color: 'var(--fg)' }}>hash-wasm</code> for fast browser
          SHA-256; the server verifies the exact same byte string with Node's
          crypto SHA-256 before crediting the reward.
        </div>
      </Panel>
    </>
  );
}
