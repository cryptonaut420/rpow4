import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { CopyButton } from '../components/CopyButton.js';
import { api } from '../api.js';
import { usePageMeta } from '../hooks/usePageMeta.js';
import { useMe } from '../hooks/useMe.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { renderMessageBody } from '../lib/render-message.js';
import { formatRpow } from '../lib/format.js';
import { shortPubkey, TROLLBOX_BODY_MAX } from '@rpow/shared';
import type { TrollboxFeedResponse, TrollboxMessage } from '@rpow/shared';

const PAGE_SIZE = 50;
const POLL_INTERVAL_MS = 15_000;

/** Format an ISO timestamp as a short relative-time string. */
function formatTs(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function TrollboxPage() {
  usePageMeta('Trollbox', 'Real-time public chat for RPOW4 users.');
  const wallet = useWallet();
  const { me, refresh: refreshMe } = useMe();

  const [messages, setMessages] = useState<TrollboxMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [feedMeta, setFeedMeta] = useState<{
    post_fee_base_units: string;
    body_max: number;
    total_count: string;
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [feedError, setFeedError] = useState('');

  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');
  const [postOk, setPostOk] = useState(false);

  // Initial load + light polling so new posts surface without a refresh.
  // We only refresh the *first* page; older pages don't change.
  const refreshFirstPage = useCallback(async () => {
    try {
      const r = await api.trollbox(undefined, PAGE_SIZE);
      setMessages(r.messages);
      setNextCursor(r.next_cursor);
      setFeedMeta({
        post_fee_base_units: r.post_fee_base_units,
        body_max: r.body_max,
        total_count: r.total_count,
      });
      setFeedError('');
    } catch (e: unknown) {
      setFeedError(e instanceof Error ? e.message : 'failed to load trollbox');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshFirstPage();
    const t = setInterval(() => { void refreshFirstPage(); }, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [refreshFirstPage]);

  // Infinite-scroll: when the sentinel scrolls into view, fetch the next
  // (older) page. Falls back to the explicit "[ load more ]" button below
  // for environments without IntersectionObserver.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !nextCursor || loadingMore) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      if (visible) void loadMore();
    }, { rootMargin: '200px' });
    obs.observe(node);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextCursor, loadingMore]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api.trollbox(nextCursor, PAGE_SIZE);
      setMessages((prev) => [...prev, ...r.messages]);
      setNextCursor(r.next_cursor);
    } catch (e: unknown) {
      setFeedError(e instanceof Error ? e.message : 'failed to load more');
    } finally {
      setLoadingMore(false);
    }
  };

  // Composer derived state.
  const fee = feedMeta ? BigInt(feedMeta.post_fee_base_units) : 0n;
  const trimmed = draft.trim();
  const tooLong = trimmed.length > TROLLBOX_BODY_MAX;
  const balance = me ? BigInt(me.balance_base_units) : 0n;
  const canAfford = balance >= fee;
  const signedIn = wallet.status === 'unlocked' && !!me;
  const canPost = signedIn && trimmed.length > 0 && !tooLong && canAfford && !posting;

  async function handlePost() {
    if (!canPost) return;
    setPosting(true);
    setPostError('');
    setPostOk(false);
    const idem = crypto.randomUUID();
    const sigBody = { body: trimmed, idempotency_key: idem };
    try {
      await api.trollboxPost({
        ...sigBody,
        client_signature_base58: wallet.sign('trollbox.post', sigBody),
      });
      setDraft('');
      setPostOk(true);
      await Promise.all([refreshFirstPage(), refreshMe()]);
    } catch (err: unknown) {
      const e = err as { error?: string; message?: string };
      const code = e?.error ?? 'INTERNAL';
      const map: Record<string, string> = {
        INSUFFICIENT_BALANCE: `not enough balance — ${formatRpow(fee)} RPOW required for the post fee`,
        BAD_REQUEST: e?.message ?? 'bad request',
        INVALID_SIGNATURE: 'wallet signature did not verify (try unlocking again)',
        UNAUTHORIZED: 'session expired — sign in again',
      };
      setPostError(map[code] ?? `${code}${e?.message ? `: ${e.message}` : ''}`);
    } finally {
      setPosting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  return (
    <>
      <Panel title="TROLLBOX">
        <div style={{ color: 'var(--dim)', fontSize: 12, marginBottom: 12 }}>
          Public message board. Each post burns{' '}
          <strong style={{ color: 'var(--fg)' }}>
            {feedMeta ? formatRpow(feedMeta.post_fee_base_units) : '…'} RPOW
          </strong>{' '}
          to the treasury.
          {feedMeta && (
            <>
              {' '}<span>· {Number(feedMeta.total_count).toLocaleString()} message{feedMeta.total_count === '1' ? '' : 's'} posted</span>
            </>
          )}
        </div>

        <Composer
          signedIn={signedIn}
          draft={draft}
          setDraft={setDraft}
          fee={fee}
          balance={balance}
          tooLong={tooLong}
          canPost={canPost}
          posting={posting}
          postError={postError}
          postOk={postOk}
          onPost={handlePost}
        />

        {feedError && <div className="error" style={{ marginTop: 12 }}>{feedError}</div>}

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {loading ? (
            <div>loading...</div>
          ) : messages.length === 0 ? (
            <div style={{ color: 'var(--dim)' }}>(no messages yet — be the first to post)</div>
          ) : (
            messages.map((m) => <TrollboxRow key={m.id} message={m} />)
          )}
        </div>

        {nextCursor && (
          <>
            <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
            <div style={{ marginTop: 12 }}>
              <button onClick={loadMore} disabled={loadingMore} style={{ fontSize: 12 }}>
                [ {loadingMore ? 'loading...' : 'load more'} ]
              </button>
            </div>
          </>
        )}
      </Panel>

      <Panel title="A BRIEF HISTORY OF THE TROLLBOX">
        <div style={{ color: 'var(--dim)', fontSize: 12, lineHeight: 1.6 }}>
          <p style={{ marginTop: 0 }}>
            In the early 2010s, every crypto exchange of any consequence shipped a chat
            sidebar pinned to the trading screen. The Mt. Gox trollbox, the BTC-e shoutbox,
            the Cryptsy chat — anonymous, lightly-moderated, and almost always more
            entertaining than the actual price action. They were where pump-and-dumps got
            organized, where the wash-traders heckled the bagholders, where rumors were
            born and corpses paraded.
          </p>
          <p>
            They were also genuinely useful. New shitcoin launches, exchange outages,
            developer drama, bridge exploits — the trollbox usually knew before the news
            sites did. Most were eventually gutted into oblivion by spam and abuse, the
            same fate that has claimed every public chat without economic friction.
          </p>
          <p style={{ marginBottom: 0 }}>
            This trollbox keeps the spirit and pays for the friction directly: every post
            burns a fixed fee to the treasury. Same speech, with skin in the game. URLs
            auto-link, and you can sprinkle a little markdown — <code>**bold**</code>,{' '}
            <code>*italic*</code>, and <code>`code`</code> — but not much more than that.
          </p>
        </div>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

interface ComposerProps {
  signedIn: boolean;
  draft: string;
  setDraft: (s: string) => void;
  fee: bigint;
  balance: bigint;
  tooLong: boolean;
  canPost: boolean;
  posting: boolean;
  postError: string;
  postOk: boolean;
  onPost: () => void;
}

function Composer(p: ComposerProps) {
  if (!p.signedIn) {
    return (
      <div
        style={{
          border: '1px dashed var(--dim)',
          padding: 10,
          color: 'var(--dim)',
          fontSize: 12,
        }}
      >
        sign in to post · <Link to="/login">[ login ]</Link>
      </div>
    );
  }

  const remaining = TROLLBOX_BODY_MAX - p.draft.trim().length;
  const balanceAfter = p.balance >= p.fee ? p.balance - p.fee : 0n;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <textarea
        value={p.draft}
        onChange={(e) => p.setDraft(e.target.value)}
        placeholder="say something to the network..."
        rows={3}
        maxLength={TROLLBOX_BODY_MAX * 2 /* let users type past the limit; we trim+block on submit */}
        style={{
          width: '100%',
          fontFamily: 'inherit',
          fontSize: 'inherit',
          background: 'transparent',
          color: 'var(--fg)',
          border: '1px solid var(--dim)',
          padding: 8,
          resize: 'vertical',
        }}
        onKeyDown={(e) => {
          // Cmd/Ctrl + Enter posts. Plain Enter inserts a newline so
          // multi-line posts (a memo, a paste) still work.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            if (p.canPost) p.onPost();
          }
        }}
      />
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
          fontSize: 12,
          color: 'var(--dim)',
        }}
      >
        <span style={{ color: remaining < 0 ? 'var(--err, #f00)' : 'var(--dim)' }}>
          {remaining}/{TROLLBOX_BODY_MAX}
        </span>
        <span>
          fee: <strong style={{ color: 'var(--fg)' }}>{formatRpow(p.fee)} RPOW</strong>
        </span>
        <span>
          balance after:{' '}
          <strong style={{ color: p.balance >= p.fee ? 'var(--fg)' : 'var(--err, #f00)' }}>
            {formatRpow(balanceAfter)} RPOW
          </strong>
        </span>
        <button
          onClick={p.onPost}
          disabled={!p.canPost}
          title={
            p.tooLong
              ? 'message is too long'
              : p.draft.trim().length === 0
              ? 'write something first'
              : p.balance < p.fee
              ? `need at least ${formatRpow(p.fee)} RPOW for the post fee`
              : 'post (cmd/ctrl + enter)'
          }
        >
          [ {p.posting ? 'posting...' : `post (${formatRpow(p.fee)} RPOW)`} ]
        </button>
      </div>
      {p.postError && <div className="error" style={{ fontSize: 12 }}>{p.postError}</div>}
      {p.postOk && (
        <div style={{ color: 'var(--accent, var(--fg))', fontSize: 12 }}>
          posted!
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function TrollboxRow({ message }: { message: TrollboxMessage }) {
  const rendered = useMemo(() => renderMessageBody(message.body), [message.body]);
  const authorLabel = message.author_display_name ?? shortPubkey(message.author_pubkey);

  return (
    <div
      style={{
        borderBottom: '1px solid var(--dim)',
        paddingBottom: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'baseline',
          flexWrap: 'wrap',
          fontSize: 12,
        }}
      >
        <Link
          to={`/explorer/account/${message.author_pubkey}`}
          title={message.author_pubkey}
          style={{ color: 'var(--fg)', fontWeight: 'bold' }}
        >
          <code>{authorLabel}</code>
        </Link>
        <CopyButton text={message.author_pubkey} label="copy" />
        <span style={{ color: 'var(--dim)' }}>{formatTs(message.posted_at)}</span>
      </div>
      <div style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
        {rendered}
      </div>
      <div style={{ color: 'var(--dim)', fontSize: 11 }}>
        <Link to={`/explorer/tx/${message.fee_event_id}`} title="view fee transfer in explorer">
          fee tx: <code>{message.fee_event_id.slice(0, 8)}…</code>
        </Link>
      </div>
    </div>
  );
}
