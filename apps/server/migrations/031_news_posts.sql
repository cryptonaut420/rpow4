-- 031_news_posts.sql
--
-- Public news / changelog posts plus an ops-controlled account admin flag.
-- Admins can publish Markdown updates from the web UI; everyone can read.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN accounts.is_admin IS
  'When true, the account can publish news/changelog posts through admin-only routes.';

CREATE TABLE IF NOT EXISTS news_posts (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,95}[a-z0-9]$'),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  summary TEXT NOT NULL DEFAULT '' CHECK (char_length(summary) <= 280),
  body_markdown TEXT NOT NULL CHECK (char_length(body_markdown) BETWEEN 1 AND 12000),
  kind TEXT NOT NULL CHECK (kind IN ('announcement', 'changelog', 'update')),
  author_pubkey TEXT NOT NULL REFERENCES accounts(pubkey),
  published BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS news_posts_public_idx
  ON news_posts(published_at DESC, created_at DESC)
  WHERE published = TRUE;

CREATE INDEX IF NOT EXISTS news_posts_admin_idx
  ON news_posts(created_at DESC);
