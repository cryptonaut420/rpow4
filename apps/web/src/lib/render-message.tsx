import { Fragment, type ReactNode } from 'react';

/**
 * Render a free-text message body into safe React nodes.
 *
 * Supports:
 *   - Auto-linkified http/https URLs (open in a new tab, no referrer)
 *   - **bold**, *italic*, `code`
 *
 * No HTML strings are produced; everything is structured React. There is
 * no `dangerouslySetInnerHTML` anywhere — strings flow through React's
 * text-escaping path, so user input cannot inject markup even if it
 * contains `<script>` or any other tag.
 */
export function renderMessageBody(body: string): ReactNode[] {
  // First pass: split by URLs. URLs are matched anywhere in the text;
  // markdown patterns are applied to the remaining plain segments.
  const URL_RE = /https?:\/\/[^\s<>"']+/g;
  const out: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  let m: RegExpExecArray | null;

  while ((m = URL_RE.exec(body)) !== null) {
    if (m.index > cursor) {
      out.push(...renderInline(body.slice(cursor, m.index), `t${key++}`));
    }
    let url = m[0];
    // Trailing punctuation is more likely sentence-level than URL-level.
    // Strip a small set of common closers so "see https://example.com." renders
    // cleanly. Repeat once to handle nested closers like ").".
    while (url.length > 0 && /[.,;:!?)\]]/.test(url[url.length - 1]!)) {
      url = url.slice(0, -1);
    }
    out.push(
      <a
        key={`u${key++}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
      >
        {url}
      </a>,
    );
    cursor = m.index + url.length;
  }
  if (cursor < body.length) {
    out.push(...renderInline(body.slice(cursor), `t${key++}`));
  }
  return out;
}

/**
 * Apply minimal markdown (`**bold**`, `*italic*`, `` `code` ``) to a
 * plain-text segment. Patterns are applied in order of delimiter
 * specificity so `**foo**` is treated as bold rather than two italic
 * stars. No nesting.
 */
function renderInline(text: string, baseKey: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let buf = '';
  let key = 0;

  const flush = () => {
    if (buf) {
      out.push(<Fragment key={`${baseKey}-x${key++}`}>{buf}</Fragment>);
      buf = '';
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);

    // Inline code wins over emphasis: `**foo**` inside backticks is literal.
    if (rest[0] === '`') {
      const end = rest.indexOf('`', 1);
      if (end > 1) {
        flush();
        out.push(
          <code key={`${baseKey}-c${key++}`}>{rest.slice(1, end)}</code>,
        );
        i += end + 1;
        continue;
      }
    }

    // Bold: **text**. Must be tested before italic so `*` at i and i+1
    // is consumed as a single bold delimiter.
    if (rest.startsWith('**')) {
      const end = rest.indexOf('**', 2);
      if (end > 2) {
        flush();
        out.push(
          <strong key={`${baseKey}-b${key++}`}>{rest.slice(2, end)}</strong>,
        );
        i += end + 2;
        continue;
      }
    }

    // Italic: *text*.
    if (rest[0] === '*') {
      const end = rest.indexOf('*', 1);
      if (end > 1) {
        flush();
        out.push(
          <em key={`${baseKey}-i${key++}`}>{rest.slice(1, end)}</em>,
        );
        i += end + 1;
        continue;
      }
    }

    buf += text[i]!;
    i += 1;
  }
  flush();
  return out;
}
