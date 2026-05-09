import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { CopyButton } from '../components/CopyButton.js';
import { api } from '../api.js';
import type { LeaderboardResponse, LedgerResponse } from '@rpow/shared';
import { shortPubkey } from '@rpow/shared';
import { formatRpow } from '../lib/format.js';

function formatNumber(value: string | number): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('en-US');
}

function formatRpowPadded(baseUnits: string, width: number): string {
  const s = formatRpow(baseUnits);
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function formatRank(rank: number, width: number): string {
  const s = `#${rank}`;
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

export function StatsPage() {
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [board, setBoard] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.ledger(), api.leaderboard()])
      .then(([l, b]) => {
        if (cancelled) return;
        setLedger(l);
        setBoard(b);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : 'failed to load stats';
        setError(msg);
      });
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return <Panel title="STATS"><div className="error">{error}</div></Panel>;
  }
  if (!ledger || !board) {
    return <Panel title="STATS"><div>loading...</div></Panel>;
  }

  const totalMinted = formatRpow(ledger.total_minted_base_units);
  const totalTransferred = formatRpow(ledger.total_transferred_base_units);
  const circulating = formatRpow(ledger.circulating_supply_base_units);
  const reward = formatRpow(ledger.current_reward_base_units);
  const blocksToHalving = formatNumber(ledger.blocks_to_next_halving);
  const blocksToDiffStep = formatNumber(ledger.blocks_to_next_difficulty_step);

  return (
    <>
      <Panel title="NETWORK STATS">
        <pre style={{ margin: 0 }}>
{`  BLOCK HEIGHT        : ${formatNumber(ledger.block_height)}
  TRANSFERS           : ${formatNumber(ledger.transfer_count)}
  ACCOUNTS            : ${formatNumber(ledger.user_count)}

  TOTAL MINTED        : ${totalMinted} RPOW   (cap 21,000,000)
  TOTAL TRANSFERRED   : ${totalTransferred} RPOW
  CIRCULATING SUPPLY  : ${circulating} RPOW

  CURRENT REWARD      : ${reward} RPOW per block (halving #${ledger.halving_index})
  CURRENT DIFFICULTY  : ${ledger.current_difficulty_bits} trailing zero bits
  NEXT HALVING        : in ${blocksToHalving} blocks
  NEXT DIFFICULTY +1  : in ${blocksToDiffStep} blocks (cap ${ledger.difficulty_max_bits})
`}
        </pre>
      </Panel>

      <Panel title={`TOP ${board.limit} BALANCES`}>
        {board.entries.length === 0 ? (
          <div style={{ color: 'var(--dim)' }}>(no balances yet — start mining)</div>
        ) : (
          <>
            <pre style={{ margin: '0 0 4px 0', color: 'var(--dim)', fontSize: 12 }}>
{`  RANK   IDENTITY                                        BALANCE (RPOW)`}
            </pre>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr auto auto',
                columnGap: 16,
                rowGap: 2,
                alignItems: 'center',
                fontFamily: 'inherit',
              }}
            >
              {board.entries.map((e) => {
                const label = e.display_name ?? shortPubkey(e.pubkey);
                return (
                  <RowFragment
                    key={e.pubkey}
                    rank={formatRank(e.rank, 5)}
                    label={label}
                    pubkey={e.pubkey}
                    balance={formatRpowPadded(e.spendable_base_units, 14)}
                    minted={formatRpow(e.minted_base_units)}
                  />
                );
              })}
            </div>
            <div style={{ marginTop: 12, color: 'var(--dim)', fontSize: 12 }}>
              snapshot: {board.generated_at.replace('T', ' ').slice(0, 19)} UTC
              {' · '}refreshes every 10s
            </div>
          </>
        )}
      </Panel>
    </>
  );
}

function RowFragment({
  rank, label, pubkey, balance, minted,
}: {
  rank: string;
  label: string;
  pubkey: string;
  balance: string;
  minted: string;
}) {
  return (
    <>
      <span style={{ color: 'var(--dim)' }}>{rank}</span>
      <span title={pubkey}>
        <code>{label}</code>{' '}
        <CopyButton text={pubkey} label="copy" />
      </span>
      <span style={{ textAlign: 'right' }}>{balance}</span>
      <span style={{ color: 'var(--dim)', fontSize: 12 }} title="lifetime mints">
        (mined {minted})
      </span>
    </>
  );
}
