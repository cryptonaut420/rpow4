import { useEffect, useMemo, useRef, useState } from 'react';
import { prepareWithSegments, measureLineStats } from '@chenglou/pretext';

// ---------------------------------------------------------------------------
// Cypherpunk mining visualizer.
//
// Two layered effects:
//
//   1. Hash rain — a multi-row stream of hex glyphs that scrolls/cycles while
//      mining, with the *real* current best hash + leading zero progress
//      pinned at the bottom. Drives the user's sense of "something is happening"
//      even at high difficulty where solves take many seconds.
//
//   2. Win banner — a "decrypt" effect (glyphs cycling through random hex
//      then settling into the final message) that fires on each block won.
//
// Why pretext? The rain wants to fill the panel's exact width in characters
// without a DOM read on every frame. We measure the active monospace font's
// glyph width once via pretext, derive a column count from the panel pixel
// width, and feed that to the RAF loop. Layout is also routed through
// pretext for the win banner so the per-character glitch positions stay
// pixel-aligned even when the surrounding layout shifts.
// ---------------------------------------------------------------------------

const HEX = '0123456789abcdef';
const GLITCH = HEX + '!@#$%&*+=<>?/\\|~^';

const RAIN_ROWS_FULL = 5;
const RAIN_ROWS_COMPACT = 3;
const RAIN_FPS = 18;       // chars cycled per second per row position
const SPINNER = ['◐', '◓', '◑', '◒'];

function formatDurationShort(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '—';
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}m${s.toString().padStart(2, '0')}s`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `${h}h${m.toString().padStart(2, '0')}m`;
}

function formatHps(hps: number): string {
  if (hps <= 0) return '— H/s';
  if (hps >= 1e9) return `${(hps / 1e9).toFixed(2)} GH/s`;
  if (hps >= 1e6) return `${(hps / 1e6).toFixed(2)} MH/s`;
  if (hps >= 1e3) return `${(hps / 1e3).toFixed(1)} KH/s`;
  return `${hps.toFixed(0)} H/s`;
}

export interface MiningVisualizerHandles {
  /** Called by the parent to push the latest worker progress into the viz. */
  setProgress(p: {
    bestZeros: number;
    bestHashHex: string;
    bestNonceHex: string;
    /**
     * The most recent digest from the worker's hot loop, refreshed each
     * progress tick (~250ms). Drives the live-updating "best candidate"
     * display so it doesn't sit frozen between high-water-mark events.
     */
    currentHashHex: string;
    currentZeros: number;
    currentNonceHex: string;
    hashesPerSec: number;
    /**
     * Total hashes done in the *current* cycle (resets to 0 each time a new
     * challenge is fetched). Drives the statistical CDF progress meter.
     */
    cycleHashes: number;
  }): void;
  /** Called by the parent on every block found; triggers the win animation. */
  triggerWin(p: { hashHex: string; nonceHex: string; rewardLabel: string; blockHeight?: string }): void;
  /** Called by the parent when mining starts or stops. */
  setActive(active: boolean): void;
}

export interface MiningVisualizerProps {
  /** Difficulty target in trailing-zero bits, used for the progress bar. */
  target: number;
  /** Imperative handle ref the parent assigns to. */
  handlesRef: React.MutableRefObject<MiningVisualizerHandles | null>;
  /**
   * Render in a slimmed-down "docked widget" form: fewer rain rows,
   * no section headers, tighter padding. Animation, RAF loop, win FX,
   * and progress meter are otherwise identical to full mode.
   */
  compact?: boolean;
}

interface WinFx {
  id: number;
  startedAt: number;
  hashHex: string;
  nonceHex: string;
  rewardLabel: string;
  blockHeight?: string;
}

/**
 * Determine the panel's column count by measuring a wide string of `M`s in
 * the live monospace font — pretext returns the natural width, from which
 * we back out chars-per-pixel and clamp into the available container width.
 */
function useMonoColCount(containerRef: React.RefObject<HTMLDivElement>): number {
  const [cols, setCols] = useState(64);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function recompute() {
      if (!el) return;
      const cs = window.getComputedStyle(el);
      const font = `${cs.fontSize} ${cs.fontFamily}`;
      // Measure 100 'M's so any sub-pixel rounding averages out.
      const prepared = prepareWithSegments('M'.repeat(100), font);
      // measureLineStats with a huge max-width forces no wrap so the result
      // is the natural width of the whole string.
      const { maxLineWidth } = measureLineStats(prepared, 1e6);
      const charWidth = maxLineWidth / 100;
      const innerW = el.clientWidth;
      const c = Math.max(20, Math.floor(innerW / charWidth) - 2);
      setCols(c);
    }

    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  return cols;
}

export function MiningVisualizer({ target, handlesRef, compact = false }: MiningVisualizerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cols = useMonoColCount(containerRef);
  const rainRows = compact ? RAIN_ROWS_COMPACT : RAIN_ROWS_FULL;

  // Refs hold all high-frequency state so the RAF loop never triggers React
  // re-renders. The parent's handles also write into refs, never into state.
  const activeRef = useRef(false);
  const bestZerosRef = useRef(-1);
  const bestHashRef = useRef<string>('');
  const bestNonceRef = useRef<string>('');
  // Live (most recent) hash sample from the worker. Refreshed every
  // ~250ms regardless of best-zeros progress so the displayed "best
  // candidate" hash actually changes between high-water-mark events.
  const currentHashRef = useRef<string>('');
  const currentZerosRef = useRef(0);
  const currentNonceRef = useRef<string>('');
  const hpsRef = useRef(0);
  // Latest cycle hash count from the worker + when it arrived. The RAF loop
  // extrapolates between progress messages so the meter moves smoothly.
  const cycleHashesRef = useRef(0);
  const lastProgressAtRef = useRef(0);
  const winFxRef = useRef<WinFx | null>(null);
  const winCounterRef = useRef(0);

  // RAF-rendered DOM nodes. We update textContent directly so React never
  // needs to reconcile the rapidly-changing strings.
  const rainNodeRefs = useRef<Array<HTMLPreElement | null>>([]);
  const bestHashNodeRef = useRef<HTMLSpanElement>(null);
  const bestZerosNodeRef = useRef<HTMLSpanElement>(null);
  const progressBarNodeRef = useRef<HTMLSpanElement>(null);
  const progressPctNodeRef = useRef<HTMLSpanElement>(null);
  const expectedNodeRef = useRef<HTMLSpanElement>(null);
  const nonceNodeRef = useRef<HTMLSpanElement>(null);
  const hpsNodeRef = useRef<HTMLSpanElement>(null);
  const spinnerNodeRef = useRef<HTMLSpanElement>(null);
  const winLayerRef = useRef<HTMLDivElement>(null);

  // Per-row independent rain offsets so the columns drift at different rates
  // — gives a parallax / falling-data feel without much code.
  const rainStateRef = useRef<{ chars: string[]; flashes: number[] }[]>([]);

  useEffect(() => {
    rainStateRef.current = Array.from({ length: rainRows }, () => ({
      chars: Array.from({ length: cols }, () => HEX[Math.floor(Math.random() * 16)]!),
      flashes: Array.from({ length: cols }, () => Math.random() * RAIN_FPS),
    }));
  }, [cols, rainRows]);

  // Imperative handle exposed to parent.
  useEffect(() => {
    handlesRef.current = {
      setProgress(p) {
        bestZerosRef.current = p.bestZeros;
        bestHashRef.current = p.bestHashHex;
        bestNonceRef.current = p.bestNonceHex;
        currentHashRef.current = p.currentHashHex;
        currentZerosRef.current = p.currentZeros;
        currentNonceRef.current = p.currentNonceHex;
        hpsRef.current = p.hashesPerSec;
        cycleHashesRef.current = p.cycleHashes;
        lastProgressAtRef.current = performance.now();
      },
      triggerWin(p) {
        winCounterRef.current += 1;
        winFxRef.current = {
          id: winCounterRef.current,
          startedAt: performance.now(),
          hashHex: p.hashHex,
          nonceHex: p.nonceHex,
          rewardLabel: p.rewardLabel,
          blockHeight: p.blockHeight,
        };
      },
      setActive(active) {
        activeRef.current = active;
        if (!active) {
          // Snap rain to a static dim state so it doesn't keep cycling
          // when stopped. Bar + best stay at their last value.
          if (winFxRef.current && performance.now() - winFxRef.current.startedAt > 2200) {
            winFxRef.current = null;
          }
        }
      },
    };
    return () => { handlesRef.current = null; };
  }, [handlesRef]);

  // The single RAF loop. Mutates DOM directly.
  useEffect(() => {
    let frame: number | null = null;
    let prev = performance.now();

    function tick(now: number) {
      const dt = now - prev;
      prev = now;

      const active = activeRef.current;
      const winFx = winFxRef.current;

      // ---- Hash rain --------------------------------------------------------
      const rows = rainStateRef.current;
      const cycleProb = active ? (dt / 1000) * RAIN_FPS : 0;
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r]!;
        for (let c = 0; c < row.chars.length; c++) {
          // Mostly hex; rarely glitch glyphs to keep it spicy.
          if (Math.random() < cycleProb) {
            const g = Math.random() < 0.04 ? GLITCH : HEX;
            row.chars[c] = g[Math.floor(Math.random() * g.length)]!;
            row.flashes[c] = 0.6;
          } else if (row.flashes[c]! > 0) {
            row.flashes[c] = Math.max(0, row.flashes[c]! - dt / 400);
          }
        }
        const node = rainNodeRefs.current[r];
        if (node) {
          // Render with a lightweight mark for "flash" cells: uppercase to
          // signal recent activity. CSS handles the actual color via opacity.
          let s = '';
          for (let c = 0; c < row.chars.length; c++) {
            const ch = row.chars[c]!;
            s += row.flashes[c]! > 0.3 ? ch.toUpperCase() : ch;
          }
          node.textContent = s;
          // Vertical fade: top rows dimmer, bottom row brightest.
          const fadeDenom = Math.max(1, rows.length - 1);
          const baseOpacity = active ? 0.18 + (r / fadeDenom) * 0.5 : 0.12;
          node.style.opacity = String(baseOpacity);
        }
      }

      // ---- Best hash row ----------------------------------------------------
      // We render the *current* hash sample (refreshed each progress tick)
      // so the line actually moves. Highlight is computed from this exact
      // hash's own trailing zeros, so when a particularly-close candidate
      // streams by it visibly flashes; otherwise the tail is dim. The
      // "zeros: N / target" caption below still shows the cycle high-water
      // mark from bestZerosRef so the headline progress signal is preserved.
      const bestZeros = bestZerosRef.current;
      const liveHash = currentHashRef.current || bestHashRef.current;
      const liveZeros = currentHashRef.current ? currentZerosRef.current : bestZeros;
      if (bestHashNodeRef.current) {
        if (liveHash) {
          // Each hex char encodes 4 bits, so floor(zeros/4) hex chars at
          // the tail are guaranteed-zero — color those as the "got close"
          // accent.
          const hexZeros = Math.min(liveHash.length, Math.max(0, Math.floor(liveZeros / 4)));
          const head = liveHash.slice(0, liveHash.length - hexZeros);
          const tail = liveHash.slice(liveHash.length - hexZeros);
          bestHashNodeRef.current.innerHTML = '';
          const headNode = document.createElement('span');
          headNode.style.color = 'var(--dim)';
          headNode.textContent = head;
          const tailNode = document.createElement('span');
          tailNode.style.color = 'var(--accent)';
          tailNode.style.textShadow = '0 0 6px var(--accent)';
          tailNode.textContent = tail;
          bestHashNodeRef.current.appendChild(headNode);
          bestHashNodeRef.current.appendChild(tailNode);
        } else {
          bestHashNodeRef.current.textContent = '—'.repeat(64);
        }
      }
      if (bestZerosNodeRef.current) {
        bestZerosNodeRef.current.textContent =
          bestZeros < 0 ? '0' : String(bestZeros);
      }

      // ---- Progress bar (statistical CDF) ----------------------------------
      // Each hash has independent probability p = 2^-target of solving. After
      // N hashes, the chance we *should* have solved by now (the geometric
      // CDF) is `1 - exp(-N * p) = 1 - exp(-N / 2^target)`. This is a much
      // more honest "how close are you" signal than `bestZeros / target`,
      // since one extra trailing zero doubles the expected work.
      //
      // We extrapolate hashes between worker progress messages (which arrive
      // every ~250 ms) using the measured hashrate so the bar moves smoothly.
      const hps = hpsRef.current;
      const expectedHashes = target > 0 ? Math.pow(2, target) : 0;
      const sinceProgressSec = lastProgressAtRef.current > 0
        ? Math.max(0, (now - lastProgressAtRef.current) / 1000)
        : 0;
      const estHashes = active
        ? cycleHashesRef.current + sinceProgressSec * hps
        : cycleHashesRef.current;
      const cdf = expectedHashes > 0 && estHashes > 0
        ? 1 - Math.exp(-estHashes / expectedHashes)
        : 0;

      const barWidth = Math.max(20, Math.min(40, cols - 24));
      const filled = Math.floor(cdf * barWidth);
      if (progressBarNodeRef.current) {
        const fillCh = '█';
        const emptyCh = '░';
        progressBarNodeRef.current.innerHTML = '';
        const f = document.createElement('span');
        f.style.color = 'var(--accent)';
        f.style.textShadow = '0 0 4px var(--accent)';
        f.textContent = fillCh.repeat(filled);
        const e = document.createElement('span');
        e.style.color = 'var(--dimmer)';
        e.textContent = emptyCh.repeat(barWidth - filled);
        progressBarNodeRef.current.appendChild(f);
        progressBarNodeRef.current.appendChild(e);
      }
      if (progressPctNodeRef.current) {
        progressPctNodeRef.current.textContent = `${(cdf * 100).toFixed(0)}%`;
      }
      if (expectedNodeRef.current) {
        if (expectedHashes > 0 && hps > 0) {
          const expectedSolveSec = expectedHashes / hps;
          const ratio = estHashes / expectedHashes;
          // Hashing is memoryless, so "ETA" in the dependency-pruning sense
          // is meaningless — the expected wait from any moment is always
          // 2^target / hps. We show that as the headline number; if the
          // current cycle is already running long we add an "Nx expected"
          // multiplier to convey "you're getting unlucky" honestly.
          const overrun = ratio > 1.2 ? ` · running ${ratio.toFixed(1)}× expected` : '';
          expectedNodeRef.current.textContent =
            `expected solve ~${formatDurationShort(expectedSolveSec)} @ ${formatHps(hps)}${overrun}`;
        } else {
          expectedNodeRef.current.textContent = active ? 'measuring rate…' : '—';
        }
      }

      // ---- Live nonce + hps + spinner --------------------------------------
      if (nonceNodeRef.current) {
        nonceNodeRef.current.textContent = bestNonceRef.current
          ? `0x${bestNonceRef.current}`
          : '0x' + '0'.repeat(16);
      }
      if (hpsNodeRef.current) {
        const hps = hpsRef.current;
        const txt = hps > 0 ? `${(hps / 1e6).toFixed(2)} MH/s` : '— MH/s';
        hpsNodeRef.current.textContent = txt;
      }
      if (spinnerNodeRef.current) {
        spinnerNodeRef.current.textContent = active
          ? SPINNER[Math.floor(now / 120) % SPINNER.length]!
          : '·';
      }

      // ---- Win animation ----------------------------------------------------
      const winLayer = winLayerRef.current;
      if (winLayer) {
        if (winFx) {
          const elapsed = now - winFx.startedAt;
          const total = 2000;
          if (elapsed > total) {
            winFxRef.current = null;
            winLayer.innerHTML = '';
            winLayer.style.display = 'none';
          } else {
            renderWinFx(winLayer, winFx, elapsed, cols);
          }
        } else if (winLayer.childNodes.length > 0) {
          winLayer.innerHTML = '';
          winLayer.style.display = 'none';
        }
      }

      frame = requestAnimationFrame(tick);
    }

    frame = requestAnimationFrame(tick);
    return () => { if (frame !== null) cancelAnimationFrame(frame); };
  }, [cols, target]);

  // --- Static layout structure ------------------------------------------------
  const railStyle = useMemo<React.CSSProperties>(() => ({
    fontFamily: 'inherit',
    margin: 0,
    whiteSpace: 'pre',
    overflow: 'hidden',
    letterSpacing: 0,
    lineHeight: 1.25,
    color: 'var(--accent)',
    transition: 'opacity 200ms',
  }), []);

  // Compact mode trims labels and padding but keeps every animated piece —
  // hash rain, best-candidate row, progress bar, nonce/hps footer, and the
  // win banner all still render. The user explicitly asked for the docked
  // strip to look "EXACTLY like before, just condensed a bit."
  const padding = compact ? '6px 10px' : '10px 12px';
  const marginTop = compact ? 0 : 12;
  const rowLineHeight = compact ? 1.15 : 1.25;

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        marginTop,
        padding,
        background: 'rgba(0,0,0,0.35)',
        border: '1px solid var(--accent-dim)',
        borderRadius: 3,
        boxShadow: 'inset 0 0 22px rgba(0,0,0,0.55), 0 0 24px var(--glow)',
        overflow: 'hidden',
      }}
    >
      {/* Header label */}
      {!compact && (
        <div style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: '0.18em', marginBottom: 6 }}>
          ▌ HASH STREAM
        </div>
      )}

      {/* Rain rows */}
      <div style={{ position: 'relative', minHeight: 22 * rainRows }}>
        {Array.from({ length: rainRows }).map((_, i) => (
          <pre
            key={i}
            ref={(el) => { rainNodeRefs.current[i] = el; }}
            style={{ ...railStyle, lineHeight: rowLineHeight }}
          />
        ))}
      </div>

      {/* Best hash + leading-zero count */}
      <div style={{ marginTop: compact ? 4 : 8, fontSize: 12 }}>
        {!compact && (
          <div style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: '0.18em' }}>
            ▌ BEST CANDIDATE
          </div>
        )}
        <pre style={{ margin: '2px 0 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.3 }}>
          <span ref={bestHashNodeRef} />
        </pre>
        <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--dim)' }}>
            zeros: <span ref={bestZerosNodeRef} style={{ color: 'var(--accent)', fontWeight: 'bold' }} /> / {target}
          </span>
          <span style={{ fontFamily: 'inherit' }}>
            <span ref={progressBarNodeRef} />{' '}
            <span ref={progressPctNodeRef} style={{ color: 'var(--accent)' }} />
          </span>
        </div>
        {/* Expected-solve ETA — useful in both modes so the user always
         * sees the headline "how long should this take" alongside the
         * statistical CDF percentage above. */}
        <div style={{ marginTop: 2, fontSize: 11, color: 'var(--dim)', textAlign: 'right' }}>
          <span ref={expectedNodeRef} />
        </div>
      </div>

      {/* Live status footer */}
      <div style={{ marginTop: compact ? 4 : 8, fontSize: 11, color: 'var(--dim)', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span>nonce <span ref={nonceNodeRef} style={{ color: 'var(--fg)' }} /></span>
        <span><span ref={hpsNodeRef} style={{ color: 'var(--fg)' }} /> <span ref={spinnerNodeRef} style={{ color: 'var(--accent)' }} /></span>
      </div>

      {/* Win-animation overlay */}
      <div
        ref={winLayerRef}
        style={{
          display: 'none',
          position: 'absolute',
          inset: 0,
          padding: '12px 14px',
          background: 'rgba(0,0,0,0.78)',
          backdropFilter: 'blur(1px)',
          color: 'var(--accent)',
          fontFamily: 'inherit',
          textAlign: 'center',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Win-effect renderer.
//
// Animates a multi-line ASCII banner whose individual characters spend the
// first ~600ms cycling through random hex/glitch glyphs and then "decrypt"
// to their final value over a staggered window. After the decrypt resolves,
// the whole banner gently pulses for the remainder of the 2s lifetime.
// ---------------------------------------------------------------------------

function renderWinFx(host: HTMLDivElement, fx: WinFx, elapsed: number, _cols: number) {
  // Reuse the existing tree on subsequent frames to avoid per-frame allocs.
  // First frame builds the static structure; later frames just walk it.
  if (!host.dataset.winId || host.dataset.winId !== String(fx.id)) {
    host.dataset.winId = String(fx.id);
    host.style.display = 'flex';
    host.style.flexDirection = 'column';
    host.innerHTML = '';

    const lines: string[] = [];
    lines.push('╔══════════════════════════════════════════════╗');
    const titleLeft = '║   ▓▒░  ';
    const titleRight = '  ░▒▓   ║';
    const spaceForTitle = 46 - (titleLeft.length - 1) - (titleRight.length - 1);
    const title = '*** BLOCK MINED ***';
    const titlePad = Math.max(0, Math.floor((spaceForTitle - title.length) / 2));
    const titleLine = titleLeft +
      ' '.repeat(titlePad) +
      title +
      ' '.repeat(spaceForTitle - title.length - titlePad) +
      titleRight;
    lines.push(titleLine);
    lines.push('╚══════════════════════════════════════════════╝');
    lines.push('');
    lines.push(fx.rewardLabel);
    if (fx.blockHeight) lines.push(`block #${fx.blockHeight}`);
    lines.push(`nonce 0x${fx.nonceHex}`);
    // Truncate the hash so it fits a single line in narrow panels.
    lines.push(`hash  ${fx.hashHex.slice(0, 32)}…`);

    for (const line of lines) {
      const lineEl = document.createElement('div');
      lineEl.style.whiteSpace = 'pre';
      lineEl.style.fontFamily = 'inherit';
      lineEl.style.lineHeight = '1.35';
      lineEl.dataset.final = line;
      // Each char gets its own span so we can drive per-character glitch.
      for (let i = 0; i < line.length; i++) {
        const span = document.createElement('span');
        span.dataset.final = line[i] ?? ' ';
        span.dataset.idx = String(i);
        span.textContent = line[i] ?? ' ';
        lineEl.appendChild(span);
      }
      host.appendChild(lineEl);
    }
  }

  // Per-character resolve schedule. Each char has its own "resolve at" time
  // distributed across [0, RESOLVE_END]. Before resolve: random glitch glyph.
  // After resolve: the final glyph, with a brief flash.
  const RESOLVE_START = 0;
  const RESOLVE_END = 750;
  const PULSE_START = RESOLVE_END + 100;
  const PULSE_LEN = 2000 - PULSE_START;

  const lineEls = Array.from(host.children) as HTMLDivElement[];
  for (const lineEl of lineEls) {
    const final = lineEl.dataset.final ?? '';
    if (final.length === 0) continue;

    for (let i = 0; i < lineEl.children.length; i++) {
      const span = lineEl.children[i] as HTMLSpanElement;
      const finalCh = span.dataset.final ?? ' ';

      // Whitespace/structural chars resolve immediately (less visual noise).
      const isStructural = !/[A-Za-z0-9*░▒▓#@&~]/.test(finalCh);

      // Deterministic-ish per-char resolve time so the animation looks
      // coherent rather than chaotic — earlier characters resolve first.
      const resolveAt = isStructural
        ? 0
        : RESOLVE_START + ((i * 37 + 13) % (RESOLVE_END - RESOLVE_START));

      if (elapsed < resolveAt) {
        // Glitch phase
        const glyph = GLITCH[Math.floor(Math.random() * GLITCH.length)]!;
        span.textContent = glyph;
        span.style.color = 'var(--accent)';
        span.style.opacity = '0.55';
      } else if (elapsed < resolveAt + 150) {
        // Just-resolved flash
        span.textContent = finalCh;
        span.style.color = 'var(--fg)';
        span.style.textShadow = '0 0 8px var(--accent)';
        span.style.opacity = '1';
      } else {
        // Settled
        span.textContent = finalCh;
        // Subtle pulse on the banner glyphs after resolve.
        const pulseT = Math.max(0, elapsed - PULSE_START) / PULSE_LEN;
        const pulse = 0.85 + 0.15 * Math.sin(pulseT * Math.PI * 4);
        span.style.color = 'var(--accent)';
        span.style.textShadow = '0 0 6px var(--accent)';
        span.style.opacity = String(Math.max(0.55, pulse * (1 - Math.max(0, (elapsed - 1700) / 300))));
      }
    }
  }
}
