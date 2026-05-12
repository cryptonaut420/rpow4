import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@rpow/shared';

export interface MintChallengeEnvelope {
  asset_id: string;
  challenge_id: string;
  user_pubkey: string;
  nonce_prefix: string;
  difficulty_bits: number;
  issued_at: string;
  expires_at: string;
  domain: 'rpow4.asset.mint.v1';
}

export function macMintChallenge(envelope: MintChallengeEnvelope, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson(envelope)).digest('hex');
}

export function macsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
