import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { CopyButton } from '../components/CopyButton.js';
import { api } from '../api.js';
import { useWallet } from '../wallet/WalletProvider.js';
import type { ActivityEntry, ActivityResponse } from '@rpow/shared';
import { shortPubkey } from '@rpow/shared';
import { formatRpow } from '../lib/format.js';

/** Format an ISO timestamp as a short human-readable relative time or date. */
function formatTs(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const diff = now - date.getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const PAGE_SIZE = 50;

type Filter = 'all' | 'mint' | 'send' | 'receive';

const FILTER_LABEL: Record<Filter, string> = {
  all: 'all',
  mint: 'mints',
  send: 'sends',
  receive: 'receives',
};

export function ActivityPage() {
  const wallet = useWallet();
  const [items, setItems] = useState<ActivityEntry[]>([]);
  const [balance, setBalance] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const loadedOnce = useRef(false);

  const loadFirst = useCallback(() => {
    if (wallet.status !== 'unlocked') { setLoading(false); return; }
    setLoading(true);
    setError('');
    const apiFilter = filter === 'all' ? undefined : filter;
    api.activity(undefined, PAGE_SIZE, apiFilter)
      .then((r: ActivityResponse) => {
        setItems(r.items);
        setBalance(r.balance_base_units);
        setTotalCount(r.total_count);
        setNextCursor(r.next_cursor);
        loadedOnce.current = true;
      })
      .catch((e: any) => setError(e?.message ?? 'failed to load activity'))
      .finally(() => setLoading(false));
  }, [wallet.status, filter]);

  useEffect(() => { loadFirst(); }, [loadFirst]);

  const loadMore = () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const apiFilter = filter === 'all' ? undefined : filter;
    api.activity(nextCursor, PAGE_SIZE, apiFilter)
      .then((r: ActivityResponse) => {
        setItems((prev) => [...prev, ...r.items]);
        setNextCursor(r.next_cursor);
      })
      .catch((e: any) => setError(e?.message ?? 'failed to load more'))
      .finally(() => setLoadingMore(false));
  };

  if (wallet.status === 'loading') return <Panel title="ACTIVITY"><div>loading...</div></Panel>;

  if (wallet.status !== 'unlocked') {
    return (
      <Panel title="ACTIVITY">
        <div>not signed in.</div>
        <div style={{ marginTop: 8 }}>
          <Link to="/login">[ {wallet.status === 'locked' ? 'unlock wallet' : 'create or import wallet'} ]</Link>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="ACTIVITY">
      {/* Balance + count header */}
      {balance !== null && (
        <div style={{ display: 'flex', gap: 24, marginBottom: 12, flexWrap: 'wrap' }}>
          <span>
            <span style={{ color: 'var(--dim)', fontSize: 12 }}>BALANCE  </span>
            <strong>{formatRpow(balance)} RPOW</strong>
          </span>
          {totalCount !== null && (
            <span style={{ color: 'var(--dim)', fontSize: 12 }}>
              {totalCount} transaction{totalCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {(['all', 'mint', 'send', 'receive'] as Filter[]).map((f) => (
          <FilterTab
            key={f}
            active={filter === f}
            onClick={() => setFilter(f)}
            label={FILTER_LABEL[f]}
          />
        ))}
      </div>

      {error ? (
        <div className="error">{error}</div>
      ) : loading ? (
        <div>loading...</div>
      ) : items.length === 0 ? (
        <div style={{ color: 'var(--dim)' }}>
          {filter === 'all'
            ? '(no activity yet — try mining or sending)'
            : `(no ${FILTER_LABEL[filter]} yet)`}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {items.map((e, idx) => (
              <ActivityRow key={e.id ?? `${e.event_seq}-${idx}`} entry={e} />
            ))}
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

function FilterTab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
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

function ActivityRow({ entry: e }: { entry: ActivityEntry }) {
  const tag = e.type.toUpperCase();
  const sign = e.type === 'send' ? '-' : '+';
  const amt = `${sign}${formatRpow(e.amount_base_units)}`;
  const tagColor =
    e.type === 'send' ? 'var(--dim)' :
    e.type === 'receive' ? 'var(--accent)' : 'var(--fg)';

  return (
    <div style={{
      borderBottom: '1px solid var(--dim)',
      paddingBottom: 6,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    }}>
      {/* Row 1: timestamp · type · amount */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--dim)', fontSize: 11 }}>{formatTs(e.at)}</span>
        <span style={{ color: tagColor, fontWeight: 'bold' }}>{tag}</span>
        <span style={{ fontWeight: 'bold' }}>{amt} RPOW</span>
        {e.fee_base_units && e.fee_base_units !== '0' && (
          <span style={{ color: 'var(--dim)', fontSize: 11 }}>
            fee: {formatRpow(e.fee_base_units)} RPOW
          </span>
        )}
      </div>

      {/* Row 2: counterparty */}
      {e.counterparty_pubkey && (
        <div style={{ color: 'var(--dim)', fontSize: 12 }}>
          {e.type === 'send' ? 'to' : 'from'}{': '}
          <Link
            to={`/explorer/account/${e.counterparty_pubkey}`}
            title={e.counterparty_pubkey}
          >
            <code>{e.counterparty_display_name ?? shortPubkey(e.counterparty_pubkey)}</code>
          </Link>
          {' '}<CopyButton text={e.counterparty_pubkey} label="copy" />
        </div>
      )}

      {/* Row 3: memo */}
      {e.memo && (
        <div style={{ color: 'var(--fg)', fontSize: 12 }}>
          memo: <em>{e.memo}</em>
        </div>
      )}

      {/* Row 4: tx ID */}
      {e.id && (
        <div style={{ color: 'var(--dim)', fontSize: 11 }}>
          tx:{' '}
          <Link to={`/explorer/tx/${e.id}`} title={e.id}>
            <code>{e.id.slice(0, 8)}…</code>
          </Link>
          {' '}<CopyButton text={e.id} label="copy" />
        </div>
      )}
    </div>
  );
}
