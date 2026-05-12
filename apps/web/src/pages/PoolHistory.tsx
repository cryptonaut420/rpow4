import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PoolRoundsResponse, PoolRoundEntry } from '@rpow/shared';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import { useAsset } from '../assets/AssetProvider.js';
import { usePageMeta } from '../hooks/usePageMeta.js';
import { formatRpow, formatCount } from '../lib/format.js';

const PAGE_SIZE = 50;

function formatFullTs(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatDurationSec(startIso: string, endIso: string): string {
  const ms = Math.max(0, Date.parse(endIso) - Date.parse(startIso));
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m${rem.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
}

/**
 * Full pool-round history page. Backs the "view all" link surfaced on
 * the Stats panel and the docked Mining Bar's POOL ROUND HISTORY block.
 *
 * Pagination is cursor-based on `pool_rounds.id` (BIGSERIAL DESC) so
 * "load more" is consistent across snapshots even as new rounds close
 * during the user's session.
 */
export function PoolHistoryPage() {
  const { selectedSlug, selectedAsset } = useAsset();
  const assetCode = selectedAsset?.display_code ?? 'RPOW';
  usePageMeta(
    `${assetCode} pool history`,
    `Full history of ${assetCode} mining pool rounds — winners, payouts, participants, and your own share.`,
  );

  const [rounds, setRounds] = useState<PoolRoundEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const loadFirst = useCallback(() => {
    setLoading(true);
    setError('');
    api.poolRounds(undefined, PAGE_SIZE, selectedSlug)
      .then((r: PoolRoundsResponse) => {
        setRounds(r.rounds);
        setNextCursor(r.next_cursor);
      })
      .catch((e: { message?: string }) => setError(e?.message ?? 'failed to load pool rounds'))
      .finally(() => setLoading(false));
  }, [selectedSlug]);

  useEffect(() => { loadFirst(); }, [loadFirst]);

  const loadMore = () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    api.poolRounds(nextCursor, PAGE_SIZE, selectedSlug)
      .then((r: PoolRoundsResponse) => {
        setRounds((prev) => [...prev, ...r.rounds]);
        setNextCursor(r.next_cursor);
      })
      .catch((e: { message?: string }) => setError(e?.message ?? 'failed to load more'))
      .finally(() => setLoadingMore(false));
  };

  return (
    <Panel title={`${assetCode} POOL ROUND HISTORY`}>
      <div style={{ marginBottom: 12, color: 'var(--dim)', fontSize: 12, lineHeight: 1.6 }}>
        Every closed pool round, newest first. The <strong style={{ color: 'var(--fg)' }}>finder</strong>{' '}
        of each round receives the flat 25% bonus on top of their own pro-rata
        share; every participant earns from the 75% pro-rata pool in proportion
        to the shares they submitted.{' '}
        <Link to="/stats">[ back to stats ]</Link>
      </div>

      {loading ? (
        <div style={{ color: 'var(--dim)' }}>loading rounds...</div>
      ) : error ? (
        <div className="error">{error}</div>
      ) : rounds.length === 0 ? (
        <div style={{ color: 'var(--dim)' }}>(no rounds yet — start mining)</div>
      ) : (
        <>
          <div className="pool-rounds-list">
            {rounds.map((r) => <PoolHistoryRow key={r.round_id} entry={r} assetCode={assetCode} />)}
          </div>
          {nextCursor && (
            <div style={{ marginTop: 12 }}>
              <button onClick={loadMore} disabled={loadingMore} style={{ fontSize: 12 }}>
                [ {loadingMore ? 'loading...' : 'load more'} ]
              </button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function PoolHistoryRow({ entry, assetCode }: { entry: PoolRoundEntry; assetCode: string }) {
  const finderLabel = entry.finder_display_name
    ? `@${entry.finder_display_name}`
    : `${entry.finder_pubkey.slice(0, 6)}…${entry.finder_pubkey.slice(-4)}`;
  const duration = formatDurationSec(entry.started_at, entry.ended_at);

  return (
    <div className="pool-rounds-row">
      <span className="pool-rounds-time">{formatFullTs(entry.ended_at)}</span>
      <span className="pool-rounds-id">#{entry.round_id}</span>
      <span className="pool-rounds-reward">{formatRpow(entry.reward_base_units)} {assetCode}</span>
      <span className="pool-rounds-meta">
        {entry.participant_count} miner{entry.participant_count === 1 ? '' : 's'} ·{' '}
        {formatCount(entry.total_shares)} share{entry.total_shares === '1' ? '' : 's'} · {duration} · won by{' '}
        <Link
          to={`/explorer/account/${entry.finder_pubkey}`}
          title={entry.finder_pubkey}
          className="pool-rounds-finder"
        >
          <code>{finderLabel}</code>
        </Link>
        {' '}(+{formatRpow(entry.finder_payout_base_units)} {assetCode})
        {entry.block_event_id ? (
          <>
            {' · '}
            <Link to={`/explorer/tx/${entry.block_event_id}`}>[ block tx ]</Link>
          </>
        ) : null}
        {entry.your_payout_base_units ? (
          <span style={{ color: 'var(--accent)' }}>
            {' · '}you +{formatRpow(entry.your_payout_base_units)} {assetCode}
          </span>
        ) : null}
      </span>
    </div>
  );
}
