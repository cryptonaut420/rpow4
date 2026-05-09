import { createSHA256 } from 'hash-wasm';
import { trailingZeroBits, bytesFromHex } from '@rpow/shared';

type StartMsg = { type: 'start'; nonce_prefix: string; difficulty_bits: number };
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
      (self as any).postMessage({
        type: 'found',
        solution_nonce: nonce.toString(),
        hashes: count.toString(),
        hash_hex: toHex(digest),
      });
      return;
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
        (self as any).postMessage({
          type: 'progress',
          hashes: count.toString(),
          elapsed_ms: Math.round(now - startedAt),
          best_zeros: bestZeros,
          best_hash_hex: bestHashHex,
          best_nonce_hex: bestNonceHex,
        });
        last = now;
      }
    }
  }
  (self as any).postMessage({ type: 'aborted' });
};
