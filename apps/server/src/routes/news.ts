import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const KIND = ['announcement', 'changelog', 'update'] as const;

const CreateNewsBody = z.object({
  title: z.string().trim().min(3).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,95}[a-z0-9]$/).optional(),
  summary: z.string().trim().max(280).default(''),
  body_markdown: z.string().trim().min(1).max(12_000),
  kind: z.enum(KIND).default('update'),
  published: z.boolean().default(true),
});

interface NewsRow {
  id: string;
  slug: string;
  title: string;
  summary: string;
  body_markdown: string;
  kind: 'announcement' | 'changelog' | 'update';
  author_pubkey: string;
  author_display_name: string | null;
  published: boolean;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .replace(/-+$/g, '');
  return slug.length >= 3 ? slug : `news-${Date.now().toString(36)}`;
}

function wire(row: NewsRow) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body_markdown: row.body_markdown,
    kind: row.kind,
    author_pubkey: row.author_pubkey,
    author_display_name: row.author_display_name,
    published: row.published,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    published_at: row.published_at?.toISOString(),
  };
}

async function isAdmin(app: FastifyInstance, pubkey: string): Promise<boolean> {
  const { rows } = await app.pool.query<{ is_admin: boolean }>(
    `SELECT is_admin FROM accounts WHERE pubkey=$1`,
    [pubkey],
  );
  return rows[0]?.is_admin === true;
}

export async function newsRoutes(app: FastifyInstance) {
  app.get('/news', async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 25) || 25));
    const { rows } = await app.pool.query<NewsRow>(
      `SELECT p.id::text, p.slug, p.title, p.summary, p.body_markdown, p.kind,
              p.author_pubkey, a.display_name AS author_display_name,
              p.published, p.created_at, p.updated_at, p.published_at
       FROM news_posts p
       LEFT JOIN accounts a ON a.pubkey = p.author_pubkey
       WHERE p.published = TRUE
       ORDER BY p.published_at DESC NULLS LAST, p.created_at DESC
       LIMIT $1`,
      [limit],
    );
    return { posts: rows.map(wire) };
  });

  app.get('/news/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { rows } = await app.pool.query<NewsRow>(
      `SELECT p.id::text, p.slug, p.title, p.summary, p.body_markdown, p.kind,
              p.author_pubkey, a.display_name AS author_display_name,
              p.published, p.created_at, p.updated_at, p.published_at
       FROM news_posts p
       LEFT JOIN accounts a ON a.pubkey = p.author_pubkey
       WHERE p.slug=$1 AND p.published = TRUE
       LIMIT 1`,
      [slug],
    );
    const post = rows[0];
    if (!post) return reply.code(404).send({ error: 'NOT_FOUND', message: 'news post not found' });
    return { post: wire(post) };
  });

  app.post('/news', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    if (!(await isAdmin(app, s.pubkey))) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'admin required' });
    }

    const parsed = CreateNewsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    const input = parsed.data;
    const baseSlug = input.slug ?? slugify(input.title);
    const id = randomUUID();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
      const { rows } = await app.pool.query<NewsRow>(
        `INSERT INTO news_posts(
           id, slug, title, summary, body_markdown, kind, author_pubkey,
           published, published_at
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8 THEN now() ELSE NULL END)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id::text, slug, title, summary, body_markdown, kind,
                   author_pubkey, NULL::text AS author_display_name,
                   published, created_at, updated_at, published_at`,
        [id, slug, input.title, input.summary, input.body_markdown, input.kind, s.pubkey, input.published],
      );
      if (rows[0]) return reply.code(201).send({ ok: true, post: wire(rows[0]) });
    }

    return reply.code(409).send({ error: 'SLUG_TAKEN', message: 'could not derive a unique slug' });
  });
}
