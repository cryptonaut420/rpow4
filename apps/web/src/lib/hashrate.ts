/**
 * Run a quick (default 1.5s) benchmark of the same SHA-256 mining loop
 * the worker uses for real, with an unreachable target so it never
 * finishes early. Reports hashes-per-second.
 *
 * Returns { hps } once at least one progress sample has arrived. The
 * worker is terminated before the function resolves.
 */
export interface HashrateEstimate {
  hps: number;          // hashes per second
  hashes: number;       // total hashes counted
  elapsed_ms: number;   // wall time the sample was taken over
}

export async function estimateHashrate(
  opts: { duration_ms?: number; signal?: AbortSignal } = {},
): Promise<HashrateEstimate> {
  const duration = opts.duration_ms ?? 1500;

  // 32 random bytes, deterministic format, picked at call time so the
  // GC and any HMAC caches don't get hit by the same input twice.
  const prefix = new Uint8Array(32);
  crypto.getRandomValues(prefix);
  let prefixHex = '';
  for (const b of prefix) prefixHex += b.toString(16).padStart(2, '0');

  const w = new Worker(new URL('../miner.worker.ts', import.meta.url), { type: 'module' });
  let lastHashes = 0;
  let lastElapsed = 0;

  const done = new Promise<HashrateEstimate>((resolve) => {
    const timer = setTimeout(() => {
      w.postMessage({ type: 'abort' });
      const elapsed = lastElapsed > 0 ? lastElapsed : duration;
      resolve({
        hps: lastHashes > 0 ? Math.round((lastHashes / elapsed) * 1000) : 0,
        hashes: lastHashes,
        elapsed_ms: elapsed,
      });
    }, duration);

    w.onmessage = (e: MessageEvent<any>) => {
      const m = e.data;
      if (m.type === 'progress') {
        lastHashes = Number(m.hashes);
        lastElapsed = Number(m.elapsed_ms);
      } else if (m.type === 'aborted') {
        clearTimeout(timer);
        const elapsed = lastElapsed > 0 ? lastElapsed : duration;
        resolve({
          hps: lastHashes > 0 ? Math.round((lastHashes / elapsed) * 1000) : 0,
          hashes: lastHashes,
          elapsed_ms: elapsed,
        });
      }
    };
  });

  // 40 trailing-zero bits is unreachable in any benchmark window, so
  // the worker just keeps grinding and emitting `progress` events.
  w.postMessage({ type: 'start', nonce_prefix: prefixHex, difficulty_bits: 40 });

  if (opts.signal) {
    opts.signal.addEventListener('abort', () => w.postMessage({ type: 'abort' }), { once: true });
  }

  const result = await done;
  w.terminate();
  return result;
}

export function formatHashrate(hps: number): string {
  if (hps >= 1e6) return `${(hps / 1e6).toFixed(2)} MH/s`;
  if (hps >= 1e3) return `${(hps / 1e3).toFixed(1)} kH/s`;
  return `${hps} H/s`;
}

/**
 * Given a measured hashrate and a target difficulty (trailing zero bits),
 * estimate the expected time to a solution. Probability is geometric:
 * mean attempts = 2^bits, so mean seconds = 2^bits / hps.
 */
export function expectedSecondsAt(difficulty_bits: number, hps: number): number {
  if (hps <= 0) return Infinity;
  return Math.pow(2, difficulty_bits) / hps;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '∞';
  if (seconds < 1) return `<1s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d`;
}
