import { useEffect, useReducer, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMining } from '../mining/MiningProvider.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { MiningVisualizer } from './MiningVisualizer.js';
import { Panel } from './Panel.js';
import { CopyButton } from './CopyButton.js';
import { formatRpow, formatCount } from '../lib/format.js';
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

function formatHashrateCompact(hps: number): string {
  if (!Number.isFinite(hps) || hps <= 0) return '—';
  if (hps >= 1e9) return `${(hps / 1e9).toFixed(2)} GH/s`;
  if (hps >= 1e6) return `${(hps / 1e6).toFixed(2)} MH/s`;
  if (hps >= 1e3) return `${(hps / 1e3).toFixed(1)} KH/s`;
  return `${Math.round(hps)} H/s`;
}

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
  const sessionShares = mining.sessionSharesRef.current;
  const sessionPoolPayout = mining.sessionPoolPayoutBaseUnitsRef.current;
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
              sessionShares={sessionShares}
              sessionPoolPayout={sessionPoolPayout}
              sessionRewardLabel={sessionRewardLabel}
              fmtElapsed={fmtElapsed()}
              fmtRate={fmtRate()}
              meBalance={me.balance_base_units}
              meMinted={me.minted_base_units}
              lastTokenId={lastTokenId}
              mode={mining.mode}
              poolStats={mining.poolStats}
            />
          </div>
        )}

        {/* ── Control strip — always visible ─────────────────────────── */}
        <div className="mining-bar-strip">
          <span className={`mining-status-pill ${running ? 'is-running' : 'is-idle'}`}>
            <span className="mining-status-dot" />
            {running ? 'MINING' : mining.status === 'error' ? 'STOPPED' : 'IDLE'}
          </span>

          <button
            type="button"
            className={`mining-mode-pill is-${mining.mode}`}
            onClick={() => mining.setMode(mining.mode === 'pool' ? 'solo' : 'pool')}
            title={
              running
                ? 'switching modes will stop the current run; press [ MINE ] again to resume in the new mode'
                : mining.mode === 'pool'
                  ? 'pool mode — share rewards with other miners (2% fee). click to switch to solo.'
                  : 'solo mode — keep 100% of any block you find. click to join the pool.'
            }
          >
            MODE: <strong>{mining.mode === 'pool' ? 'POOL' : 'SOLO'}</strong>
          </button>

          <span className="mining-bar-balance" title="your spendable balance">
            <span className="mining-bar-label-text">BALANCE</span>{' '}
            <strong>{formatRpow(me.balance_base_units)}</strong> RPOW
          </span>

          {running && mining.mode === 'solo' && (
            <span className="mining-bar-stat" title="elapsed time / minted this run">
              <span className="mining-bar-label-text">RUN</span>{' '}
              {fmtElapsed()} · {sessionMinted}{sessionRewardLabel}
            </span>
          )}

          {running && mining.mode === 'pool' && (
            <span
              className="mining-bar-stat"
              title="this run: elapsed time · shares submitted · cumulative pool payout"
            >
              <span className="mining-bar-label-text">RUN</span>{' '}
              {fmtElapsed()} · {sessionShares} share{sessionShares === 1 ? '' : 's'}
              {sessionPoolPayout > 0n
                ? ` · +${formatRpow(sessionPoolPayout)} RPOW`
                : ''}
            </span>
          )}

          {mining.mode === 'pool' && mining.poolStats && (
            <span className="mining-bar-stat" title="active pool members and aggregate hashrate">
              <span className="mining-bar-label-text">POOL</span>{' '}
              {mining.poolStats.active_miners} miners ·{' '}
              {formatHashrateCompact(mining.poolStats.pool_hashrate_hps)}
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
              across the expand/collapse toggle. In pool mode we forward the
              aggregate pool hashrate + share difficulty so the visualizer
              can show both pool and personal expected-solve numbers. ─── */}
        <div className="mining-bar-viz">
          <MiningVisualizer
            target={mining.target ?? mining.ledger?.current_difficulty_bits ?? 0}
            handlesRef={mining.vizHandlesRef}
            compact={!expanded}
            poolHashratePerSec={
              mining.mode === 'pool' && mining.poolStats
                ? mining.poolStats.pool_hashrate_hps
                : undefined
            }
            shareDifficultyBits={
              mining.mode === 'pool' && mining.poolStats
                ? mining.poolStats.share_difficulty_bits
                : undefined
            }
            poolRoundStartedAt={
              mining.mode === 'pool' && mining.poolStats?.current_round
                ? mining.poolStats.current_round.started_at
                : undefined
            }
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
  sessionShares: number;
  sessionPoolPayout: bigint;
  sessionRewardLabel: string;
  fmtElapsed: string;
  fmtRate: string;
  meBalance: string;
  meMinted: string;
  lastTokenId: string;
  mode: ReturnType<typeof useMining>['mode'];
  poolStats: ReturnType<typeof useMining>['poolStats'];
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
    rewardBlock = `  BLOCK HEIGHT      : ${formatCount(props.ledger.block_height)}
  CURRENT REWARD    : ${currentReward} RPOW per solution  (halving #${props.ledger.halving_index})
  CURRENT DIFFICULTY: ${props.ledger.current_difficulty_bits} trailing zero bits
  YOUR HASHRATE     : ${yourRate}  (~${eta} per solution on this CPU)
  NEXT HALVING AT   : block ${formatCount(props.ledger.next_halving_at_block)}  (${formatCount(props.ledger.blocks_to_next_halving)} to go)
  NEXT REWARD       : ${props.ledger.is_capped ? 'CAPPED' : `${nextReward} RPOW`}
  NEXT DIFFICULTY   : +1 bit at block ${formatCount(props.ledger.next_difficulty_at_block)}  (${formatCount(props.ledger.blocks_to_next_difficulty_step)} to go)

`;
  }

  // Pool block — only meaningful when in pool mode + we have a stats snapshot.
  let poolBlock = '';
  if (props.mode === 'pool' && props.poolStats) {
    const ps = props.poolStats;
    const cur = ps.current_round;
    const youShares = cur ? cur.your_shares : '0';
    const totalShares = cur ? cur.total_shares : '0';
    const ifFinder = cur ? formatRpow(cur.estimated_finder_payout_base_units) : '—';
    const ifPro = cur ? formatRpow(cur.estimated_pro_rata_payout_base_units) : '—';
    poolBlock = `  POOL HASHRATE     : ${formatHashrateCompact(ps.pool_hashrate_hps)}  (${ps.active_miners} active miner${ps.active_miners === 1 ? '' : 's'})
  POOL FEE          : ${(ps.pool_fee_bps / 100).toFixed(2)}% to treasury
  FINDER BONUS      : ${(ps.finder_bps / 100).toFixed(2)}% of net to the lucky miner
  CURRENT ROUND     : #${cur?.id ?? '—'}  ${formatCount(totalShares)} share${totalShares === '1' ? '' : 's'} total
  YOUR SHARES       : ${formatCount(youShares)}
  EST. IF YOU FIND  : +${ifFinder} RPOW
  EST. POOL PAYOUT  : +${ifPro} RPOW

`;
  }
  return (
    <>
      {props.mode === 'pool' && (
        <Panel title="HOW POOL MINING WORKS">
          <div style={{ color: 'var(--dim)', fontSize: 12, lineHeight: 1.6 }}>
            Your browser submits "shares" — partial proofs-of-work that meet
            a lower-difficulty target than the network requires
            ({props.poolStats?.share_difficulty_bits ?? '—'} trailing zero
            bits vs. {props.poolStats?.network_difficulty_bits ?? '—'} for a
            real block). Every accepted share counts toward the current
            round's pro-rata pool.
            <br /><br />
            When any pool member's share <em style={{ color: 'var(--fg)' }}>also</em>{' '}
            clears the network target, the round closes and the gross
            block reward is split:
            <ul style={{ margin: '6px 0', paddingLeft: 20 }}>
              <li>
                <strong style={{ color: 'var(--fg)' }}>2%</strong> to the
                treasury (funds the faucet)
              </li>
              <li>
                <strong style={{ color: 'var(--accent)' }}>25%</strong>{' '}
                of the post-fee remainder to the lucky finder as a flat
                bonus
              </li>
              <li>
                The remaining{' '}
                <strong style={{ color: 'var(--accent)' }}>75%</strong>{' '}
                split pro-rata across all NON-finder shares from the
                round
              </li>
            </ul>
            You earn frequently and predictably regardless of who finds
            the block, with less variance than solo. The trade-off is
            the 2% treasury haircut and the smaller finder slice on
            wins. Solo mode keeps 100% but at high difficulty can mean
            long dry spells. <strong style={{ color: 'var(--fg)' }}>Toggle
            modes any time</strong> from the MODE pill in the bar; your
            choice is remembered for future sessions.
          </div>
        </Panel>
      )}

      <Panel title={props.mode === 'pool' ? 'MINE · POOL' : 'MINE · SOLO'}>
        <pre style={{ margin: 0 }}>
{`  BALANCE           : ${formatRpow(props.meBalance)} RPOW
  TOTAL MINTED      : ${formatRpow(props.meMinted)} RPOW

${rewardBlock}${poolBlock}  TARGET            : ${props.target || '--'} trailing zero bits
  HASHES (session)  : ${formatCount(props.totalHashes)}
  RATE              : ${props.fmtRate}
  ELAPSED           : ${props.fmtElapsed}
  STATUS            : ${props.status.toUpperCase()}
  ${props.mode === 'pool' ? 'BLOCKS THIS RUN ' : 'MINED THIS RUN  '}  : ${formatCount(props.sessionMinted)}${props.sessionRewardLabel}${props.mode === 'pool' ? `\n  SHARES THIS RUN   : ${formatCount(props.sessionShares)}\n  POOL EARNED       : +${formatRpow(props.sessionPoolPayout)} RPOW` : ''}${props.error ? `\n  ERROR             : ${props.error}` : ''}
`}
        </pre>
        {props.lastTokenId && (
          <div style={{ marginTop: 4, color: 'var(--dim)', fontSize: 12 }}>
            last token: <code>{props.lastTokenId}</code> <CopyButton text={props.lastTokenId} />
          </div>
        )}
      </Panel>

      {props.mode === 'pool' && props.poolStats && props.poolStats.recent_payouts.length > 0 && (
        <Panel title="POOL ROUND HISTORY">
          <div className="pool-rounds-list">
            {props.poolStats.recent_payouts.map((p) => {
              const at = new Date(p.ended_at).toISOString().slice(11, 19);
              const finder = p.finder_display_name
                ? `@${p.finder_display_name}`
                : `${p.finder_pubkey.slice(0, 6)}…${p.finder_pubkey.slice(-4)}`;
              return (
                <div key={p.round_id} className="pool-rounds-row">
                  <span className="pool-rounds-time">{at}</span>
                  <span className="pool-rounds-id">#{p.round_id}</span>
                  <span className="pool-rounds-reward">{formatRpow(p.reward_base_units)} RPOW</span>
                  <span className="pool-rounds-meta">
                    {p.participant_count} miner{p.participant_count === 1 ? '' : 's'} · won by{' '}
                    <Link
                      to={`/explorer/account/${p.finder_pubkey}`}
                      title={p.finder_pubkey}
                      className="pool-rounds-finder"
                    >
                      <code>{finder}</code>
                    </Link>
                    {p.your_payout_base_units
                      ? ` · you +${formatRpow(p.your_payout_base_units)} RPOW`
                      : ''}
                  </span>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <Link to="/pool/history">[ view all pool rounds ]</Link>
          </div>
        </Panel>
      )}

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
