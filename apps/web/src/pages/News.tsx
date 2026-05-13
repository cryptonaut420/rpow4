import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { NewsPost, NewsPostKind } from '@rpow/shared';
import { api } from '../api.js';
import { Panel } from '../components/Panel.js';
import { usePageMeta } from '../hooks/usePageMeta.js';
import { useMe } from '../hooks/useMe.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { shortPubkey } from '@rpow/shared';
import { DEFAULT_ASSET_SLUG } from '../assets/AssetProvider.js';

const KIND_LABEL: Record<NewsPostKind, string> = {
  announcement: 'announcement',
  changelog: 'changelog',
  update: 'update',
};

function formatDate(iso?: string): string {
  if (!iso) return 'draft';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) out.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${match.index}-${token}`;
    if (token.startsWith('`')) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link?.[2] ?? '#';
      const safeHref = /^https?:\/\//i.test(href) ? href : '#';
      out.push(
        <a key={key} href={safeHref} target="_blank" rel="noopener noreferrer">
          {link?.[1] ?? token}
        </a>,
      );
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    const nodes: ReactNode[] = [];
    let paragraph: string[] = [];
    let list: string[] = [];

    function flushParagraph() {
      if (!paragraph.length) return;
      nodes.push(<p key={`p-${nodes.length}`}>{renderInline(paragraph.join(' '))}</p>);
      paragraph = [];
    }

    function flushList() {
      if (!list.length) return;
      nodes.push(
        <ul key={`ul-${nodes.length}`}>
          {list.map((item, i) => <li key={i}>{renderInline(item)}</li>)}
        </ul>,
      );
      list = [];
    }

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const level = heading[1]!.length;
        const content = renderInline(heading[2]!);
        nodes.push(level === 1
          ? <h2 key={`h-${nodes.length}`}>{content}</h2>
          : <h3 key={`h-${nodes.length}`}>{content}</h3>);
        continue;
      }
      const bullet = line.match(/^[-*]\s+(.+)$/);
      if (bullet) {
        flushParagraph();
        list.push(bullet[1]!);
        continue;
      }
      flushList();
      paragraph.push(line.trim());
    }
    flushParagraph();
    flushList();
    return nodes;
  }, [source]);

  return <div className="news-markdown">{blocks}</div>;
}

function KindBadge({ kind }: { kind: NewsPostKind }) {
  return <span className={`news-kind-badge news-kind-badge--${kind}`}>{KIND_LABEL[kind]}</span>;
}

function NewsCard({ post, selected }: { post: NewsPost; selected?: boolean }) {
  const author = post.author_display_name ?? shortPubkey(post.author_pubkey);
  const date = new Date(post.published_at ?? post.created_at ?? '');
  const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <article className={`news-card ${selected ? 'selected' : ''}`.trim()}>
      <div className="news-card-header">
        <KindBadge kind={post.kind} />
        <span className="news-card-date">{dateStr}</span>
      </div>
      <h3><Link to={`/news/${post.slug}`}>{post.title}</Link></h3>
      {post.summary ? <p className="news-card-summary">{post.summary}</p> : null}
      <div className="news-card-author">by {author}</div>
    </article>
  );
}

function AdminComposer({ onCreated }: { onCreated: (post: NewsPost) => void }) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<NewsPostKind>('update');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('## What changed\n\n- \n\n## Notes\n\n');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setOk('');
    try {
      const res = await api.createNewsPost({
        title,
        kind,
        summary,
        body_markdown: body,
        published: true,
      });
      setTitle('');
      setSummary('');
      setBody('## What changed\n\n- \n\n## Notes\n\n');
      setOk(`published /news/${res.post.slug}`);
      onCreated(res.post);
    } catch (err: any) {
      setError(err?.message ?? 'failed to publish post');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel title="admin publisher">
      <form className="news-composer" onSubmit={submit}>
        <div className="form-grid">
          <label>
            title
            <input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={120} />
          </label>
          <label>
            kind
            <select value={kind} onChange={(e) => setKind(e.target.value as NewsPostKind)}>
              <option value="update">update</option>
              <option value="announcement">announcement</option>
              <option value="changelog">changelog</option>
            </select>
          </label>
        </div>
        <label>
          summary
          <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={280} placeholder="short preview text" />
        </label>
        <label>
          markdown
          <textarea value={body} onChange={(e) => setBody(e.target.value)} required minLength={1} maxLength={12000} />
        </label>
        <div className="news-preview">
          <div className="dim">preview</div>
          <Markdown source={body} />
        </div>
        {error ? <div className="error">{error}</div> : null}
        {ok ? <div className="success">{ok}</div> : null}
        <button type="submit" disabled={saving || !title.trim() || !body.trim()}>
          {saving ? '[ publishing... ]' : '[ publish update ]'}
        </button>
      </form>
    </Panel>
  );
}

export function NewsPage() {
  const { slug } = useParams();
  const wallet = useWallet();
  // News is a global page (not asset-scoped), but `useMe` needs *some* asset
  // context to fetch the session view. Pin it to the default RPOW4.0 slug so
  // the admin gate keeps working regardless of which instance the user was
  // most recently viewing.
  const { me } = useMe(DEFAULT_ASSET_SLUG);
  const [posts, setPosts] = useState<NewsPost[]>([]);
  const [selected, setSelected] = useState<NewsPost | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  usePageMeta('RPOW4 News', 'Changelogs, updates, and announcements from the RPOW4 project.');

  useEffect(() => {
    setLoading(true);
    setError('');
    api.news(50)
      .then((r) => setPosts(r.posts))
      .catch((e: any) => setError(e?.message ?? 'failed to load news'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!slug) {
      setSelected(null);
      return;
    }
    api.newsPost(slug)
      .then((r) => setSelected(r.post))
      .catch((e: any) => setError(e?.message ?? 'failed to load post'));
  }, [slug]);

  const featured = selected ?? posts[0] ?? null;
  const isAdmin = wallet.status === 'unlocked' && me?.is_admin;

  return (
    <div className="news-page">
      {error ? <Panel title="error"><div className="error">{error}</div></Panel> : null}
      {loading && posts.length === 0 ? (
        <Panel title="news / changelog">
          <div className="dim">fetching the latest entries…</div>
        </Panel>
      ) : null}

      {!loading && !featured ? (
        <Panel title="news / changelog">
          <p className="dim" style={{ marginTop: 0 }}>
            Nothing has been published here yet. Check back soon — changelogs, releases, and project notes
            will land on this page.
          </p>
          {isAdmin ? (
            <p className="dim" style={{ marginBottom: 0 }}>
              You're an admin — scroll down to draft the first post.
            </p>
          ) : null}
        </Panel>
      ) : null}

      {featured ? (
        <div className="news-layout">
          <Panel title="news / changelog">
            <article className="news-post">
              <div className="news-post-header">
                <KindBadge kind={featured.kind} />
                <h2 className="news-post-title">{featured.title}</h2>
                <div className="news-post-meta">
                  <span>{formatDate(featured.published_at ?? featured.created_at)}</span>
                  <span className="news-meta-sep">·</span>
                  <span>by {featured.author_display_name ?? shortPubkey(featured.author_pubkey)}</span>
                </div>
              </div>
              {featured.summary ? <p className="news-summary">{featured.summary}</p> : null}
              <Markdown source={featured.body_markdown} />
            </article>
          </Panel>
          <aside className="news-sidebar">
            <Panel title={`archive (${posts.length})`}>
              <div className="news-list">
                {posts.map((post) => (
                  <NewsCard key={post.id} post={post} selected={post.slug === featured.slug} />
                ))}
              </div>
            </Panel>
          </aside>
        </div>
      ) : null}

      {isAdmin ? <AdminComposer onCreated={(post) => setPosts((current) => [post, ...current])} /> : null}
    </div>
  );
}
