import { createSHA256 } from 'hash-wasm';
import { trailingZeroBits, bytesFromHex } from '@rpow/shared';

type StartMsg = {
  type: 'start';
  nonce_prefix: string;
  difficulty_bits: number;
  /** Optional pool share threshold. When set, every hash with
   *  `trailingZeroBits >= share_difficulty_bits` is posted as a `share`
   *  message; the loop continues mining until network difficulty is met
   *  (or abort). When omitted, the worker behaves as a solo miner. */
  share_difficulty_bits?: number;
};
type AbortMsg = { type: 'abort' };
type InMsg = StartMsg | AbortMsg;

let aborted = false;

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === 'abort') { aborted = true; return; }

  aborted = false;
  const prefix = bytesFromHex(msg.nonce_prefix);
  const target = msg.difficulty_bits;
  // Pool-mode threshold. Solo runs leave this undefined and never emit
  // share messages. Clamped at the network target so a misconfigured
  // share_bits >= network_bits doesn't dual-emit on the same hash.
  const shareTarget = typeof msg.share_difficulty_bits === 'number'
    ? Math.min(msg.share_difficulty_bits, target)
    : null;

  const sha = await createSHA256();
  const buf = new Uint8Array(prefix.length + 8);
  buf.set(prefix, 0);

  const startedAt = performance.now();
  let last = startedAt;
  let count = 0n;
  let nonce = 0n;

  // Track the closest-to-target hash this cycle so the UI can show real
  // progress. Updated rarely (each new high-water mark), so it costs
  // nothing on the hot path.
  let bestZeros = -1;
  let bestHashHex = '';
  let bestNonceHex = '';

  while (!aborted) {
    let x = nonce;
    for (let i = 0; i < 8; i++) { buf[prefix.length + i] = Number(x & 0xffn); x >>= 8n; }
    sha.init();
    sha.update(buf);
    const digest = sha.digest('binary'); // Uint8Array
    const tz = trailingZeroBits(digest);
    if (tz >= target) {
      // In solo mode (no share target), a network-meeting hash ends the
      // run — the provider mints and respawns the worker.
      if (shareTarget === null) {
        (self as any).postMessage({
          type: 'found',
          solution_nonce: nonce.toString(),
          hashes: count.toString(),
          hash_hex: toHex(digest),
        });
        return;
      }
      // In pool mode the worker doesn't exit; the same hash is just a
      // share that happens to clear the network target. The server
      // detects this from the share's zero count and triggers round
      // closeout in the share-submission path. We fall through to the
      // share-emit branch below.
    }
    // Pool-mode: every share-worthy hash gets posted as a `share`
    // message. The provider POSTs it to /pool/share asynchronously; the
    // worker keeps mining without waiting for the network.
    if (shareTarget !== null && tz >= shareTarget) {
      (self as any).postMessage({
        type: 'share',
        solution_nonce: nonce.toString(),
        zeros: tz,
        hash_hex: toHex(digest),
      });
    }
    if (tz > bestZeros) {
      bestZeros = tz;
      bestHashHex = toHex(digest);
      bestNonceHex = nonce.toString(16).padStart(16, '0');
    }
    nonce++;
    count++;
    if ((count & 0xffffn) === 0n) {
      const now = performance.now();
      if (now - last > 250) {
        // `best_*` is the closest-to-target hash this cycle (sticky high-water
        // mark). `current_*` is the most recently computed digest — it changes
        // every progress tick so the visualizer has live motion to render
        // even when bestZeros is plateaued.
        (self as any).postMessage({
          type: 'progress',
          hashes: count.toString(),
          elapsed_ms: Math.round(now - startedAt),
          best_zeros: bestZeros,
          best_hash_hex: bestHashHex,
          best_nonce_hex: bestNonceHex,
          current_hash_hex: toHex(digest),
          current_zeros: tz,
          current_nonce_hex: nonce.toString(16).padStart(16, '0'),
        });
        last = now;
      }
    }
  }
  (self as any).postMessage({ type: 'aborted' });
};
