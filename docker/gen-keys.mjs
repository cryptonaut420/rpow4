// Generate a fresh Ed25519 dev keypair in the same raw 32-byte hex format
// that `apps/server/src/signing.ts:generateKeypair` produces. Output is two
// `KEY=value` lines suitable for sourcing into a shell session.
//
// Used by docker/server-entrypoint.sh on first start so devs don't have to
// hand-craft signing key env vars. The result is persisted to a Compose
// named volume so subsequent `docker compose up` runs reuse the same keys
// (otherwise tokens minted in a previous session would stop verifying).
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
const pub  = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

process.stdout.write(`RPOW_SIGNING_PRIVATE_KEY_HEX=${priv}\n`);
process.stdout.write(`RPOW_SIGNING_PUBLIC_KEY_HEX=${pub}\n`);
