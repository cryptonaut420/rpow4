import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import { usePageMeta } from '../hooks/usePageMeta.js';
import type { LedgerResponse } from '@rpow/shared';
import { formatRpow } from '../lib/format.js';

function formatNumber(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString('en-US');
}

export function LedgerPage() {
  usePageMeta('About', 'Learn about RPOW4 — a modern tribute to Hal Finney\'s original Reusable Proofs of Work system. View live supply and network stats.');
  const [d, setD] = useState<LedgerResponse | null>(null);
  useEffect(() => { api.ledger().then(setD); }, []);
  if (!d) return <Panel title="PUBLIC LEDGER"><div>loading...</div></Panel>;
  const totalMinted = formatRpow(d.total_minted_base_units);
  const totalTransferred = formatRpow(d.total_transferred_base_units);
  const circulating = formatRpow(d.circulating_supply_base_units);
  const reward = formatRpow(d.current_reward_base_units);
  const nextReward = formatRpow(d.next_reward_base_units);
  return (
    <>
      <Panel title="PUBLIC LEDGER">
        <pre style={{ margin: 0 }}>
{`  TOTAL MINTED        : ${totalMinted} RPOW
  TOTAL TRANSFERRED   : ${totalTransferred} RPOW
  CIRCULATING SUPPLY  : ${circulating} RPOW
  USER COUNT          : ${d.user_count}

  BLOCK HEIGHT        : ${formatNumber(d.block_height)}
  CURRENT REWARD      : ${reward} RPOW per block
  NEXT REWARD         : ${nextReward} RPOW (in ${formatNumber(d.blocks_to_next_halving)} blocks)
  HALVING INDEX       : ${d.halving_index} of ~36 (geometric to 21M cap)

  CURRENT DIFFICULTY  : ${d.current_difficulty_bits} trailing zero bits
  NEXT DIFFICULTY     : ${d.next_difficulty_bits} (in ${formatNumber(d.blocks_to_next_difficulty_step)} blocks)
  DIFFICULTY CEILING  : ${d.difficulty_max_bits} bits
`}
        </pre>
        <div style={{ marginTop: 12 }} className="tagline">
          a modern tribute building on{' '}
          <a href="https://github.com/frkrueger/rpow" target="_blank" rel="noreferrer">rpow2</a>
          {' '}and{' '}
          <a href="https://github.com/arben777/rpow3" target="_blank" rel="noreferrer">rpow3</a>,
          tracing back to{' '}
          <a href="https://nakamotoinstitute.org/finney/rpow/" target="_blank" rel="noreferrer">hal finney's original rpow</a>.
        </div>
      </Panel>

      <Panel title="ABOUT RPOW4">
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
{`  Hal Finney published RPOW (Reusable Proofs of Work) in 2004 as the
  first cryptographic money based on proof-of-work. Bitcoin came four
  years later, in 2008/2009.

  Finney was deeply involved in early Bitcoin: he received the first
  bitcoin transaction from Satoshi Nakamoto in January 2009. Many have
  speculated he was part of the team behind the Satoshi pseudonym — a
  claim he denied during his lifetime.

  The original RPOW was centralized. A single trusted server, running
  on an IBM 4758 secure coprocessor, signed token transfers and
  prevented double-spends. There was no blockchain, no decentralized
  consensus, and no difficulty adjustment — meaning the supply was
  effectively unbounded as long as someone had compute. (A trusted
  server could enforce a cap; Finney just didn't.)

  Bitcoin solved all three: decentralized consensus via PoW mining tied
  to a chain, automatic difficulty adjustment, and a fixed 21M supply
  cap.

  Lineage: this project builds on community ports that came before.
  RPOW2 (github.com/frkrueger/rpow) was the first modern web-app
  revival of Hal's idea and is the direct ancestor of this project;
  RPOW3 (github.com/arben777/rpow3) continued that lineage. RPOW4
  inherits from both — see the [ ecosystem ] page for live links.

  RPOW4 is a modern tribute to the spirit of Finney's original. No IBM
  4758 — Ed25519 signatures, BIP-39 / SLIP-0010 wallets, every
  state-changing action signed by the user's keypair, Postgres ledger.
  Still centralized — but Bitcoin-flavored where it counts:

  - Hard 21,000,000 RPOW supply cap, exactly. No founder allocation,
    no premine, no operator-held wallet skimmed off the top — every
    RPOW in circulation was earned by an accepted proof of work.
  - Bitcoin-style block reward: 50 RPOW per accepted PoW solution
    initially, halving every 210,000 blocks. The geometric sum closes
    out at exactly 21M.
  - Difficulty ramps with the schedule: 24 trailing-zero bits at
    block 0, +1 bit every 164,062 blocks (≈ 21M / 128), capped at
    50 bits so the schedule stays mineable forever.
  - No 10-minute block-time enforcement — the simulation runs as fast
    as the network can mine. Difficulty is the only governor.

  Accepted proofs credit balances directly. Transfers move ledger
  balances with no fees.

  MINING MODES. Two modes are available from the bottom mining bar:

  - SOLO — your browser scans for hashes that meet the network
    difficulty. Find one, you keep 100% of the block reward. Highest
    variance: long dry spells when the network difficulty is high.

  - POOL (recommended) — your browser submits lower-difficulty
    "shares" to a centralized pool. When ANY pool member's share also
    clears the network target, the block is won and the reward is
    split: 2% to the treasury, 25% finder bonus to the lucky miner,
    and the remaining 75% split pro-rata across the round's other
    shares. You earn frequently and predictably. The treasury cut
    funds the faucet.

  Caveat: this IS a centralized system. The ledger lives in a Postgres
  database operated by one person on rented infrastructure. If that
  server is breached, lost, or seized, your tokens may be lost with
  it. No warranty, no recovery guarantees, and no responsibility is
  taken for breaches, downtime, or data loss. Treat it accordingly.
`}
        </pre>
      </Panel>
    </>
  );
}
