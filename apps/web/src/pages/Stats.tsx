import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { CopyButton } from '../components/CopyButton.js';
import { api } from '../api.js';
import { usePageMeta } from '../hooks/usePageMeta.js';
import type {
  LeaderboardEntry,
  LeaderboardResponse,
  LeaderboardSort,
  LedgerResponse,
  PoolStatsResponse,
} from '@rpow/shared';
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

/**
 * Percentage of `total` that `part` represents, formatted to 2 decimal
 * places. Uses BigInt-scaled basis points so we don't lose precision on
 * large base-unit values that overflow Number safely.
 */
function formatShareOfTotal(part: string, total: string): string {
  const t = BigInt(total);
  if (t === 0n) return '0.00%';
  const bps = Number(BigInt(part) * 10_000n / t);
  const pct = bps / 100;
  if (pct > 0 && pct < 0.01) return '<0.01%';
  return `${pct.toFixed(2)}%`;
}

const SORT_LABELS: Record<LeaderboardSort, { tab: string; panel: string; primary: string }> = {
  balance: { tab: 'richest', panel: 'TOP 100 RICHEST', primary: 'BALANCE' },
  minted:  { tab: 'most mined', panel: 'TOP 100 MINERS', primary: 'MINED' },
};

/** Network stats + both leaderboards refresh on this interval while the page is open. */
const STATS_REFRESH_MS = 30_000;

function formatHashrateCompact(hps: number): string {
  if (!Number.isFinite(hps) || hps <= 0) return '—';
  if (hps >= 1e9) return `${(hps / 1e9).toFixed(2)} GH/s`;
  if (hps >= 1e6) return `${(hps / 1e6).toFixed(2)} MH/s`;
  if (hps >= 1e3) return `${(hps / 1e3).toFixed(1)} KH/s`;
  return `${Math.round(hps)} H/s`;
}

export function StatsPage() {
  usePageMeta('Stats', 'RPOW4 network statistics, mining leaderboards, and richest accounts on the network.');
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [poolStats, setPoolStats] = useState<PoolStatsResponse | null>(null);
  // Cache both sort variants once they've been fetched so flipping the
  // toggle is instant after the first round-trip.
  const [boards, setBoards] = useState<Partial<Record<LeaderboardSort, LeaderboardResponse>>>({});
  const [sort, setSort] = useState<LeaderboardSort>('balance');
  const [error, setError] = useState('');
  const [loadingBoard, setLoadingBoard] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.ledger()
        .then((l) => { if (!cancelled) setLedger(l); })
        .catch((e: unknown) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : 'failed to load ledger');
        });
    };
    load();
    const id = window.setInterval(load, STATS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Pool stats: refresh on a tighter cadence than ledger because the
  // round + active-miner count change every share submission.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.poolStats()
        .then((r) => { if (!cancelled) setPoolStats(r); })
        .catch(() => { /* tolerate transient failures */ });
    };
    load();
    const id = window.setInterval(load, 5_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadBoth = (isInitial: boolean) => {
      if (isInitial) setLoadingBoard(true);
      Promise.all([api.leaderboard('balance'), api.leaderboard('minted')])
        .then(([balance, minted]) => {
          if (cancelled) return;
          setBoards({ balance, minted });
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          if (isInitial) {
            setError(e instanceof Error ? e.message : 'failed to load leaderboard');
          }
          /* background refresh: keep last good snapshot */
        })
        .finally(() => {
          if (!cancelled && isInitial) setLoadingBoard(false);
        });
    };
    loadBoth(true);
    const id = window.setInterval(() => loadBoth(false), STATS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (error) {
    return <Panel title="STATS"><div className="error">{error}</div></Panel>;
  }
  if (!ledger) {
    return <Panel title="STATS"><div>loading...</div></Panel>;
  }

  const totalMinted = formatRpow(ledger.total_minted_base_units);
  const totalTransferred = formatRpow(ledger.total_transferred_base_units);
  const circulating = formatRpow(ledger.circulating_supply_base_units);
  const reward = formatRpow(ledger.current_reward_base_units);
  const blocksToHalving = formatNumber(ledger.blocks_to_next_halving);
  const blocksToDiffStep = formatNumber(ledger.blocks_to_next_difficulty_step);
  const treasuryBalance = formatRpow(ledger.treasury_balance_base_units ?? '0');
  const totalFees = formatRpow(ledger.total_fees_collected_base_units ?? '0');
  const currentFee = formatRpow(ledger.current_fee_base_units ?? '0');
  const currentTrollboxFee = formatRpow(ledger.current_trollbox_fee_base_units ?? '0');
  const faucetClaimCount = formatNumber(ledger.faucet_claim_count ?? '0');
  const faucetTotalClaimed = formatRpow(ledger.faucet_total_claimed_base_units ?? '0');

  const board = boards[sort];

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

  SEND FEE            : ${currentFee} RPOW per transfer
  TROLLBOX POST FEE   : ${currentTrollboxFee} RPOW per post
  TOTAL FEES EARNED   : ${totalFees} RPOW
  TREASURY BALANCE    : ${treasuryBalance} RPOW

  FAUCET CLAIMS       : ${faucetClaimCount}
  FAUCET DRIPPED      : ${faucetTotalClaimed} RPOW

  TROLLBOX MESSAGES   : ${formatNumber(ledger.trollbox_message_count)}
`}
        </pre>
      </Panel>

      {poolStats && poolStats.enabled && (
        <Panel title="MINING POOL">
          <pre style={{ margin: 0 }}>
{`  POOL HASHRATE       : ${formatHashrateCompact(poolStats.pool_hashrate_hps)}
  ACTIVE MINERS       : ${formatNumber(poolStats.active_miners)}
  POOL FEE            : ${(poolStats.pool_fee_bps / 100).toFixed(2)}% of block reward → treasury
  FINDER BONUS        : ${(poolStats.finder_bps / 100).toFixed(2)}% of net to the lucky miner
  SHARE DIFFICULTY    : ${poolStats.share_difficulty_bits} bits  (network ${poolStats.network_difficulty_bits} bits)
  CURRENT ROUND       : #${poolStats.current_round?.id ?? '—'}  ${poolStats.current_round ? formatNumber(poolStats.current_round.total_shares) : 0} share${poolStats.current_round?.total_shares === '1' ? '' : 's'}
`}
          </pre>
          {poolStats.recent_payouts.length > 0 && (
            <>
              <div style={{ margin: '12px 0 4px', color: 'var(--dim)', fontSize: 11, letterSpacing: '0.14em' }}>
                RECENT POOL ROUNDS
              </div>
              <pre style={{ margin: 0, fontSize: 12, color: 'var(--dim)' }}>
{poolStats.recent_payouts.map((p) => {
  const at = new Date(p.ended_at).toISOString().slice(11, 19) + ' UTC';
  const finder = p.finder_display_name ? `@${p.finder_display_name}` : `${p.finder_pubkey.slice(0, 6)}…${p.finder_pubkey.slice(-4)}`;
  return `  ${at}  #${p.round_id}  ${formatRpow(p.reward_base_units).padStart(11)} RPOW · ${p.participant_count} miner${p.participant_count === 1 ? '' : 's'} · won by ${finder}`;
}).join('\n')}
              </pre>
            </>
          )}
        </Panel>
      )}

      <Panel title={SORT_LABELS[sort].panel}>
        <div style={{ marginBottom: 10 }}>
          <SortTab active={sort === 'balance'} onClick={() => setSort('balance')} label={SORT_LABELS.balance.tab} />
          {' '}
          <SortTab active={sort === 'minted'}  onClick={() => setSort('minted')}  label={SORT_LABELS.minted.tab} />
        </div>

        {!board && loadingBoard ? (
          <div style={{ color: 'var(--dim)' }}>loading {SORT_LABELS[sort].tab}...</div>
        ) : !board ? (
          <div style={{ color: 'var(--dim)' }}>(no data)</div>
        ) : board.entries.length === 0 ? (
          <div style={{ color: 'var(--dim)' }}>(no balances yet — start mining)</div>
        ) : (
          <LeaderboardTable
            sort={sort}
            entries={board.entries}
            generatedAt={board.generated_at}
            totalMintedBaseUnits={ledger.total_minted_base_units}
          />
        )}
      </Panel>
    </>
  );
}

function SortTab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        color: active ? 'var(--fg)' : 'var(--dim)',
        fontWeight: active ? 'bold' : 'normal',
      }}
    >
      [ {active ? '*' : ' '} {label} ]
    </button>
  );
}

function LeaderboardTable({
  sort, entries, generatedAt, totalMintedBaseUnits,
}: {
  sort: LeaderboardSort;
  entries: LeaderboardEntry[];
  generatedAt: string;
  totalMintedBaseUnits: string;
}) {
  const headerLabel = SORT_LABELS[sort].primary;
  return (
    <>
      <pre className="leaderboard-header">
{sort === 'balance'
  ? `  RANK   IDENTITY                                        ${headerLabel.padStart(14)} (RPOW)   MINED`
  : `  RANK   IDENTITY                                        ${headerLabel.padStart(14)} (RPOW)   BLOCKS`}
      </pre>
      <div className="leaderboard-grid">
        {entries.map((e) => {
          const label = e.display_name ?? shortPubkey(e.pubkey);
          const primary = sort === 'balance'
            ? formatRpowPadded(e.spendable_base_units, 14)
            : formatRpowPadded(e.minted_base_units, 14);
          // % of all coins ever minted that were earned by this account.
          // Same metric for both sort views — it describes the user, not
          // the sort key — but appended to the secondary cell either way.
          const sharePct = formatShareOfTotal(e.minted_base_units, totalMintedBaseUnits);
          const secondary = sort === 'balance'
            ? `(mined ${formatNumber(e.blocks_mined)} blk · ${sharePct})`
            : `${formatNumber(e.blocks_mined)} blocks · ${sharePct}`;
          return (
            <RowFragment
              key={e.pubkey}
              rank={formatRank(e.rank, 5)}
              label={label}
              pubkey={e.pubkey}
              primary={primary}
              secondary={secondary}
            />
          );
        })}
      </div>
      <div style={{ marginTop: 12, color: 'var(--dim)', fontSize: 12 }}>
        snapshot: {generatedAt.replace('T', ' ').slice(0, 19)} UTC
        {' · '}refreshes every 30s
      </div>
    </>
  );
}

function RowFragment({
  rank, label, pubkey, primary, secondary,
}: {
  rank: string;
  label: string;
  pubkey: string;
  primary: string;
  secondary: string;
}) {
  return (
    <>
      <span className="lb-rank">{rank}</span>
      <span className="lb-identity" title={pubkey}>
        <code>{label}</code>{' '}
        <CopyButton text={pubkey} label="copy" />
      </span>
      <span className="lb-primary">{primary}</span>
      <span className="lb-secondary">{secondary}</span>
    </>
  );
}
