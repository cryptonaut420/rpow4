import { useState, useEffect, useCallback, useRef } from 'react';
import { useMatch, useNavigate, Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { CopyButton } from '../components/CopyButton.js';
import { api } from '../api.js';
import { usePageMeta } from '../hooks/usePageMeta.js';
import { shortPubkey } from '@rpow/shared';
import type {
  ExplorerEvent,
  ExplorerFeedResponse,
  ExplorerTxResponse,
  ExplorerAccountResponse,
  ExplorerAccountEvent,
} from '@rpow/shared';
import { formatRpow } from '../lib/format.js';

const PAGE_SIZE = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Ed25519 base58 pubkeys are 44 chars (or 32-byte base58)
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function formatTs(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
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

function formatFullTs(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ---- Search bar -------------------------------------------------------------

function SearchBar() {
  const navigate = useNavigate();
  const txMatch = useMatch('/explorer/tx/:id');
  const accountMatch = useMatch('/explorer/account/:pubkey');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  // Pre-fill search bar from current route
  useEffect(() => {
    if (txMatch?.params.id) {
      setQuery(txMatch.params.id);
    } else if (accountMatch?.params.pubkey) {
      setQuery(accountMatch.params.pubkey);
    }
  }, [txMatch?.params.id, accountMatch?.params.pubkey]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearchError('');

    if (UUID_RE.test(q)) {
      navigate(`/explorer/tx/${q}`);
      return;
    }

    if (PUBKEY_RE.test(q)) {
      navigate(`/explorer/account/${q}`);
      return;
    }

    // Try as handle
    setSearching(true);
    try {
      const res = await api.lookup(q);
      navigate(`/explorer/account/${res.pubkey}`);
    } catch (err: any) {
      const code = err?.error ?? '';
      if (code === 'NAME_NOT_FOUND') {
        setSearchError(`no account found for "${q}"`);
      } else {
        setSearchError(err?.message ?? 'search failed');
      }
    } finally {
      setSearching(false);
    }
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSearchError(''); }}
          placeholder="search by tx id, pubkey, or handle..."
          style={{ flex: 1, minWidth: 240 }}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" disabled={searching || !query.trim()}>
          [ {searching ? 'searching...' : 'search'} ]
        </button>
      </form>
      {searchError && (
        <div className="error" style={{ marginTop: 4, fontSize: 12 }}>{searchError}</div>
      )}
    </div>
  );
}

// ---- Network feed view ------------------------------------------------------

function ExplorerHistoryBlurb() {
  return (
    <div
      style={{
        border: '1px dashed var(--dim)',
        padding: '8px 10px',
        marginBottom: 14,
        color: 'var(--dim)',
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      <strong style={{ color: 'var(--fg)' }}>BLOCK EXPLORER ORIGINS:</strong>{' '}
      The earliest Bitcoin explorers appeared in 2010, when the chain was still
      small enough to feel like a strange public notebook. Sites like Block
      Explorer and later Blockchain.info turned raw node data into something
      humans could browse: blocks, transactions, addresses, balances, and the
      living pulse of a permissionless ledger. That pattern became part of
      cryptocurrency culture: if the ledger is public, the public should be able
      to inspect it.
    </div>
  );
}

function FeedView() {
  const [events, setEvents] = useState<ExplorerEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const loadFirst = useCallback(() => {
    setLoading(true);
    setError('');
    api.explorerFeed(undefined, PAGE_SIZE)
      .then((r: ExplorerFeedResponse) => {
        setEvents(r.events);
        setNextCursor(r.next_cursor);
      })
      .catch((e: any) => setError(e?.message ?? 'failed to load feed'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadFirst(); }, [loadFirst]);

  const loadMore = () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    api.explorerFeed(nextCursor, PAGE_SIZE)
      .then((r: ExplorerFeedResponse) => {
        setEvents((prev) => [...prev, ...r.events]);
        setNextCursor(r.next_cursor);
      })
      .catch((e: any) => setError(e?.message ?? 'failed to load more'))
      .finally(() => setLoadingMore(false));
  };

  if (loading) return <div style={{ color: 'var(--dim)' }}>loading feed...</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ color: 'var(--dim)', fontSize: 12 }}>RECENT NETWORK TRANSACTIONS</span>
        <button onClick={loadFirst} style={{ fontSize: 11 }}>[ refresh ]</button>
      </div>

      {events.length === 0 ? (
        <div style={{ color: 'var(--dim)' }}>(no transactions yet)</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {events.map((ev) => <FeedRow key={ev.event_seq} event={ev} />)}
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
    </>
  );
}

function FeedRow({ event: ev }: { event: ExplorerEvent }) {
  const navigate = useNavigate();
  const isMint = ev.type === 'mint';
  const typeColor = isMint ? 'var(--fg)' : 'var(--accent)';
  const actorLabel = ev.actor_display_name ?? shortPubkey(ev.actor_pubkey);
  const cpLabel = ev.counterparty_display_name ?? (ev.counterparty_pubkey ? shortPubkey(ev.counterparty_pubkey) : null);

  return (
    <div style={{
      borderBottom: '1px solid var(--dim)',
      paddingBottom: 5,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--dim)', fontSize: 11, minWidth: 56 }}>{formatTs(ev.at)}</span>
        <span style={{ color: typeColor, fontWeight: 'bold', minWidth: 52 }}>{ev.type.toUpperCase()}</span>
        <span style={{ fontWeight: 'bold' }}>
          {isMint ? '+' : ''}{formatRpow(ev.amount_base_units)} RPOW
        </span>
        {!isMint && ev.fee_base_units !== '0' && (
          <span style={{ color: 'var(--dim)', fontSize: 11 }}>
            fee: {formatRpow(ev.fee_base_units)} RPOW
          </span>
        )}
        <span style={{ color: 'var(--dim)', fontSize: 11 }}>#{ev.event_seq}</span>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12, color: 'var(--dim)' }}>
        <span>
          {isMint ? 'mined by' : 'from'}:{' '}
          <Link to={`/explorer/account/${ev.actor_pubkey}`} title={ev.actor_pubkey}>
            <code>{actorLabel}</code>
          </Link>
        </span>
        {cpLabel && ev.counterparty_pubkey && (
          <span>
            to:{' '}
            <Link to={`/explorer/account/${ev.counterparty_pubkey}`} title={ev.counterparty_pubkey}>
              <code>{cpLabel}</code>
            </Link>
          </span>
        )}
        {ev.memo && <span>memo: <em style={{ color: 'var(--fg)' }}>{ev.memo}</em></span>}
        <button
          onClick={() => navigate(`/explorer/tx/${ev.id}`)}
          style={{ fontSize: 11, padding: 0, background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', textDecoration: 'underline' }}
        >
          <code title={ev.id}>{ev.id.slice(0, 8)}…</code>
        </button>
      </div>
    </div>
  );
}

// ---- Transaction detail view ------------------------------------------------

function TxView({ id }: { id: string }) {
  const [tx, setTx] = useState<ExplorerTxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    setTx(null);
    api.explorerTx(id)
      .then(setTx)
      .catch((e: any) => setError(e?.message ?? 'transaction not found'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div style={{ color: 'var(--dim)' }}>loading transaction...</div>;
  if (error || !tx) return <div className="error">{error || 'transaction not found'}</div>;

  const isMint = tx.type === 'mint';
  const actorLabel = tx.actor_display_name ?? shortPubkey(tx.actor_pubkey);
  const cpLabel = tx.counterparty_display_name ?? (tx.counterparty_pubkey ? shortPubkey(tx.counterparty_pubkey) : null);

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <span style={{ color: 'var(--dim)', fontSize: 12 }}>
          <Link to="/explorer">← back to feed</Link>
        </span>
      </div>
      <pre style={{ margin: 0, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{[
        `TYPE:      ${tx.type.toUpperCase()}`,
        `BLOCK:     #${tx.event_seq}`,
        `TIME:      ${formatFullTs(tx.at)}`,
        ``,
        `AMOUNT:    ${isMint ? '+' : ''}${formatRpow(tx.amount_base_units)} RPOW`,
        ...(!isMint && tx.fee_base_units !== '0' ? [`FEE:       ${formatRpow(tx.fee_base_units)} RPOW`] : []),
        ...(tx.memo ? [`MEMO:      ${tx.memo}`] : []),
        ``,
        `FROM:      ${actorLabel}`,
        `           ${tx.actor_pubkey}`,
        ...(tx.counterparty_pubkey ? [
          `TO:        ${cpLabel ?? ''}`,
          `           ${tx.counterparty_pubkey}`,
        ] : []),
        ...(tx.challenge_id ? [`CHALLENGE: ${tx.challenge_id}`] : []),
        ...(tx.client_signature_base58 ? [
          `SIG:       ${tx.client_signature_base58.slice(0, 32)}`,
          `           ${tx.client_signature_base58.slice(32)}`,
        ] : []),
        ``,
        `TX ID:     ${tx.id}`,
      ].join('\n')}</pre>

      <div style={{ marginTop: 12, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
        <Link to={`/explorer/account/${tx.actor_pubkey}`}>
          [ view {tx.actor_display_name ? `@${tx.actor_display_name}` : 'sender'} account ]
        </Link>
        {tx.counterparty_pubkey && (
          <Link to={`/explorer/account/${tx.counterparty_pubkey}`}>
            [ view {tx.counterparty_display_name ? `@${tx.counterparty_display_name}` : 'recipient'} account ]
          </Link>
        )}
        <CopyButton text={tx.id} label="copy tx id" />
        <CopyButton text={tx.actor_pubkey} label="copy sender pubkey" />
      </div>
    </>
  );
}

// ---- Account view -----------------------------------------------------------

function AccountView({ pubkey }: { pubkey: string }) {
  const [account, setAccount] = useState<ExplorerAccountResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const loadedOnce = useRef(false);

  const loadFirst = useCallback(() => {
    setLoading(true);
    setError('');
    setAccount(null);
    loadedOnce.current = false;
    api.explorerAccount(pubkey, undefined, PAGE_SIZE)
      .then((r) => {
        setAccount(r);
        loadedOnce.current = true;
      })
      .catch((e: any) => setError(e?.message ?? 'account not found'))
      .finally(() => setLoading(false));
  }, [pubkey]);

  useEffect(() => { loadFirst(); }, [loadFirst]);

  const loadMore = () => {
    if (!account?.next_cursor || loadingMore) return;
    setLoadingMore(true);
    api.explorerAccount(pubkey, account.next_cursor, PAGE_SIZE)
      .then((r) => {
        setAccount((prev) => prev ? {
          ...prev,
          items: [...prev.items, ...r.items],
          next_cursor: r.next_cursor,
        } : r);
      })
      .catch((e: any) => setError(e?.message ?? 'failed to load more'))
      .finally(() => setLoadingMore(false));
  };

  if (loading) return <div style={{ color: 'var(--dim)' }}>loading account...</div>;
  if (error || !account) return <div className="error">{error || 'account not found'}</div>;

  const handle = account.display_name ? `@${account.display_name}` : null;

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <span style={{ color: 'var(--dim)', fontSize: 12 }}>
          <Link to="/explorer">← back to feed</Link>
        </span>
      </div>

      {/* Account summary */}
      <pre style={{ margin: '0 0 16px', lineHeight: 1.7 }}>{[
        handle ? `HANDLE:    ${handle}` : null,
        `PUBKEY:    ${pubkey}`,
        ``,
        `BALANCE:   ${formatRpow(account.spendable_base_units)} RPOW (spendable)`,
        `MINED:     ${formatRpow(account.minted_base_units)} RPOW  (${account.blocks_mined} block${account.blocks_mined === '1' ? '' : 's'})`,
        `SENT:      ${formatRpow(account.sent_base_units)} RPOW`,
        `RECEIVED:  ${formatRpow(account.received_base_units)} RPOW`,
        `TXS:       ${account.total_count}`,
      ].filter(Boolean).join('\n')}</pre>

      <CopyButton text={pubkey} label="copy pubkey" />

      {/* Transaction list */}
      <div style={{ marginTop: 16, marginBottom: 6, color: 'var(--dim)', fontSize: 12 }}>TRANSACTION HISTORY</div>

      {account.items.length === 0 ? (
        <div style={{ color: 'var(--dim)' }}>(no transactions)</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {account.items.map((e, idx) => (
              <AccountEventRow key={e.id ?? `${e.event_seq}-${idx}`} event={e} />
            ))}
          </div>
          {account.next_cursor && (
            <div style={{ marginTop: 12 }}>
              <button onClick={loadMore} disabled={loadingMore} style={{ fontSize: 12 }}>
                [ {loadingMore ? 'loading...' : 'load more'} ]
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function AccountEventRow({ event: e }: { event: ExplorerAccountEvent }) {
  const navigate = useNavigate();
  const isSend = e.type === 'send';
  const isMint = e.type === 'mint';
  const sign = isSend ? '-' : '+';
  const typeColor = isSend ? 'var(--dim)' : isMint ? 'var(--fg)' : 'var(--accent)';
  const cpLabel = e.counterparty_display_name ?? (e.counterparty_pubkey ? shortPubkey(e.counterparty_pubkey) : null);

  return (
    <div style={{
      borderBottom: '1px solid var(--dim)',
      paddingBottom: 5,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--dim)', fontSize: 11, minWidth: 56 }}>{formatTs(e.at)}</span>
        <span style={{ color: typeColor, fontWeight: 'bold', minWidth: 52 }}>{e.type.toUpperCase()}</span>
        <span style={{ fontWeight: 'bold' }}>{sign}{formatRpow(e.amount_base_units)} RPOW</span>
        {e.fee_base_units && e.fee_base_units !== '0' && (
          <span style={{ color: 'var(--dim)', fontSize: 11 }}>fee: {formatRpow(e.fee_base_units)} RPOW</span>
        )}
        <span style={{ color: 'var(--dim)', fontSize: 11 }}>#{e.event_seq}</span>
      </div>

      {cpLabel && e.counterparty_pubkey && (
        <div style={{ fontSize: 12, color: 'var(--dim)' }}>
          {isSend ? 'to' : 'from'}:{' '}
          <Link to={`/explorer/account/${e.counterparty_pubkey}`} title={e.counterparty_pubkey}>
            <code>{cpLabel}</code>
          </Link>
        </div>
      )}

      {e.memo && (
        <div style={{ fontSize: 12, color: 'var(--fg)' }}>memo: <em>{e.memo}</em></div>
      )}

      {e.id && (
        <div style={{ fontSize: 11, color: 'var(--dim)' }}>
          tx:{' '}
          <button
            onClick={() => navigate(`/explorer/tx/${e.id}`)}
            style={{ fontSize: 11, padding: 0, background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', textDecoration: 'underline' }}
          >
            <code title={e.id}>{e.id!.slice(0, 8)}…</code>
          </button>
          {' '}<CopyButton text={e.id} label="copy" />
        </div>
      )}
    </div>
  );
}

// ---- Main Explorer page -----------------------------------------------------

export function ExplorerPage() {
  usePageMeta('Explorer', 'Browse the RPOW4 public ledger. Search transactions by ID, look up accounts by public key, and explore the live feed.');
  const txMatch = useMatch('/explorer/tx/:id');
  const accountMatch = useMatch('/explorer/account/:pubkey');

  const txId = txMatch?.params.id;
  const accountPubkey = accountMatch?.params.pubkey;

  const title = txId
    ? `EXPLORER · TX`
    : accountPubkey
    ? `EXPLORER · ACCOUNT`
    : `EXPLORER`;

  return (
    <Panel title={title}>
      <SearchBar />
      {txId ? (
        <TxView id={txId} />
      ) : accountPubkey ? (
        <AccountView pubkey={accountPubkey} />
      ) : (
        <>
          <ExplorerHistoryBlurb />
          <FeedView />
        </>
      )}
    </Panel>
  );
}
