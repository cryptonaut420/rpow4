import { createHmac } from 'node:crypto';
import { canonicalJson } from '@rpow/shared';

/**
 * Pool challenge envelope. The server MACs every field below so the
 * client can't tamper with difficulty or expiry between issuance and
 * share submission. The `domain` field gives strict separation from
 * mint/auth/signup MACs that share the same secret.
 */
export interface PoolChallengeEnvelope {
  challenge_id: string;
  user_pubkey: string;
  nonce_prefix: string;
  network_difficulty_bits: number;
  share_difficulty_bits: number;
  issued_at: string;
  expires_at: string;
  domain: 'rpow4.pool';
}

export function macPoolChallenge(envelope: PoolChallengeEnvelope, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson(envelope)).digest('hex');
}
