import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { prepareWithSegments, measureLineStats } from '@chenglou/pretext';
import { Panel } from '../components/Panel.js';
import { CopyButton } from '../components/CopyButton.js';
import { api } from '../api.js';
import { useMe } from '../hooks/useMe.js';
import { useWallet } from '../wallet/WalletProvider.js';
import type { FaucetStatusResponse, FaucetClaimError } from '@rpow/shared';
import { formatRpow } from '../lib/format.js';

// ---------------------------------------------------------------------------
// FaucetCanvas
//
// ASCII faucet illustration with animated drips. Driven by a single RAF
// loop so React doesn't re-render every frame. We use pretext to measure
// the active monospace glyph width so the centered illustration aligns
// perfectly with the panel without any DOM measurement on each frame.
// ---------------------------------------------------------------------------

const FAUCET_ART = [
  '       .__________________.       ',
  '       |                  |       ',
  '       |  R P O W 4   ◆   |       ',
  '       |   T R E A S U R Y |      ',
  '       |__________________.|      ',
  '             |        |           ',
  '             |        |           ',
  '          ___|        |___        ',
  '         |________________|       ',
  '                  |               ',
  '              [---|---]           ',
  '               \\\\__|__//          ',
  '                 \\___/            ',
  '                   |              ',
  '                   v              ',
];
const SPOUT_ROW = 14;       // index of the row whose `v` is the spout tip
const SPOUT_COL = 19;       // column index of the spout tip within FAUCET_ART
const DRIP_LANES_BELOW = 6; // rows of falling space below the spout
const DRIP_GLYPHS = ['●', 'o', '·', '°'];
const SPLASH_GLYPHS = ['*', '·', "'", '`', ',', '~'];

interface Drip {
  id: number;
  startedAt: number;
  // 0 = at spout, 1 = at bottom (splash row)
  travelMs: number;
  /** When set, replaces the falling glyph with a continuous-stream block. */
  burst: boolean;
}

interface Splash {
  id: number;
  startedAt: number;
  durationMs: number;
}

type Mode = 'idle' | 'pour' | 'celebrate';

function FaucetCanvas({ mode, treasuryFillPct }: { mode: Mode; treasuryFillPct: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const [colWidth, setColWidth] = useState(8);

  // Pretext glyph measurement so the illustration centers correctly.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function recompute() {
      if (!el) return;
      const cs = window.getComputedStyle(el);
      const font = `${cs.fontSize} ${cs.fontFamily}`;
      const prepared = prepareWithSegments('M'.repeat(80), font);
      const { maxLineWidth } = measureLineStats(prepared, 1e6);
      setColWidth(maxLineWidth / 80);
    }
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dripsRef = useRef<Drip[]>([]);
  const splashesRef = useRef<Splash[]>([]);
  const lastSpawnRef = useRef(0);
  const dripIdRef = useRef(0);
  const splashIdRef = useRef(0);
  const modeRef = useRef<Mode>(mode);
  modeRef.current = mode;

  useEffect(() => {
    let frame: number | null = null;
    function tick(now: number) {
      const m = modeRef.current;

      // Decide if we should spawn a new drip.
      const spawnIntervalMs =
        m === 'idle' ? 1400 + Math.random() * 1200 :
        m === 'pour' ? 90 + Math.random() * 30 :
        220 + Math.random() * 200;
      if (now - lastSpawnRef.current > spawnIntervalMs) {
        lastSpawnRef.current = now;
        dripIdRef.current += 1;
        dripsRef.current.push({
          id: dripIdRef.current,
          startedAt: now,
          travelMs: m === 'pour' ? 280 + Math.random() * 80 : 700 + Math.random() * 400,
          burst: m === 'pour',
        });
      }

      // Drop expired drips, transition them into a splash on landing.
      dripsRef.current = dripsRef.current.filter((d) => {
        const t = (now - d.startedAt) / d.travelMs;
        if (t >= 1) {
          splashIdRef.current += 1;
          splashesRef.current.push({
            id: splashIdRef.current,
            startedAt: now,
            durationMs: m === 'pour' ? 220 : 360,
          });
          return false;
        }
        return true;
      });

      splashesRef.current = splashesRef.current.filter(
        (s) => now - s.startedAt < s.durationMs,
      );

      // Build the rendered grid: art + drip lanes below.
      const totalRows = FAUCET_ART.length + DRIP_LANES_BELOW;
      const totalCols = FAUCET_ART[0]!.length;
      const lines: string[][] = [];
      for (let r = 0; r < totalRows; r++) {
        const row: string[] = new Array(totalCols).fill(' ');
        if (r < FAUCET_ART.length) {
          for (let c = 0; c < totalCols; c++) {
            row[c] = FAUCET_ART[r]![c] ?? ' ';
          }
        }
        lines.push(row);
      }

      // Treasury fill bar inside the tank — overlay the inside of the box.
      const tankInnerCols = 16;
      const tankCol0 = 9;
      const tankRow = 4; // visible interior fill row
      const fillCells = Math.max(0, Math.min(tankInnerCols, Math.round(treasuryFillPct * tankInnerCols)));
      for (let i = 0; i < tankInnerCols; i++) {
        const ch = i < fillCells ? '▓' : '·';
        if (lines[tankRow]) lines[tankRow]![tankCol0 + i] = ch;
      }

      // Drips rendered between FAUCET_ART rows and splash row.
      for (const d of dripsRef.current) {
        const t = Math.max(0, Math.min(1, (now - d.startedAt) / d.travelMs));
        // Drip path occupies the same column as the spout, descending
        // through DRIP_LANES_BELOW rows.
        const row = SPOUT_ROW + 1 + Math.floor(t * DRIP_LANES_BELOW);
        if (row >= FAUCET_ART.length && row < totalRows && lines[row]) {
          const glyph = d.burst
            ? '|'
            : DRIP_GLYPHS[Math.floor(t * DRIP_GLYPHS.length) % DRIP_GLYPHS.length]!;
          lines[row]![SPOUT_COL] = glyph;
        }
      }

      // Splashes painted on the bottom (last row).
      const splashRow = totalRows - 1;
      const lineSplash = lines[splashRow];
      if (lineSplash) {
        for (const s of splashesRef.current) {
          const t = Math.max(0, Math.min(1, (now - s.startedAt) / s.durationMs));
          // Spread splash glyphs outward over ~5 cells.
          const spread = 1 + Math.floor(t * 4);
          for (let dc = -spread; dc <= spread; dc++) {
            const c = SPOUT_COL + dc;
            if (c >= 0 && c < totalCols && Math.abs(dc) === spread) {
              lineSplash[c] = SPLASH_GLYPHS[(s.id + Math.abs(dc)) % SPLASH_GLYPHS.length]!;
            }
          }
        }
      }

      const text = lines.map((r) => r.join('')).join('\n');
      if (preRef.current) preRef.current.textContent = text;

      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => { if (frame !== null) cancelAnimationFrame(frame); };
  }, [treasuryFillPct]);

  // Stable nominal width = totalCols × measured glyph width.
  const totalCols = FAUCET_ART[0]!.length;
  const nominalPx = totalCols * colWidth;

  return (
    <div ref={containerRef} style={{ display: 'flex', justifyContent: 'center', userSelect: 'none' }}>
      <pre
        ref={preRef}
        style={{
          margin: 0,
          color: 'var(--accent)',
          textShadow: mode === 'pour' ? '0 0 8px var(--accent)' : '0 0 4px var(--accent)',
          fontFamily: 'inherit',
          lineHeight: 1.2,
          width: `${nominalPx}px`,
          maxWidth: '100%',
          transition: 'text-shadow 200ms',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// formatCountdown — turns "2026-05-09T15:30:00Z" into "23h 04m 12s"
// ---------------------------------------------------------------------------

function formatCountdown(targetIso: string, now: number): string {
  const target = new Date(targetIso).getTime();
  let secs = Math.max(0, Math.floor((target - now) / 1000));
  const hours = Math.floor(secs / 3600); secs -= hours * 3600;
  const mins = Math.floor(secs / 60); secs -= mins * 60;
  if (hours > 0) return `${hours}h ${mins.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
  if (mins > 0) return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  return `${secs}s`;
}

// ---------------------------------------------------------------------------
// FaucetPage
// ---------------------------------------------------------------------------

export function FaucetPage() {
  const wallet = useWallet();
  const { me, refresh } = useMe();
  const [status, setStatus] = useState<FaucetStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [claimResult, setClaimResult] = useState<{ amount: string; transferId: string } | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<Mode>('idle');
  // 1Hz forced re-render so the cooldown countdown ticks. We never read
  // the value, but updating it kicks a render where Date.now() advances.
  const [, setTick] = useState(0);

  const loadStatus = useCallback(() => {
    setLoading(true);
    api.faucet()
      .then(setStatus)
      .catch((e: any) => setError(e?.message ?? 'failed to load faucet status'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Countdown re-render once per second.
  useEffect(() => {
    if (!status?.next_claim_at) return;
    const id = window.setInterval(() => setTick((x) => (x + 1) | 0), 1000);
    return () => clearInterval(id);
  }, [status?.next_claim_at]);

  const handleClaim = async () => {
    if (claiming) return;
    setError('');
    setClaiming(true);
    setMode('pour');
    try {
      const res = await api.faucetClaim();
      setClaimResult({ amount: res.amount_base_units, transferId: res.transfer_id });
      setMode('celebrate');
      // Hold the celebration mode for a couple of seconds then settle back.
      window.setTimeout(() => setMode('idle'), 2400);
      // Refresh both the user's balance and the faucet status (for the
      // new cooldown timer + treasury balance).
      void refresh();
      loadStatus();
    } catch (e: any) {
      const err = e as FaucetClaimError;
      setError(err?.message ?? 'claim failed');
      setMode('idle');
      // Refresh status so the cooldown the server enforced becomes visible.
      loadStatus();
    } finally {
      setClaiming(false);
    }
  };

  if (loading || !status) {
    return <Panel title="FAUCET"><div>loading faucet…</div></Panel>;
  }

  const treasuryBalance = BigInt(status.treasury_balance_base_units);
  const claimAmount = BigInt(status.claim_amount_base_units);
  // 21M cap as fill reference, matching the supply visualizations elsewhere.
  // The treasury rarely holds anywhere near 21M but the relative fullness
  // still feels right (a young chain shows the tank slowly filling).
  const treasuryFillPct = Math.min(1, Number(treasuryBalance) / 1e9 / 21_000_000 * 1000);
  const canAfford = treasuryBalance >= claimAmount;

  const isAuthed = wallet.status === 'unlocked' && !!me;
  const cooldownActive = !!status.next_claim_at && new Date(status.next_claim_at).getTime() > Date.now();

  return (
    <Panel title="FAUCET">
      <FaucetCanvas mode={mode} treasuryFillPct={treasuryFillPct} />

      {/* Status block */}
      <pre style={{ margin: '14px 0 4px 0', textAlign: 'center', lineHeight: 1.7 }}>{[
        `> claim: ${formatRpow(status.claim_amount_base_units)} RPOW per drip`,
        `> cooldown: 1 claim per ${status.cooldown_hours}h (per account & per IP)`,
        `> treasury: ${formatRpow(status.treasury_balance_base_units)} RPOW available`,
      ].join('\n')}</pre>

      {/* Claim CTA / cooldown / status messaging */}
      <div style={{ marginTop: 16, textAlign: 'center' }}>
        {!isAuthed && (
          <div>
            <div style={{ marginBottom: 8, color: 'var(--dim)' }}>
              you need a wallet to claim from the faucet.
            </div>
            <Link to="/login">[ create or unlock a wallet ]</Link>
          </div>
        )}

        {isAuthed && !status.enabled && (
          <div className="error">faucet is currently disabled.</div>
        )}

        {isAuthed && status.enabled && !canAfford && (
          <div className="error">
            treasury is dry — please <Link to={`/send?to=${status.treasury_pubkey}`}>donate</Link> to keep the faucet flowing.
          </div>
        )}

        {isAuthed && status.enabled && canAfford && cooldownActive && (
          <div>
            <div style={{ color: 'var(--dim)', marginBottom: 6 }}>
              {status.ineligible_reason === 'cooldown_ip'
                ? 'this IP recently claimed.'
                : 'you recently claimed.'}
            </div>
            <div style={{ fontSize: 16, color: 'var(--accent)', fontWeight: 'bold' }}>
              next claim in {formatCountdown(status.next_claim_at!, Date.now())}
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--dim)' }}>
              last claim: {new Date(status.last_claim_at!).toLocaleString()}
            </div>
          </div>
        )}

        {isAuthed && status.enabled && canAfford && !cooldownActive && (
          <div>
            <button
              onClick={handleClaim}
              disabled={claiming}
              style={{
                fontSize: 16,
                padding: '8px 24px',
                fontWeight: 'bold',
                boxShadow: claiming ? 'none' : '0 0 12px var(--accent-dim)',
              }}
            >
              [ {claiming ? 'pouring…' : `CLAIM ${formatRpow(status.claim_amount_base_units)} RPOW`} ]
            </button>
            {claimResult && mode === 'celebrate' && (
              <div style={{ marginTop: 12, color: 'var(--accent)', fontWeight: 'bold' }}>
                +{formatRpow(claimResult.amount)} RPOW received!
                {' '}<Link to={`/explorer/tx/${claimResult.transferId}`}>view tx →</Link>
              </div>
            )}
          </div>
        )}

        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      </div>

      {/* Donate CTA */}
      <div style={{
        marginTop: 22,
        padding: '12px 14px',
        border: '1px solid var(--accent-dim)',
        borderRadius: 3,
      }}>
        <div style={{ fontSize: 11, color: 'var(--dim)', letterSpacing: '0.18em', marginBottom: 6 }}>
          ▌ KEEP THE FAUCET FLOWING
        </div>
        <div style={{ fontSize: 13, marginBottom: 10 }}>
          The treasury is funded by transaction fees and direct donations. Every RPOW you
          send the treasury flows back out to new users via this faucet.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Link
            to={`/send?to=${status.treasury_pubkey}&memo=${encodeURIComponent('faucet donation')}`}
            style={{ borderBottom: 'none' }}
          >
            <button style={{ fontSize: 13 }}>[ DONATE TO TREASURY ]</button>
          </Link>
          <span style={{ fontSize: 11, color: 'var(--dim)' }}>
            <code title={status.treasury_pubkey}>{status.treasury_pubkey.slice(0, 12)}…</code>
            {' '}<CopyButton text={status.treasury_pubkey} label="copy" />
          </span>
        </div>
      </div>

      {/* History blurb */}
      <div style={{ marginTop: 22, fontSize: 12, color: 'var(--dim)', lineHeight: 1.7 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.18em', marginBottom: 6 }}>
          ▌ A LITTLE HISTORY
        </div>
        <p style={{ margin: '0 0 8px 0' }}>
          The first Bitcoin faucet was launched in <strong>June 2010</strong> by Gavin Andresen
          — the developer Satoshi Nakamoto chose to succeed him as Bitcoin's lead maintainer
          before disappearing. Gavin's faucet ran at <code>freebitcoins.appspot.com</code>{' '}
          and gave out <strong>5 BTC at a time</strong>, completely free, to anyone who showed
          up with a wallet address.
        </p>
        <p style={{ margin: '0 0 8px 0' }}>
          The goal wasn't generosity for its own sake. Bitcoin had no mainstream attention,
          essentially zero exchange rate, and the only way to get coins was to mine them or
          beg someone on the bitcointalk forum. Gavin's faucet handed out enough coins for
          curious newcomers to <em>actually try the system</em>, send a transaction, run the
          software, and see how it worked. Five BTC was a couple of cents at the time.
        </p>
        <p style={{ margin: '0 0 8px 0' }}>
          Over its lifetime the faucet distributed <strong>roughly 19,700 BTC</strong> — worth
          about 50 cents each in 2010, hundreds of millions of dollars years later. Many
          long-time Bitcoiners got their first coins from it. It's one of the cleanest
          examples of how a tiny piece of generous infrastructure can seed an entire
          ecosystem.
        </p>
        <p style={{ margin: 0 }}>
          This faucet is RPOW4's tribute. Same amount, same idea: a free drip of tokens so
          new wallets can <em>actually use</em> the system before they've mined a block.
        </p>
      </div>
    </Panel>
  );
}
