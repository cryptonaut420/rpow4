import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { Panel } from '../components/Panel.js';
import { CopyButton } from '../components/CopyButton.js';
import { usePageMeta } from '../hooks/usePageMeta.js';

// In-page anchor link.
//
// The app uses HashRouter, which means a plain `href="#some-id"` is parsed as
// a route ("/some-id") and renders nothing. So intercept the click, scroll
// the target into view, and skip the router entirely. Keeping the underlying
// `<a href>` keeps the link copyable, accessible, and screenreader-friendly.
function TocLink({
  id,
  children,
  style,
}: {
  id: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <a
      href={`#${id}`}
      style={style}
      onClick={(e) => {
        e.preventDefault();
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }}
    >
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// API documentation page.
//
// Source-of-truth for the public REST surface. Mirrors docs/overview/06-api.md
// in the repo. Every endpoint section here was hand-verified against the
// route file under apps/server/src/routes/.
// ---------------------------------------------------------------------------

interface EndpointDoc {
  id: string;
  method: 'GET' | 'POST';
  path: string;
  auth: 'public' | 'session' | 'pow' | 'session + sig';
  summary: string;
  description: ReactNode;
  request?: { kind: 'body' | 'query'; example: string };
  response: string;
  errors?: { status: number; code: string; when: string }[];
  curl: string;
  js: string;
}

interface Section {
  id: string;
  title: string;
  intro?: ReactNode;
  endpoints: EndpointDoc[];
}

// ---------------------------------------------------------------------------
// Code block with a copy button. Long fixed-pitch text wrapped in a styled
// frame so it visually fits inside the terminal aesthetic.
// ---------------------------------------------------------------------------
function CodeBlock({ label, language, code }: { label: string; language: 'bash' | 'js' | 'json'; code: string }) {
  return (
    <div style={{ margin: '6px 0 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
        <span className="dim" style={{ fontSize: 12 }}>
          {label} <span style={{ opacity: 0.5 }}>· {language}</span>
        </span>
        <CopyButton text={code} />
      </div>
      <pre
        style={{
          margin: 0,
          padding: '10px 12px',
          background: 'var(--bg-2)',
          border: '1px solid var(--accent-dim)',
          borderRadius: 3,
          overflowX: 'auto',
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: 'pre',
        }}
      >
        {code}
      </pre>
    </div>
  );
}

function MethodBadge({ method, auth }: { method: 'GET' | 'POST'; auth: 'public' | 'session' | 'pow' | 'session + sig' }) {
  const authLabel = auth === 'public' ? 'public' : auth === 'session' ? 'session cookie' : auth === 'session + sig' ? 'session + sig' : 'pow + signature';
  const authColor =
    auth === 'public' ? 'var(--dim)' : auth === 'session' ? 'var(--accent)' : 'var(--accent)';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <span
        style={{
          fontWeight: 'bold',
          color: 'var(--accent)',
          border: '1px solid var(--accent-dim)',
          padding: '1px 8px',
          fontSize: 12,
          letterSpacing: '0.04em',
          borderRadius: 2,
        }}
      >
        {method}
      </span>
      <span
        style={{
          color: 'var(--dim)',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          border: `1px solid ${authColor === 'var(--accent)' ? 'var(--accent-dim)' : 'var(--dimmer)'}`,
          padding: '0 6px',
          borderRadius: 2,
        }}
        title={`auth: ${authLabel}`}
      >
        {authLabel}
      </span>
    </div>
  );
}

function ErrorTable({ rows }: { rows: { status: number; code: string; when: string }[] }) {
  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 13,
        margin: '4px 0 8px',
      }}
    >
      <thead>
        <tr style={{ color: 'var(--dim)', textAlign: 'left' }}>
          <th style={{ padding: '4px 8px 4px 0', fontWeight: 'normal', width: 60 }}>status</th>
          <th style={{ padding: '4px 8px', fontWeight: 'normal', width: 200 }}>code</th>
          <th style={{ padding: '4px 0', fontWeight: 'normal' }}>when</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.status}-${r.code}-${r.when}`} style={{ borderTop: '1px solid var(--dimmer)' }}>
            <td style={{ padding: '4px 8px 4px 0', verticalAlign: 'top' }}>
              <code>{r.status}</code>
            </td>
            <td style={{ padding: '4px 8px', verticalAlign: 'top' }}>
              <code>{r.code}</code>
            </td>
            <td style={{ padding: '4px 0', verticalAlign: 'top', color: 'var(--dim)' }}>{r.when}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EndpointBlock({ ep }: { ep: EndpointDoc }) {
  return (
    <div id={ep.id} style={{ margin: '20px 0 28px', scrollMarginTop: 24 }}>
      <h3 style={{ margin: '0 0 4px 0', fontSize: 15 }}>
        <TocLink id={ep.id} style={{ borderBottom: 'none', color: 'var(--fg)' }}>
          <code style={{ color: 'var(--accent)' }}>{ep.path}</code>
        </TocLink>
      </h3>
      <div style={{ marginBottom: 6 }}>
        <MethodBadge method={ep.method} auth={ep.auth} />
      </div>
      <div style={{ color: 'var(--fg)', marginBottom: 8 }}>{ep.summary}</div>
      <div style={{ color: 'var(--dim)', fontSize: 13, marginBottom: 10 }}>{ep.description}</div>

      {ep.request && (
        <CodeBlock
          label={ep.request.kind === 'body' ? 'request body' : 'query parameters'}
          language="json"
          code={ep.request.example}
        />
      )}

      <CodeBlock label="response (200)" language="json" code={ep.response} />

      {ep.errors && ep.errors.length > 0 && (
        <>
          <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>
            error responses
          </div>
          <ErrorTable rows={ep.errors} />
        </>
      )}

      <CodeBlock label="curl" language="bash" code={ep.curl} />
      <CodeBlock label="javascript" language="js" code={ep.js} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Endpoint definitions, ordered by user journey:
//   1. Conventions
//   2. Network (ledger / explorer / stats / faucet status)
//   3. Account creation (signup)
//   4. Sign-in (auth)
//   5. Wallet (me / display_name)
//   6. Mining (challenge → mint)
//   7. Sending (send / faucet/claim)
//   8. Activity (per-user feed)
// ---------------------------------------------------------------------------
function buildSections(apiBase: string): Section[] {
  const B = apiBase;

  return [
    {
      id: 'network',
      title: 'Network state',
      intro: (
        <p style={{ margin: '4px 0 0' }}>
          Read-only counters and the public event feed. No authentication.
          Heavily cached and ETag-aware — supply <code>If-None-Match</code> on
          repeat polls to get cheap <code>304</code> responses.
        </p>
      ),
      endpoints: [
        {
          id: 'health',
          method: 'GET',
          path: '/health',
          auth: 'public',
          summary: 'Basic liveness probe.',
          description: 'Returns immediately. /health/ready also pings the database.',
          response: `{ "ok": true }`,
          curl: `curl ${B}/health`,
          js: `await fetch('${B}/health').then(r => r.json())`,
        },
        {
          id: 'ledger',
          method: 'GET',
          path: '/ledger',
          auth: 'public',
          summary: 'Network counters: minted supply, block height, halving info, current difficulty and reward.',
          description: 'Computed from maintained counters — never scans the event log. Same payload as /ledger/stats. Cache TTL ~5s with stale-while-revalidate.',
          response: `{
  "total_minted_base_units": "104500000000",
  "total_transferred_base_units": "0",
  "circulating_supply_base_units": "104500000000",
  "max_supply_base_units": "21000000000000000",
  "base_units_per_rpow": "1000000000",
  "block_height": "11",
  "transfer_count": "0",
  "treasury_balance_base_units": "0",
  "current_fee_base_units": "10000000",
  "current_difficulty_bits": 22,
  "next_difficulty_bits": 22,
  "next_difficulty_at_block": "1024",
  "blocks_to_next_difficulty_step": "1013",
  "current_reward_base_units": "9500000000",
  "next_reward_base_units": "9500000000",
  "next_halving_at_block": "1048576",
  "blocks_to_next_halving": "1048565",
  "halving_index": 0,
  "is_capped": false,
  "user_count": 4
}`,
          curl: `curl ${B}/ledger`,
          js: `const ledger = await fetch('${B}/ledger').then(r => r.json());
console.log('block_height:', ledger.block_height);`,
        },
        {
          id: 'ledger-events',
          method: 'GET',
          path: '/ledger/events',
          auth: 'public',
          summary: 'Paginated public event log, newest first.',
          description: 'Cursor pagination. Pass the previous response\'s next_cursor as ?cursor= to read older events. Default limit 50, max 100.',
          request: {
            kind: 'query',
            example: `cursor: string  (opaque, from previous page; omit for first page)
limit:  number  (1..100, default 50)`,
          },
          response: `{
  "events": [
    {
      "id": "ad6c0c0e-d4c1-4f26-9e66-...",
      "type": "mint",
      "actor_pubkey": "9aXt...",
      "amount_base_units": "9500000000",
      "challenge_id": "8b7c...",
      "client_signature_base58": "5J7q...",
      "at": "2026-05-08T22:04:11.123Z"
    },
    {
      "id": "0a48c5b4-...",
      "type": "transfer",
      "actor_pubkey": "9aXt...",
      "counterparty_pubkey": "Bz7K...",
      "amount_base_units": "1000000000",
      "idempotency_key": "client-abc-...",
      "client_signature_base58": "3kNy...",
      "at": "2026-05-08T22:05:22.456Z"
    }
  ],
  "next_cursor": "eyJldmVudF9zZXEiOiI3In0"
}`,
          curl: `curl '${B}/ledger/events?limit=20'`,
          js: `let cursor;
do {
  const u = new URL('${B}/ledger/events');
  u.searchParams.set('limit', '50');
  if (cursor) u.searchParams.set('cursor', cursor);
  const page = await fetch(u).then(r => r.json());
  for (const e of page.events) console.log(e.event_seq, e.type, e.amount_base_units);
  cursor = page.next_cursor;
} while (cursor);`,
        },
        {
          id: 'explorer-feed',
          method: 'GET',
          path: '/explorer/feed',
          auth: 'public',
          summary: 'Like /ledger/events, plus actor and counterparty display names when set.',
          description: 'Best for building a public activity timeline UI. Same cursor scheme as /ledger/events. Optional `type`: `all` (default), `mint`, or `transfer` to restrict to mints or transfers only.',
          request: {
            kind: 'query',
            example: `cursor: string  (from previous page; optional)
limit:  number  (1..100, default 50)
type:   'all' | 'mint' | 'transfer'  (optional, default all)`,
          },
          response: `{
  "events": [
    {
      "event_seq": "12",
      "id": "ad6c0c0e-...",
      "type": "transfer",
      "actor_pubkey": "9aXt...",
      "actor_display_name": "alice",
      "counterparty_pubkey": "Bz7K...",
      "counterparty_display_name": "bob",
      "amount_base_units": "1000000000",
      "fee_base_units": "10000000",
      "memo": "lunch",
      "at": "2026-05-08T22:05:22.456Z"
    }
  ],
  "next_cursor": "11"
}`,
          curl: `curl '${B}/explorer/feed?limit=20&type=mint'`,
          js: `const feed = await fetch('${B}/explorer/feed?limit=50&type=transfer').then(r => r.json());`,
        },
        {
          id: 'explorer-tx',
          method: 'GET',
          path: '/explorer/tx/:id',
          auth: 'public',
          summary: 'Look up a single transaction by its UUID.',
          description: 'Once an event is recorded its content never changes. Cache headers are immutable for an hour.',
          response: `{
  "event_seq": "7",
  "id": "ad6c0c0e-d4c1-4f26-9e66-...",
  "type": "transfer",
  "actor_pubkey": "9aXt...",
  "actor_display_name": "alice",
  "counterparty_pubkey": "Bz7K...",
  "counterparty_display_name": "bob",
  "amount_base_units": "1000000000",
  "fee_base_units": "10000000",
  "memo": "lunch",
  "client_signature_base58": "3kNy...",
  "at": "2026-05-08T22:05:22.456Z"
}`,
          errors: [
            { status: 404, code: 'BAD_REQUEST', when: 'no transaction with that UUID, or the UUID is malformed' },
          ],
          curl: `curl ${B}/explorer/tx/ad6c0c0e-d4c1-4f26-9e66-...`,
          js: `const tx = await fetch(\`\${API}/explorer/tx/\${id}\`).then(r => r.json());`,
        },
        {
          id: 'explorer-account',
          method: 'GET',
          path: '/explorer/account/:pubkey',
          auth: 'public',
          summary: 'Public account view: balance, lifetime stats, and event history.',
          description: 'Use a pubkey (base58, 32 bytes) or first resolve a handle via /lookup/:name. Account history is paginated with the same cursor scheme as /ledger/events.',
          request: {
            kind: 'query',
            example: `cursor: string  (from previous page; optional)
limit:  number  (1..100, default 50)`,
          },
          response: `{
  "pubkey": "9aXt...",
  "display_name": "alice",
  "spendable_base_units": "8500000000",
  "minted_base_units": "9500000000",
  "sent_base_units": "1000000000",
  "received_base_units": "0",
  "blocks_mined": "1",
  "total_count": 2,
  "items": [
    { "type": "send", "event_seq": "12", "amount_base_units": "1000000000",
      "fee_base_units": "10000000", "memo": "lunch",
      "counterparty_pubkey": "Bz7K...", "counterparty_display_name": "bob",
      "at": "2026-05-08T22:05:22.456Z" },
    { "type": "mint", "event_seq": "11", "amount_base_units": "9500000000",
      "at": "2026-05-08T22:04:11.123Z" }
  ]
}`,
          errors: [
            { status: 404, code: 'BAD_REQUEST', when: 'no account with that pubkey' },
          ],
          curl: `curl ${B}/explorer/account/9aXt...`,
          js: `const acct = await fetch(\`\${API}/explorer/account/\${pubkey}\`).then(r => r.json());`,
        },
        {
          id: 'lookup',
          method: 'GET',
          path: '/lookup/:name',
          auth: 'public',
          summary: 'Resolve a display name (handle) to a pubkey.',
          description: 'Case-insensitive. Useful for sending: collect a handle, resolve, then sign /send with the resulting pubkey.',
          response: `{ "pubkey": "9aXt...", "display_name": "alice" }`,
          errors: [
            { status: 400, code: 'BAD_REQUEST', when: 'name is empty or longer than 64 characters' },
            { status: 404, code: 'NAME_NOT_FOUND', when: 'no account with that display name' },
          ],
          curl: `curl ${B}/lookup/alice`,
          js: `const r = await fetch(\`\${API}/lookup/\${encodeURIComponent(name)}\`);
if (r.status === 404) throw new Error('handle not found');
const { pubkey } = await r.json();`,
        },
        {
          id: 'stats-leaderboard',
          method: 'GET',
          path: '/stats/leaderboard',
          auth: 'public',
          summary: 'Top-100 accounts by balance or by lifetime minted.',
          description: 'Cached for 10s. Each variant is backed by a partial DESC index.',
          request: {
            kind: 'query',
            example: `sort: 'balance' | 'minted'   (default 'balance')`,
          },
          response: `{
  "sort": "balance",
  "limit": 100,
  "generated_at": "2026-05-08T22:05:22.456Z",
  "entries": [
    { "rank": 1, "pubkey": "9aXt...", "display_name": "alice",
      "spendable_base_units": "8500000000",
      "minted_base_units": "9500000000",
      "sent_base_units": "1000000000",
      "received_base_units": "0",
      "blocks_mined": "1" }
  ]
}`,
          curl: `curl '${B}/stats/leaderboard?sort=minted'`,
          js: `const lb = await fetch('${B}/stats/leaderboard?sort=minted').then(r => r.json());`,
        },
        {
          id: 'faucet-status',
          method: 'GET',
          path: '/faucet',
          auth: 'public',
          summary: 'Faucet config + your eligibility (when signed in).',
          description: 'Anonymous callers see global config plus their IP cooldown. Signed-in callers also see their per-pubkey cooldown and whether they can claim right now.',
          response: `{
  "enabled": true,
  "eligible": true,
  "claim_amount_base_units": "100000000",
  "cooldown_hours": 24,
  "cooldown_seconds": 86400,
  "treasury_balance_base_units": "100000000000",
  "treasury_pubkey": "11111111111111111111111111111111"
}`,
          curl: `curl ${B}/faucet`,
          js: `const f = await fetch('${B}/faucet', { credentials: 'include' }).then(r => r.json());`,
        },
        {
          id: 'pubkey-pem',
          method: 'GET',
          path: '/.well-known/rpow-pubkey.pem',
          auth: 'public',
          summary: 'The server\'s Ed25519 signing public key, in PEM form.',
          description: 'Use this to verify server_sig on tokens minted by this instance. Tokens issued at /mint include a signature over { id, owner_pubkey, value, issued_at } produced by the server\'s private key.',
          response: `(text/plain — PEM-encoded SubjectPublicKeyInfo)`,
          curl: `curl ${B}/.well-known/rpow-pubkey.pem`,
          js: `const pem = await fetch('${B}/.well-known/rpow-pubkey.pem').then(r => r.text());`,
        },
      ],
    },

    {
      id: 'signup',
      title: 'Account creation (PoW + signature)',
      intro: (
        <>
          <p style={{ margin: '4px 0' }}>
            New accounts are gated by a small browser-side proof-of-work
            (default 22 bits, ~5–10 seconds on a modern CPU). This is not the
            mining difficulty — it is purely anti-spam friction.
          </p>
          <p style={{ margin: '4px 0' }}>
            Two-step flow: get a challenge, then submit a solved + signed
            envelope. The server lazily creates the account and drops a
            session cookie on success.
          </p>
        </>
      ),
      endpoints: [
        {
          id: 'signup-challenge',
          method: 'POST',
          path: '/signup/challenge',
          auth: 'public',
          summary: 'Reserve nothing — just receive a stateless, MAC\'d PoW envelope tied to your handle and pubkey.',
          description: (
            <>
              The handle is checked for availability before the envelope is
              issued, but no DB row is reserved. If two clients request the
              same handle in parallel, the loser of the race at <code>POST /signup</code>{' '}
              gets <code>409 NAME_TAKEN</code>.
            </>
          ),
          request: {
            kind: 'body',
            example: `{
  "handle": "alice",                      // 3..64 chars, [a-zA-Z0-9._\\-@],
                                          // must start/end alphanumeric
  "pubkey": "9aXt..."                     // base58 Ed25519 pubkey, 32 bytes
}`,
          },
          response: `{
  "envelope": {
    "handle": "alice",
    "pubkey": "9aXt...",
    "nonce": "f2c1d4...",                 // 16 bytes hex
    "difficulty_bits": 22,
    "issued_at": "2026-05-08T22:05:22Z",
    "expires_at": "2026-05-08T23:05:22Z", // 1 hour TTL
    "domain": "rpow4.signup"
  },
  "envelope_mac": "ab12...",              // 32 bytes hex (server HMAC)
  "pow_prefix_hex": "7369676e75701f..."   // bytes the client hashes
}`,
          errors: [
            { status: 400, code: 'BAD_REQUEST', when: 'handle fails validation (too short, bad chars, reserved name, ...)' },
            { status: 409, code: 'NAME_TAKEN', when: 'handle is already registered to a different pubkey' },
          ],
          curl: `curl -X POST ${B}/signup/challenge \\
  -H 'content-type: application/json' \\
  -d '{"handle":"alice","pubkey":"9aXt..."}'`,
          js: `const r = await fetch('${B}/signup/challenge', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ handle: 'alice', pubkey }),
});
if (r.status === 409) throw new Error('name taken');
if (!r.ok) throw new Error('signup challenge failed');
const { envelope, envelope_mac, pow_prefix_hex } = await r.json();`,
        },
        {
          id: 'signup',
          method: 'POST',
          path: '/signup',
          auth: 'pow',
          summary: 'Submit a solved PoW + Ed25519 signature; on success the account is created and a session cookie is set.',
          description: (
            <>
              The PoW target is{' '}
              <code>SHA-256(prefix_bytes || u64le(solution_nonce))</code>
              {' '}with at least <code>difficulty_bits</code> trailing zero bits.
              The signature is over the canonical message{' '}
              <code>'account.signup'</code> with body{' '}
              <code>{'{ handle, pubkey, nonce }'}</code>. See{' '}
              <TocLink id="signing">how to sign</TocLink>.
            </>
          ),
          request: {
            kind: 'body',
            example: `{
  "envelope": { ...the envelope from /signup/challenge... },
  "envelope_mac": "ab12...",              // pass through unchanged
  "solution_nonce": "412384",             // decimal; satisfies trailing-zero target
  "client_signature_base58": "5J7q..."    // sig over canonical 'account.signup' body
}`,
          },
          response: `{
  "ok": true,
  "pubkey": "9aXt...",
  "display_name": "alice"
}`,
          errors: [
            { status: 400, code: 'BAD_REQUEST', when: 'envelope mac mismatch, malformed handle/pubkey, or domain mismatch' },
            { status: 400, code: 'INVALID_SOLUTION', when: 'solution_nonce does not meet difficulty_bits' },
            { status: 401, code: 'INVALID_SIGNATURE', when: 'signature does not verify against envelope.pubkey' },
            { status: 409, code: 'NAME_TAKEN', when: 'handle was claimed between challenge and submit' },
            { status: 409, code: 'SIGNUP_EXPIRED', when: 'envelope expired, or server difficulty changed' },
          ],
          curl: `curl -X POST ${B}/signup -c cookies.txt \\
  -H 'content-type: application/json' \\
  -d '{ "envelope": ..., "envelope_mac": ..., "solution_nonce": "...", "client_signature_base58": "..." }'`,
          js: `// 1. mine: find solution_nonce with trailing_zero_bits(sha256(prefix || u64le(nonce))) >= difficulty_bits
const prefix = hexToBytes(pow_prefix_hex);
const solutionNonce = await mine(prefix, envelope.difficulty_bits);

// 2. sign: canonicalMessage('account.signup', { handle, pubkey, nonce })
import { canonicalMessage, signCanonical } from '@rpow/shared';
const sig = signCanonical('account.signup',
  { handle: envelope.handle, pubkey: envelope.pubkey, nonce: envelope.nonce },
  privateKey);

// 3. submit
const r = await fetch('${B}/signup', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    envelope, envelope_mac,
    solution_nonce: solutionNonce.toString(),
    client_signature_base58: sig,
  }),
});`,
        },
      ],
    },

    {
      id: 'auth',
      title: 'Sign-in for an existing pubkey',
      intro: (
        <p style={{ margin: '4px 0 0' }}>
          For wallets that already exist (created here or imported from a seed
          phrase / private key). No PoW — just prove control of the pubkey by
          signing a fresh challenge.
        </p>
      ),
      endpoints: [
        {
          id: 'auth-challenge',
          method: 'POST',
          path: '/auth/challenge',
          auth: 'public',
          summary: 'Get a stateless, MAC\'d challenge envelope tied to your pubkey.',
          description: 'No DB writes. The envelope expires in 5 minutes.',
          request: { kind: 'body', example: `{ "pubkey": "9aXt..." }` },
          response: `{
  "envelope": {
    "pubkey": "9aXt...",
    "nonce": "f2c1d4...",
    "issued_at": "2026-05-08T22:05:22Z",
    "expires_at": "2026-05-08T22:10:22Z",
    "domain": "rpow4"
  },
  "envelope_mac": "ab12...",
  "message": "Sign in to rpow4 as 9aXt... (nonce f2c1d4...)"
}`,
          curl: `curl -X POST ${B}/auth/challenge \\
  -H 'content-type: application/json' \\
  -d '{"pubkey":"9aXt..."}'`,
          js: `const r = await fetch('${B}/auth/challenge', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pubkey }),
});
const { envelope, envelope_mac } = await r.json();`,
        },
        {
          id: 'auth-session',
          method: 'POST',
          path: '/auth/session',
          auth: 'public',
          summary: 'Exchange a signed envelope for a session cookie.',
          description: (
            <>
              Sign the envelope with{' '}
              <code>canonicalMessage('auth.session', envelope)</code>. On
              success the response sets an HMAC-signed{' '}
              <code>HttpOnly</code> cookie named <code>rpow4_session</code>{' '}
              with a 7-day TTL.
            </>
          ),
          request: {
            kind: 'body',
            example: `{
  "envelope": { ...from /auth/challenge... },
  "envelope_mac": "ab12...",
  "signature_base58": "5J7q..."
}`,
          },
          response: `{ "ok": true, "pubkey": "9aXt..." }`,
          errors: [
            { status: 400, code: 'BAD_REQUEST', when: 'envelope mac mismatch, domain mismatch, or invalid pubkey' },
            { status: 401, code: 'UNAUTHORIZED', when: 'envelope expired' },
            { status: 401, code: 'INVALID_SIGNATURE', when: 'signature does not verify' },
          ],
          curl: `curl -X POST ${B}/auth/session -c cookies.txt \\
  -H 'content-type: application/json' \\
  -d '{ "envelope": ..., "envelope_mac": ..., "signature_base58": "..." }'`,
          js: `import { signCanonical } from '@rpow/shared';
const sig = signCanonical('auth.session', envelope, privateKey);
await fetch('${B}/auth/session', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ envelope, envelope_mac, signature_base58: sig }),
});`,
        },
        {
          id: 'auth-logout',
          method: 'POST',
          path: '/auth/logout',
          auth: 'public',
          summary: 'Clear the session cookie.',
          description: 'No body. Always returns 200.',
          response: `{ "ok": true }`,
          curl: `curl -X POST ${B}/auth/logout -b cookies.txt -c cookies.txt`,
          js: `await fetch('${B}/auth/logout', { method: 'POST', credentials: 'include' });`,
        },
      ],
    },

    {
      id: 'wallet',
      title: 'Your account',
      endpoints: [
        {
          id: 'me',
          method: 'GET',
          path: '/me',
          auth: 'session',
          summary: 'Pubkey, display name, balance, and fee-waiver flag for the signed-in account.',
          description: 'All amounts are in base units; divide by 10⁹ to get RPOW. When send_fees_waived is true, POST /send does not charge a network fee (operators toggle via npm run toggle-send-fees in apps/server, not the API).',
          response: `{
  "pubkey": "9aXt...",
  "display_name": "alice",
  "balance_base_units": "8500000000",
  "minted_base_units": "9500000000",
  "sent_base_units": "1000000000",
  "received_base_units": "0",
  "send_fees_waived": false
}`,
          errors: [
            { status: 401, code: 'UNAUTHORIZED', when: 'no session cookie or session expired' },
            { status: 404, code: 'NOT_FOUND', when: 'session is for a pubkey that no longer has an account row' },
          ],
          curl: `curl ${B}/me -b cookies.txt`,
          js: `const me = await fetch('${B}/me', { credentials: 'include' }).then(r => r.json());`,
        },
        {
          id: 'set-display-name',
          method: 'POST',
          path: '/me/display_name',
          auth: 'session',
          summary: 'Set or clear your handle. Must be unique (case-insensitive).',
          description: (
            <>
              Sign the canonical body for action{' '}
              <code>'account.set_display_name'</code>. To clear, pass{' '}
              <code>display_name: null</code>.
            </>
          ),
          request: {
            kind: 'body',
            example: `{
  "display_name": "alice",                      // or null to clear
  "client_signature_base58": "5J7q..."          // sig over { display_name }
}`,
          },
          response: `{ "ok": true, "display_name": "alice" }`,
          errors: [
            { status: 400, code: 'BAD_REQUEST', when: 'name fails validation (length, charset, reserved, ...)' },
            { status: 401, code: 'UNAUTHORIZED', when: 'no session' },
            { status: 401, code: 'INVALID_SIGNATURE', when: 'signature does not verify' },
            { status: 409, code: 'NAME_TAKEN', when: 'someone else holds that handle' },
          ],
          curl: `curl -X POST ${B}/me/display_name -b cookies.txt \\
  -H 'content-type: application/json' \\
  -d '{ "display_name": "alice", "client_signature_base58": "..." }'`,
          js: `import { signCanonical } from '@rpow/shared';
const sig = signCanonical('account.set_display_name', { display_name: 'alice' }, privateKey);
await fetch('${B}/me/display_name', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ display_name: 'alice', client_signature_base58: sig }),
});`,
        },
      ],
    },

    {
      id: 'mining',
      title: 'Mining (claim block rewards)',
      intro: (
        <p style={{ margin: '4px 0 0' }}>
          Mining issues currency. Get a challenge, find a SHA-256 nonce that
          meets the current difficulty, sign and submit. The reward halves on
          a Bitcoin-like schedule and the supply is hard-capped at 21 M RPOW.
        </p>
      ),
      endpoints: [
        {
          id: 'mining-challenge',
          method: 'POST',
          path: '/challenge',
          auth: 'session',
          summary: 'Get a stateless, server-MAC\'d mining challenge.',
          description: 'No DB writes. Issues a fresh nonce_prefix bound to your pubkey, the current difficulty, and a 5-minute expiry.',
          request: { kind: 'body', example: `{}   // empty body` },
          response: `{
  "challenge_id": "8b7c0c0e-d4c1-4f26-9e66-...",
  "nonce_prefix": "f2c1d4...",                  // 16 bytes hex (you append your nonce)
  "difficulty_bits": 22,
  "issued_at": "2026-05-08T22:05:22Z",
  "expires_at": "2026-05-08T22:10:22Z",
  "challenge_mac": "ab12...                     // 32 bytes hex (do not modify)
}`,
          errors: [
            { status: 401, code: 'UNAUTHORIZED', when: 'no session' },
            { status: 410, code: 'SUPPLY_EXHAUSTED', when: '21M cap reached — no more mining' },
          ],
          curl: `curl -X POST ${B}/challenge -b cookies.txt`,
          js: `const ch = await fetch('${B}/challenge', {
  method: 'POST',
  credentials: 'include',
}).then(r => r.json());`,
        },
        {
          id: 'mint',
          method: 'POST',
          path: '/mint',
          auth: 'session',
          summary: 'Submit a solved challenge for the current block reward.',
          description: (
            <>
              The PoW target: find <code>solution_nonce</code> such that{' '}
              <code>SHA-256(nonce_prefix_bytes || u64le(solution_nonce))</code>
              {' '}has at least <code>difficulty_bits</code> trailing zero bits.
              Sign the canonical body for action <code>'mint'</code>:{' '}
              <code>{'{ challenge_id, solution_nonce }'}</code>.
            </>
          ),
          request: {
            kind: 'body',
            example: `{
  "challenge_id": "8b7c...",         // pass through unchanged
  "nonce_prefix": "f2c1d4...",       // pass through unchanged
  "difficulty_bits": 22,             // pass through unchanged
  "issued_at": "...",                // pass through unchanged
  "expires_at": "...",               // pass through unchanged
  "challenge_mac": "ab12...",        // pass through unchanged
  "solution_nonce": "412384",        // your decimal u64 PoW solution
  "client_signature_base58": "..."   // sig over { challenge_id, solution_nonce }
}`,
          },
          response: `{
  "token": {
    "id": "ad6c0c0e-...",                       // event_id, also the token's identity
    "value_base_units": "9500000000",           // current block reward (= 9.5 RPOW initially)
    "issued_at": "2026-05-08T22:05:22.456Z"
  }
}`,
          errors: [
            { status: 400, code: 'BAD_REQUEST', when: 'challenge_mac mismatch, malformed body' },
            { status: 400, code: 'INVALID_SOLUTION', when: 'hash does not meet difficulty' },
            { status: 400, code: 'CHALLENGE_ALREADY_CLAIMED', when: 'this challenge_id was already claimed' },
            { status: 401, code: 'UNAUTHORIZED', when: 'no session' },
            { status: 401, code: 'INVALID_SIGNATURE', when: 'mint signature does not verify' },
            { status: 410, code: 'CHALLENGE_EXPIRED', when: 'expires_at passed, or difficulty advanced under you' },
            { status: 410, code: 'SUPPLY_EXHAUSTED', when: '21M cap reached during commit' },
          ],
          curl: `curl -X POST ${B}/mint -b cookies.txt \\
  -H 'content-type: application/json' \\
  -d '{ ...all 6 challenge fields..., "solution_nonce": "...", "client_signature_base58": "..." }'`,
          js: `// 1. fetch challenge
const ch = await fetch('${B}/challenge', { method: 'POST', credentials: 'include' }).then(r => r.json());

// 2. mine: nonce_prefix is hex; concat with u64le(nonce) and hash
const prefix = hexToBytes(ch.nonce_prefix);
const solutionNonce = await mine(prefix, ch.difficulty_bits);

// 3. sign canonicalMessage('mint', { challenge_id, solution_nonce })
import { signCanonical } from '@rpow/shared';
const sig = signCanonical('mint', {
  challenge_id: ch.challenge_id,
  solution_nonce: solutionNonce.toString(),
}, privateKey);

// 4. submit
const r = await fetch('${B}/mint', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    ...ch,
    solution_nonce: solutionNonce.toString(),
    client_signature_base58: sig,
  }),
}).then(r => r.json());
console.log('minted', r.token.value_base_units, 'base units');`,
        },
      ],
    },

    {
      id: 'transfer',
      title: 'Sending RPOW',
      endpoints: [
        {
          id: 'send',
          method: 'POST',
          path: '/send',
          auth: 'session',
          summary: 'Transfer tokens to another pubkey.',
          description: (
            <>
              Idempotent (pass a stable <code>idempotency_key</code> so retries
              are safe). The fee is the current network fee from{' '}
              <code>/ledger</code>. Sign the canonical body for action{' '}
              <code>'transfer'</code>:{' '}
              <code>{'{ recipient_pubkey, amount_base_units, idempotency_key }'}</code>{' '}
              (plus <code>memo</code> when present).
            </>
          ),
          request: {
            kind: 'body',
            example: `{
  "recipient_pubkey": "Bz7K...",       // base58 Ed25519 pubkey, 32 bytes
  "amount_base_units": "1000000000",   // bigint string; 1e9 base units = 1 RPOW
  "idempotency_key": "client-abc-...", // 8..80 chars; stable across retries
  "client_signature_base58": "...",
  "memo": "lunch"                      // optional, max 64 chars
}`,
          },
          response: `{
  "ok": true,
  "transfer_id": "0a48c5b4-...",
  "transferred_base_units": "1000000000",
  "fee_base_units": "10000000",
  "recipient_pubkey": "Bz7K..."
}`,
          errors: [
            { status: 400, code: 'BAD_REQUEST', when: 'invalid recipient, amount, or sending to yourself' },
            { status: 400, code: 'INSUFFICIENT_BALANCE', when: 'not enough tokens (incl. fee)' },
            { status: 401, code: 'UNAUTHORIZED', when: 'no session' },
            { status: 401, code: 'INVALID_SIGNATURE', when: 'transfer signature does not verify' },
            { status: 409, code: 'BAD_REQUEST', when: 'idempotency_key reused with different parameters' },
          ],
          curl: `curl -X POST ${B}/send -b cookies.txt \\
  -H 'content-type: application/json' \\
  -d '{ "recipient_pubkey": "...", "amount_base_units": "1000000000", "idempotency_key": "abc123", "client_signature_base58": "..." }'`,
          js: `import { signCanonical } from '@rpow/shared';
const body = {
  recipient_pubkey,
  amount_base_units: '1000000000',
  idempotency_key: crypto.randomUUID(),
  memo: 'lunch',
};
const sig = signCanonical('transfer', body, privateKey);
const r = await fetch('${B}/send', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...body, client_signature_base58: sig }),
}).then(r => r.json());`,
        },
        {
          id: 'faucet-claim',
          method: 'POST',
          path: '/faucet/claim',
          auth: 'session',
          summary: 'Claim a small drip from the treasury (dev / testing).',
          description: 'No body. Cooldown enforced per-pubkey AND per-IP. Disabled in production unless explicitly enabled by the operator.',
          response: `{
  "ok": true,
  "amount_base_units": "100000000",
  "transfer_id": "0a48c5b4-...",
  "claim_id": "9b13...",
  "claimed_at": "2026-05-08T22:05:22.456Z",
  "next_claim_at": "2026-05-09T22:05:22.456Z"
}`,
          errors: [
            { status: 400, code: 'BAD_REQUEST', when: 'caller is the treasury account' },
            { status: 401, code: 'UNAUTHORIZED', when: 'no session' },
            { status: 403, code: 'BAD_REQUEST', when: 'faucet is disabled' },
            { status: 429, code: 'COOLDOWN_ACTIVE', when: 'within cooldown window for this pubkey or IP' },
            { status: 503, code: 'TREASURY_DRY', when: 'treasury balance < claim amount' },
          ],
          curl: `curl -X POST ${B}/faucet/claim -b cookies.txt`,
          js: `const r = await fetch('${B}/faucet/claim', {
  method: 'POST',
  credentials: 'include',
}).then(r => r.json());`,
        },
      ],
    },

    {
      id: 'claims',
      title: 'Claim tokens (offline transfers)',
      endpoints: [
        {
          id: 'claim-create',
          method: 'POST',
          path: '/claim',
          auth: 'session + sig',
          summary: 'Lock funds into a one-time bearer claim token.',
          description: `The sender generates a UUID client-side (claim_id) and signs over it along
with the amount (and optional memo). Funds are debited immediately; the
token can be shared as a URL /#/redeem/UUID or QR code.
Signed body: canonicalMessage('claim.create', { claim_id, amount_base_units, memo? })`,
          request: {
            kind: 'body',
            example: `{
  "claim_id": "550e8400-e29b-41d4-a716-446655440000",
  "amount_base_units": "1000000000",
  "memo": "birthday gift",
  "client_signature_base58": "..."
}`,
          },
          response: `{
  "ok": true,
  "claim_id": "550e8400-e29b-41d4-a716-446655440000",
  "amount_base_units": "1000000000",
  "memo": "birthday gift",
  "created_at": "2026-05-09T00:00:00Z"
}`,
          errors: [
            { status: 400, code: 'INSUFFICIENT_BALANCE', when: 'sender cannot cover the amount' },
            { status: 401, code: 'INVALID_SIGNATURE', when: 'claim.create signature fails' },
            { status: 409, code: 'DUPLICATE_CLAIM_ID', when: 'claim_id UUID already exists' },
          ],
          curl: `curl -X POST ${B}/claim -b cookies.txt -H 'content-type: application/json' \\
  -d '{"claim_id":"...","amount_base_units":"1000000000","client_signature_base58":"..."}'`,
          js: `const r = await fetch('${B}/claim', {
  method: 'POST', credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ claim_id, amount_base_units, client_signature_base58 }),
}).then(r => r.json());`,
        },
        {
          id: 'claim-status',
          method: 'GET',
          path: '/claim/:id',
          auth: 'public',
          summary: 'Fetch claim details — amount, memo, and state — by UUID.',
          description: 'Does not require a session. Suitable for a public "preview" page before the recipient signs in. The sender\'s pubkey is intentionally omitted from the response.',
          request: { kind: 'query', example: '' },
          response: `{
  "claim_id": "550e8400-...",
  "amount_base_units": "1000000000",
  "memo": "birthday gift",
  "state": "pending",
  "created_at": "2026-05-09T00:00:00Z"
}`,
          errors: [{ status: 404, code: 'NOT_FOUND', when: 'unknown or malformed UUID' }],
          curl: `curl ${B}/claim/550e8400-e29b-41d4-a716-446655440000`,
          js: `const c = await fetch('${B}/claim/550e8400-e29b-41d4-a716-446655440000').then(r => r.json());`,
        },
        {
          id: 'claim-my',
          method: 'GET',
          path: '/claim',
          auth: 'session',
          summary: 'List all claims created by the signed-in account, newest first.',
          description: 'Returns up to 100 claims across all states (pending, redeemed, cancelled).',
          request: { kind: 'query', example: '' },
          response: `{
  "claims": [
    {
      "claim_id": "...",
      "amount_base_units": "1000000000",
      "state": "pending",
      "created_at": "2026-05-09T00:00:00Z"
    }
  ]
}`,
          errors: [{ status: 401, code: 'UNAUTHORIZED', when: 'no valid session' }],
          curl: `curl ${B}/claim -b cookies.txt`,
          js: `const { claims } = await fetch('${B}/claim', { credentials: 'include' }).then(r => r.json());`,
        },
        {
          id: 'claim-redeem',
          method: 'POST',
          path: '/claim/:id/redeem',
          auth: 'session',
          summary: 'Redeem a pending claim to the signed-in account.',
          description: `Any authenticated user except the original sender can redeem.
Credits the redeemer and creates a TRANSFER ledger event that appears
in both parties' /activity feeds exactly like a normal send. No additional
signature is required — the session cookie is sufficient.`,
          request: { kind: 'body', example: '{}' },
          response: `{
  "ok": true,
  "amount_base_units": "1000000000",
  "transfer_id": "b1a2c3d4-...",
  "redeemed_at": "2026-05-09T01:00:00Z"
}`,
          errors: [
            { status: 400, code: 'BAD_REQUEST', when: 'sender tries to redeem their own claim' },
            { status: 409, code: 'ALREADY_REDEEMED', when: 'someone already redeemed this token' },
            { status: 409, code: 'CLAIM_CANCELLED', when: 'sender already cancelled the claim' },
          ],
          curl: `curl -X POST ${B}/claim/550e8400-.../redeem -b cookies.txt -H 'content-type: application/json' -d '{}'`,
          js: `const r = await fetch('${B}/claim/CLAIM_ID/redeem', {
  method: 'POST', credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: '{}',
}).then(r => r.json());`,
        },
        {
          id: 'claim-cancel',
          method: 'POST',
          path: '/claim/:id/cancel',
          auth: 'session + sig',
          summary: 'Cancel a pending claim and recover the locked funds.',
          description: `Only the original sender can cancel. Funds are silently returned to the sender's
spendable balance — no ledger event is created for cancellations.
Signed body: canonicalMessage('claim.cancel', { claim_id })`,
          request: {
            kind: 'body',
            example: `{
  "client_signature_base58": "..."
}`,
          },
          response: `{
  "ok": true,
  "amount_base_units": "1000000000",
  "cancelled_at": "2026-05-09T02:00:00Z"
}`,
          errors: [
            { status: 401, code: 'INVALID_SIGNATURE', when: 'claim.cancel signature fails' },
            { status: 403, code: 'FORBIDDEN', when: 'caller is not the sender' },
            { status: 409, code: 'ALREADY_REDEEMED', when: 'claim was already redeemed' },
            { status: 409, code: 'ALREADY_CANCELLED', when: 'claim was already cancelled' },
          ],
          curl: `curl -X POST ${B}/claim/CLAIM_ID/cancel -b cookies.txt \\
  -H 'content-type: application/json' \\
  -d '{"client_signature_base58":"..."}'`,
          js: `const r = await fetch('${B}/claim/CLAIM_ID/cancel', {
  method: 'POST', credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_signature_base58 }),
}).then(r => r.json());`,
        },
      ],
    },

    {
      id: 'activity',
      title: 'Your activity feed',
      endpoints: [
        {
          id: 'activity-feed',
          method: 'GET',
          path: '/activity',
          auth: 'session',
          summary: 'Mints, sends, and receives that involve your pubkey, newest first.',
          description: 'Cursor pagination. Filterable by event type. Aggregates events_count and balance in the same response.',
          request: {
            kind: 'query',
            example: `cursor: string                          (from previous page; optional)
limit:  number  (1..100, default 50)
type:   'mint' | 'send' | 'receive' | 'all'  (default 'all')`,
          },
          response: `{
  "balance_base_units": "8500000000",
  "total_count": 2,
  "items": [
    { "type": "send",
      "event_seq": "12",
      "amount_base_units": "1000000000",
      "fee_base_units": "10000000",
      "memo": "lunch",
      "counterparty_pubkey": "Bz7K...",
      "counterparty_display_name": "bob",
      "client_signature_base58": "...",
      "at": "2026-05-08T22:05:22Z" },
    { "type": "mint",
      "event_seq": "11",
      "amount_base_units": "9500000000",
      "at": "2026-05-08T22:04:11Z" }
  ],
  "next_cursor": "11"
}`,
          curl: `curl '${B}/activity?type=send&limit=20' -b cookies.txt`,
          js: `const a = await fetch('${B}/activity?limit=50', { credentials: 'include' }).then(r => r.json());`,
        },
      ],
    },
    {
      id: 'news',
      title: 'Project news / changelog',
      intro: (
        <p style={{ margin: '4px 0 0' }}>
          Public mini-blog endpoints for release notes, announcements, and
          changelogs. Publishing is restricted to logged-in accounts with the
          ops-controlled <code>is_admin</code> flag.
        </p>
      ),
      endpoints: [
        {
          id: 'news-list',
          method: 'GET',
          path: '/news',
          auth: 'public',
          summary: 'List published news posts.',
          description: (
            <p>
              Returns the newest published posts first. Markdown is returned as
              source text in <code>body_markdown</code>; clients should render
              it safely rather than trusting raw HTML.
            </p>
          ),
          request: { kind: 'query', example: '?limit=25' },
          response: `{
  "posts": [
    {
      "id": "uuid",
      "slug": "markets-launch-notes",
      "title": "Markets launch notes",
      "summary": "A short release note.",
      "body_markdown": "## Changes\\n\\n- Added markets.",
      "kind": "changelog",
      "author_pubkey": "8x...",
      "author_display_name": "admin",
      "published": true,
      "created_at": "2026-05-12T20:00:00.000Z",
      "updated_at": "2026-05-12T20:00:00.000Z",
      "published_at": "2026-05-12T20:00:00.000Z"
    }
  ]
}`,
          curl: `curl "${B}/news?limit=25"`,
          js: `const news = await fetch('${B}/news?limit=25').then(r => r.json());`,
        },
        {
          id: 'news-detail',
          method: 'GET',
          path: '/news/:slug',
          auth: 'public',
          summary: 'Read a single published news post.',
          description: <p>Looks up a post by its stable URL slug.</p>,
          response: `{
  "post": {
    "slug": "markets-launch-notes",
    "title": "Markets launch notes",
    "body_markdown": "## Changes\\n\\n- Added markets."
  }
}`,
          errors: [{ status: 404, code: 'NOT_FOUND', when: 'no published post exists for that slug' }],
          curl: `curl "${B}/news/markets-launch-notes"`,
          js: `const post = await fetch('${B}/news/markets-launch-notes').then(r => r.json());`,
        },
        {
          id: 'news-create',
          method: 'POST',
          path: '/news',
          auth: 'session',
          summary: 'Publish a Markdown news post as an admin.',
          description: (
            <p>
              Requires a valid session cookie and <code>accounts.is_admin = true</code>.
              Use the ops script <code>npm run toggle-admin -- &lt;pubkey-or-handle&gt;</code>
              to grant or revoke publishing access.
            </p>
          ),
          request: {
            kind: 'body',
            example: `{
  "title": "Markets launch notes",
  "summary": "A short release note.",
  "kind": "changelog",
  "body_markdown": "## Changes\\n\\n- Added markets.",
  "published": true
}`,
          },
          response: `{
  "ok": true,
  "post": {
    "slug": "markets-launch-notes",
    "title": "Markets launch notes",
    "published": true
  }
}`,
          errors: [
            { status: 401, code: 'UNAUTHORIZED', when: 'session cookie is missing or invalid' },
            { status: 403, code: 'FORBIDDEN', when: 'caller is not an admin' },
            { status: 409, code: 'SLUG_TAKEN', when: 'a unique slug could not be generated' },
          ],
          curl: `curl -X POST "${B}/news" \\
  -H "content-type: application/json" \\
  -b "rpow_session=..." \\
  -d '{"title":"Markets launch notes","kind":"changelog","body_markdown":"## Changes\\n\\n- Added markets."}'`,
          js: `await fetch('${B}/news', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    title: 'Markets launch notes',
    kind: 'changelog',
    body_markdown: '## Changes\\n\\n- Added markets.'
  })
});`,
        },
      ],
    },
    {
      id: 'markets',
      title: 'Internal markets (spot trading)',
      intro: (
        <>
          <p style={{ margin: '0 0 8px 0' }}>
            Every custom RPOW that launches opens an order-book spot market
            against RPOW4.0. Orders are reserved on placement: a limit buy
            locks quote (RPOW4.0), a limit sell locks base, and market orders
            debit spendable balances as they fill. The matching engine runs
            with price-time priority. Taker fees are taken from the quote leg
            and credited to the platform treasury; the default fee is{' '}
            <code>0 bps</code>.
          </p>
          <p style={{ margin: '0 0 8px 0' }}>
            Bot integrations should treat every amount and price as a decimal
            bigint string in base units (<code>1 coin = 1e9 base units</code>).
            Read endpoints are public and safe to poll. Write endpoints require
            both the <code>rpow4_session</code> cookie and an Ed25519 signature
            over the canonical order body.
          </p>
        </>
      ),
      endpoints: [
        {
          id: 'markets-list',
          method: 'GET',
          path: '/markets',
          auth: 'public',
          summary: 'All active markets with 24h volume, last price, best bid/ask.',
          description: '24h volume and trade count are computed from market_trades. Sorted by the base asset sequence number so RPOW4.1, RPOW4.2, ... stay stable for UIs and bots.',
          response: `{
  "markets": [
    {
      "id": "9e...",
      "symbol": "DOGE/RPOW4.0",
      "status": "active",
      "base_asset":  { "id": "...", "slug": "doge", "display_code": "RPOW4.1", "nickname": "DOGE", ... },
      "quote_asset": { "id": "...", "slug": "rpow4", "display_code": "RPOW4.0", "nickname": "RPOW4.0", ... },
      "taker_fee_bps": 0,
      "last_price_quote_base_units": "1500000000",
      "best_bid_quote_base_units": "1490000000",
      "best_ask_quote_base_units": "1510000000",
      "open_price_24h_quote_base_units": "1450000000",     // first trade in window; null if none
      "volume_24h_base_units": "12500000000",
      "volume_24h_quote_base_units": "18750000000",
      "trade_count_24h": 42,
      "created_at": "2026-05-09T18:00:00Z"
    }
  ],
  "default_quote_asset_slug": "rpow4-0"
}`,
          curl: `curl '${B}/markets'`,
          js: `const { markets } = await fetch('${B}/markets').then(r => r.json());`,
        },
        {
          id: 'market-detail',
          method: 'GET',
          path: '/markets/:market_id',
          auth: 'public',
          summary: 'Full summary for a single market (same fields as the list).',
          description: 'Returns 404 / MARKET_NOT_FOUND if no market matches. Use this before placing orders if your bot stores market IDs across restarts.',
          response: `{ "market": { /* same shape as /markets[] */ } }`,
          errors: [
            { status: 404, code: 'MARKET_NOT_FOUND', when: 'market_id is unknown or archived' },
          ],
          curl: `curl '${B}/markets/9e...'`,
          js: `const { market } = await fetch('${B}/markets/9e...').then(r => r.json());`,
        },
        {
          id: 'market-book',
          method: 'GET',
          path: '/markets/:market_id/book',
          auth: 'public',
          summary: 'Aggregated order book: top 25 price levels on each side.',
          description: 'Levels group all resting limit orders at the same price. Bids are sorted high-to-low; asks are sorted low-to-high. quote_amount_base_units is cumulative quote = ceil(base * price / 1e9) summed per level. Use these strings as bigints; multiplying base*price can overflow JS Number.',
          response: `{
  "market_id": "9e...",
  "bids": [
    { "price_quote_base_units": "1490000000",
      "base_amount_base_units": "5000000000",
      "quote_amount_base_units": "7450000000",
      "order_count": 3 }
  ],
  "asks": [
    { "price_quote_base_units": "1510000000",
      "base_amount_base_units": "3500000000",
      "quote_amount_base_units": "5285000000",
      "order_count": 2 }
  ],
  "at": "2026-05-12T17:33:01Z"
}`,
          curl: `curl '${B}/markets/9e.../book'`,
          js: `const book = await fetch('${B}/markets/9e.../book').then(r => r.json());`,
        },
        {
          id: 'market-trades',
          method: 'GET',
          path: '/markets/:market_id/trades',
          auth: 'public',
          summary: 'Recent fills, newest first.',
          description: '`taker_side` indicates who crossed the spread (buy or sell). Poll this endpoint for trade tape updates; there is no websocket stream yet.',
          request: {
            kind: 'query',
            example: `limit: number  (1..100, default 50)`,
          },
          response: `{
  "trades": [
    { "id": "a1...",
      "market_id": "9e...",
      "price_quote_base_units": "1505000000",
      "base_amount_base_units": "1000000000",
      "quote_amount_base_units": "1505000000",
      "taker_side": "buy",
      "fee_base_units": "0",
      "created_at": "2026-05-12T17:32:11Z" }
  ]
}`,
          curl: `curl '${B}/markets/9e.../trades?limit=40'`,
          js: `const { trades } = await fetch('${B}/markets/9e.../trades').then(r => r.json());`,
        },
        {
          id: 'market-candles',
          method: 'GET',
          path: '/markets/:market_id/candles',
          auth: 'public',
          summary: 'OHLC + volume buckets for the price chart.',
          description: 'Built on the fly from market_trades. Empty buckets are omitted. Young markets may have many trades but only one candle if all trades occurred in the same bucket; use /trades for tick-by-tick display.',
          request: {
            kind: 'query',
            example: `interval: '1m' | '5m' | '1h' | '1d'   (default '1m')
limit:    number  (1..240, default 80)`,
          },
          response: `{
  "market_id": "9e...",
  "interval": "1m",
  "candles": [
    { "bucket_start": "2026-05-12T17:00:00Z",
      "open_quote_base_units":  "1495000000",
      "high_quote_base_units":  "1510000000",
      "low_quote_base_units":   "1490000000",
      "close_quote_base_units": "1505000000",
      "volume_base_units":      "12000000000",
      "volume_quote_base_units":"18060000000",
      "trade_count": 6 }
  ]
}`,
          curl: `curl '${B}/markets/9e.../candles?interval=5m&limit=120'`,
          js: `const { candles } = await fetch('${B}/markets/9e.../candles?interval=1h').then(r => r.json());`,
        },
        {
          id: 'market-balances',
          method: 'GET',
          path: '/markets/:market_id/balances',
          auth: 'session',
          summary: 'Your spendable and locked balances for this pair.',
          description: '`locked_base_units` reflects funds reserved by your open orders on this asset. Spendable + locked equals your true holding.',
          response: `{
  "market_id": "9e...",
  "base":  { "asset_id": "...", "asset_slug": "doge", "asset_code": "RPOW4.1",
             "spendable_base_units": "8000000000", "locked_base_units": "2000000000" },
  "quote": { "asset_id": "...", "asset_slug": "rpow4", "asset_code": "RPOW4.0",
             "spendable_base_units": "5000000000", "locked_base_units": "0" }
}`,
          errors: [
            { status: 401, code: 'UNAUTHORIZED', when: 'no session cookie' },
            { status: 404, code: 'MARKET_NOT_FOUND', when: 'market_id is unknown or archived' },
          ],
          curl: `curl '${B}/markets/9e.../balances' -b cookies.txt`,
          js: `const bal = await fetch('${B}/markets/9e.../balances', { credentials: 'include' }).then(r => r.json());`,
        },
        {
          id: 'market-my-orders',
          method: 'GET',
          path: '/markets/:market_id/my-orders',
          auth: 'session',
          summary: 'Your last 100 orders on this market, newest first.',
          description: 'Includes open, partially_filled, filled, cancelled, expired, and rejected. Poll this after order placement/cancel and filter client-side by status as needed.',
          response: `{
  "orders": [
    { "id": "b2...",
      "market_id": "9e...",
      "owner_pubkey": "Bz7K...",
      "side": "buy",
      "order_type": "limit",
      "price_quote_base_units": "1500000000",
      "original_base_units":  "2000000000",
      "remaining_base_units": "1000000000",
      "reserved_asset_id": "...",
      "reserved_remaining_base_units": "1500000000",
      "status": "partially_filled",
      "client_order_id": "c0...",
      "created_at": "2026-05-12T17:30:00Z",
      "updated_at": "2026-05-12T17:32:11Z" }
  ]
}`,
          errors: [
            { status: 401, code: 'UNAUTHORIZED', when: 'no session cookie' },
          ],
          curl: `curl '${B}/markets/9e.../my-orders' -b cookies.txt`,
          js: `const { orders } = await fetch('${B}/markets/9e.../my-orders', { credentials: 'include' }).then(r => r.json());`,
        },
        {
          id: 'market-create-order',
          method: 'POST',
          path: '/markets/:market_id/orders',
          auth: 'session + sig',
          summary: 'Place a limit or market order. Funds are reserved atomically.',
          description: (
            <>
              <p style={{ margin: '0 0 8px' }}>
                Sign the body (sans <code>client_signature_base58</code>) with
                action <code>market.order.create</code>. The server validates,
                reserves quote (buy) or base (sell), runs the matching loop,
                and returns the resulting order + fills in the same response.
              </p>
              <p style={{ margin: '0 0 8px' }}>
                <code>client_order_id</code> is an idempotency token — repeating
                the exact same body returns the original result without
                double-placing. Use <code>crypto.randomUUID()</code>.
              </p>
              <p style={{ margin: 0 }}>
                Market buys may supply <code>max_quote_base_units</code> as a
                slippage cap. Market sells fill until the size or liquidity
                runs out and may be partially filled. Market orders never rest
                on the book; unfilled residual size is discarded and the order
                becomes <code>partially_filled</code> or <code>rejected</code>.
              </p>
            </>
          ),
          request: {
            kind: 'body',
            example: `{
  "market_id": "9e...",
  "side": "buy",                                 // 'buy' | 'sell'
  "order_type": "limit",                         // 'limit' | 'market'
  "price_quote_base_units": "1500000000",        // limit only — required
  "base_amount_base_units": "2000000000",        // size in BASE units
  "max_quote_base_units": "3010000000",          // optional, market buys
  "client_order_id": "...",                      // uuid; idempotency key
  "client_signature_base58": "..."               // sign body minus this field
}`,
          },
          response: `{
  "ok": true,
  "order": { /* MarketOrder shape; see /my-orders */ },
  "trades": [ { /* MarketTrade for each fill */ } ],
  "filled_base_units":   "1000000000",
  "spent_quote_base_units":  "1505000000",
  "received_quote_base_units": "0",
  "fee_base_units": "0"
}`,
          errors: [
            { status: 400, code: 'BAD_REQUEST', when: 'missing/invalid field, limit without price, market with price, or amounts overflow backend precision' },
            { status: 400, code: 'MARKET_PAUSED', when: 'market.status is not active' },
            { status: 400, code: 'INSUFFICIENT_BALANCE', when: 'reservation exceeds spendable balance on the reserved asset' },
            { status: 401, code: 'UNAUTHORIZED', when: 'no session cookie' },
            { status: 401, code: 'INVALID_SIGNATURE', when: 'signature does not verify against the session pubkey' },
            { status: 404, code: 'MARKET_NOT_FOUND', when: 'market_id is unknown or archived' },
          ],
          curl: `curl -X POST '${B}/markets/9e.../orders' \\
  -H 'content-type: application/json' \\
  -b cookies.txt \\
  -d '{ ...signed body... }'`,
          js: `import { signCanonical } from '@rpow/shared';

const body = {
  market_id, side: 'buy', order_type: 'limit',
  price_quote_base_units: '1500000000',
  base_amount_base_units: '2000000000',
  client_order_id: crypto.randomUUID(),
};
const wire = { ...body,
  client_signature_base58: signCanonical('market.order.create', body, priv),
};
const res = await fetch(\`${B}/markets/\${market_id}/orders\`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(wire),
}).then(r => r.json());`,
        },
        {
          id: 'market-cancel-order',
          method: 'POST',
          path: '/markets/:market_id/orders/:order_id/cancel',
          auth: 'session + sig',
          summary: 'Cancel a resting open or partially filled order; releases the locked balance.',
          description: 'Sign with action market.order.cancel. Only your own open or partially filled orders release funds. Cancelling an already-terminal order that still belongs to you returns ok:true with released_base_units=0; unknown or someone else’s orders return ORDER_NOT_FOUND.',
          request: {
            kind: 'body',
            example: `{
  "market_id": "9e...",
  "order_id":  "b2...",
  "client_signature_base58": "..."
}`,
          },
          response: `{
  "ok": true,
  "order": { /* MarketOrder, status now 'cancelled' */ },
  "released_base_units": "1000000000"
}`,
          errors: [
            { status: 400, code: 'BAD_REQUEST', when: 'invalid body or order does not belong to this market' },
            { status: 401, code: 'UNAUTHORIZED', when: 'no session cookie' },
            { status: 401, code: 'INVALID_SIGNATURE', when: 'signature does not verify' },
            { status: 404, code: 'ORDER_NOT_FOUND', when: 'order does not exist or is not yours' },
          ],
          curl: `curl -X POST '${B}/markets/9e.../orders/b2.../cancel' \\
  -H 'content-type: application/json' \\
  -b cookies.txt \\
  -d '{ ...signed body... }'`,
          js: `const body = { market_id, order_id };
const wire = { ...body,
  client_signature_base58: signCanonical('market.order.cancel', body, priv),
};
const res = await fetch(\`${B}/markets/\${market_id}/orders/\${order_id}/cancel\`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(wire),
}).then(r => r.json());`,
        },
      ],
    },
  ];
}

function BotTradingQuickstart({ apiBase }: { apiBase: string }) {
  return (
    <Panel title="BOT TRADING QUICKSTART">
      <div id="bot-trading" style={{ scrollMarginTop: 24 }} />
      <p style={{ margin: '4px 0 8px' }}>
        This is the minimum loop for an external trading bot. There is no API
        key system yet: bots authenticate the same way wallets do, by holding an
        Ed25519 private key, getting a session cookie, and signing every order
        body with <code>market.order.create</code> or{' '}
        <code>market.order.cancel</code>.
      </p>
      <ol style={{ margin: '0 0 10px 0', paddingLeft: 24, lineHeight: 1.7 }}>
        <li>Load or create an Ed25519 keypair. Keep the private key off the frontend.</li>
        <li>Call <code>POST /auth/challenge</code>, sign the envelope as <code>auth.session</code>, then call <code>POST /auth/session</code> and retain the <code>rpow4_session</code> cookie.</li>
        <li>Discover markets with <code>GET /markets</code>. Store <code>market.id</code>, not the display symbol.</li>
        <li>Poll <code>/book</code>, <code>/trades</code>, and optionally <code>/candles</code>. Use bigint math for every amount and price.</li>
        <li>Check <code>/balances</code> before placing orders. Remember open orders move funds from <code>spendable_base_units</code> to <code>locked_base_units</code>.</li>
        <li>Create orders with a fresh UUID <code>client_order_id</code>. Reusing the same ID returns the original result, which makes retries safe.</li>
        <li>Poll <code>/my-orders</code> after creates/cancels and reconcile fills from both the order status and returned trades.</li>
      </ol>
      <CodeBlock
        label="bot skeleton"
        language="js"
        code={`import { mnemonicToKeypair, signCanonical } from '@rpow/shared';

const API = '${apiBase}';
const kp = mnemonicToKeypair(process.env.RPOW_BOT_MNEMONIC);

async function json(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(\`\${res.status} \${body.error ?? 'ERROR'}: \${body.message ?? path}\`);
  return { body, headers: res.headers };
}

// Node fetch does not keep cookies automatically. In production use a cookie jar;
// this minimal example captures the single rpow4_session cookie.
async function login() {
  const challenge = await json('/auth/challenge', {
    method: 'POST',
    body: JSON.stringify({ pubkey: kp.publicKeyBase58 }),
  });
  const { envelope, envelope_mac } = challenge.body;
  const signature_base58 = signCanonical('auth.session', envelope, kp.secretKey);
  const session = await json('/auth/session', {
    method: 'POST',
    body: JSON.stringify({ envelope, envelope_mac, signature_base58 }),
  });
  return session.headers.get('set-cookie')?.split(';')[0] ?? '';
}

const cookie = await login();
const { markets } = (await json('/markets')).body;
const market = markets[0];

const [book, balances] = await Promise.all([
  json(\`/markets/\${market.id}/book\`).then(r => r.body),
  json(\`/markets/\${market.id}/balances\`, { headers: { cookie } }).then(r => r.body),
]);

// Example: post a small limit buy at the current best bid.
const body = {
  market_id: market.id,
  side: 'buy',
  order_type: 'limit',
  price_quote_base_units: market.best_bid_quote_base_units ?? '1000000000',
  base_amount_base_units: '1000000000',
  client_order_id: crypto.randomUUID(),
};

const order = await json(\`/markets/\${market.id}/orders\`, {
  method: 'POST',
  headers: { cookie },
  body: JSON.stringify({
    ...body,
    client_signature_base58: signCanonical('market.order.create', body, kp.secretKey),
  }),
});

console.log(order.body.order.status, order.body.filled_base_units);`}
      />
      <p className="dim" style={{ margin: '4px 0 0', fontSize: 12 }}>
        Operational notes: keep polling modest (the UI uses ~1.5s while visible),
        handle <code>401</code> by refreshing the session, handle{' '}
        <code>400 BAD_REQUEST</code> precision errors by reducing size/price,
        and use <code>max_quote_base_units</code> on market buys if your bot has
        any slippage tolerance.
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Page entry: assembles conventions + per-section endpoint blocks. Reads the
// API base URL for curl/JS examples. Production docs should point at the
// apex domain; local/dev builds can still override via VITE_API_BASE_URL.
// ---------------------------------------------------------------------------
export function DocsPage() {
  usePageMeta('API Docs', 'Complete REST API reference for RPOW4. Learn how to integrate, sign transactions, and interact with the network programmatically.');
  const apiBase = useMemo(() => {
    const env = (import.meta as ImportMeta & {
      env?: { VITE_API_DOCS_BASE_URL?: string; VITE_API_BASE_URL?: string };
    }).env;
    return (env?.VITE_API_DOCS_BASE_URL ?? env?.VITE_API_BASE_URL ?? 'https://rpow4.com').replace(/\/$/, '');
  }, []);
  const sections = useMemo(() => buildSections(apiBase), [apiBase]);

  return (
    <>
      <Panel title="API DOCS">
        <p style={{ margin: '0 0 6px 0' }}>
          Public REST API for rpow4. Everything you can do in the web UI you
          can do over HTTP — read network state, mine, send, manage your
          wallet, explore accounts and transactions, and trade internal RPOW
          markets from your own bots.
        </p>
        <p className="dim" style={{ margin: '4px 0 0 0', fontSize: 13 }}>
          base url:{' '}
          <code>
            {apiBase}
          </code>
        </p>
      </Panel>

      <Panel title="CONTENTS">
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
          <li>
            <TocLink id="conventions">Conventions</TocLink>{' '}
            <span className="dim">— base units, errors, sessions, signing</span>
          </li>
          <li>
            <TocLink id="signing">How to sign a request</TocLink>{' '}
            <span className="dim">— canonical messages, Ed25519, base58</span>
          </li>
          <li>
            <TocLink id="bot-trading">Bot trading quickstart</TocLink>{' '}
            <span className="dim">— session cookies, polling, signed orders</span>
          </li>
          {sections.map((s) => (
            <li key={s.id}>
              <TocLink id={s.id}>{s.title}</TocLink>
              <ul style={{ paddingLeft: 18, lineHeight: 1.6 }}>
                {s.endpoints.map((ep) => (
                  <li key={ep.id}>
                    <TocLink id={ep.id}>
                      <code style={{ fontSize: 12 }}>
                        {ep.method} {ep.path}
                      </code>
                    </TocLink>
                  </li>
                ))}
              </ul>
            </li>
          ))}
          <li>
            <TocLink id="errors">Error codes reference</TocLink>
          </li>
        </ul>
      </Panel>

      <Panel title="CONVENTIONS">
        <div id="conventions" style={{ scrollMarginTop: 24 }} />
        <h3 style={{ margin: '4px 0 4px 0', fontSize: 14 }}>Base URL</h3>
        <p style={{ margin: '0 0 10px 0' }}>
          Production: <code>https://rpow4.com</code>. Local dev:{' '}
          <code>http://localhost:8787</code>. All paths in this doc are
          relative to that base.
        </p>

        <h3 style={{ margin: '12px 0 4px 0', fontSize: 14 }}>Content type</h3>
        <p style={{ margin: '0 0 10px 0' }}>
          Requests with a body must send <code>content-type: application/json</code>.
          Responses are <code>application/json; charset=utf-8</code> unless
          noted otherwise (the only exception: <code>/.well-known/rpow-pubkey.pem</code>).
        </p>

        <h3 style={{ margin: '12px 0 4px 0', fontSize: 14 }}>Base units</h3>
        <p style={{ margin: '0 0 10px 0' }}>
          All amounts are integers in <i>base units</i>. <code>1 RPOW = 10⁹ base units</code>.
          Amounts are returned as decimal strings to avoid JS number precision loss.
        </p>

        <h3 style={{ margin: '12px 0 4px 0', fontSize: 14 }}>Pubkeys</h3>
        <p style={{ margin: '0 0 10px 0' }}>
          Identities are 32-byte Ed25519 public keys, base58-encoded — typically
          43–44 characters.
        </p>

        <h3 style={{ margin: '12px 0 4px 0', fontSize: 14 }}>Sessions</h3>
        <p style={{ margin: '0 0 10px 0' }}>
          Endpoints marked <code>session cookie</code> require an HMAC-signed{' '}
          <code>HttpOnly</code> cookie called <code>rpow4_session</code> (TTL 7 days).
          Get one by completing <TocLink id="auth-session">/auth/session</TocLink> or{' '}
          <TocLink id="signup">/signup</TocLink>. In <code>fetch</code> set{' '}
          <code>credentials: 'include'</code>; for <code>curl</code> use{' '}
          <code>-c cookies.txt -b cookies.txt</code>.
        </p>

        <h3 style={{ margin: '12px 0 4px 0', fontSize: 14 }}>Errors</h3>
        <p style={{ margin: '0 0 10px 0' }}>
          Errors return non-2xx HTTP status codes with a JSON body{' '}
          <code>{'{ "error": "CODE", "message": "human readable" }'}</code>.
          The full code reference is at <TocLink id="errors">the bottom of this page</TocLink>.
        </p>

        <h3 style={{ margin: '12px 0 4px 0', fontSize: 14 }}>Caching</h3>
        <p style={{ margin: 0 }}>
          Read endpoints (<code>/ledger</code>, <code>/ledger/events</code>,
          <code>/explorer/*</code>, <code>/stats/leaderboard</code>) emit{' '}
          <code>ETag</code> and short <code>Cache-Control</code> headers.
          Repeat polls with <code>If-None-Match</code> get a cheap{' '}
          <code>304 Not Modified</code>.
        </p>
      </Panel>

      <Panel title="HOW TO SIGN A REQUEST">
        <div id="signing" style={{ scrollMarginTop: 24 }} />
        <p style={{ margin: '4px 0 8px' }}>
          State-changing endpoints require an Ed25519 signature over a{' '}
          <i>canonical message</i>. The rules:
        </p>
        <ol style={{ margin: '0 0 10px 0', paddingLeft: 24, lineHeight: 1.7 }}>
          <li>Take the request body, but exclude the signature field itself.</li>
          <li>Sort object keys alphabetically at every depth.</li>
          <li>BigInts and bigint-typed numbers serialize as decimal strings.</li>
          <li>
            Prepend a domain string:{' '}
            <code>"rpow4." + action + ".v1\n"</code>.
          </li>
          <li>UTF-8 encode the result, sign with Ed25519, base58-encode the signature.</li>
        </ol>
        <p style={{ margin: '0 0 8px' }}>
          The shared package <code>@rpow/shared</code> exports{' '}
          <code>canonicalMessage</code>, <code>canonicalJson</code>,{' '}
          <code>signCanonical</code>, and <code>verifyCanonical</code> so you
          don't have to re-implement this. Action names are an enum:{' '}
          <code>'auth.session'</code>, <code>'mint'</code>,{' '}
          <code>'transfer'</code>, <code>'account.set_display_name'</code>,{' '}
          <code>'account.signup'</code>, <code>'market.order.create'</code>,{' '}
          <code>'market.order.cancel'</code>.
        </p>
        <CodeBlock
          label="example: signing a /send body"
          language="js"
          code={`import { signCanonical } from '@rpow/shared';

const body = {
  recipient_pubkey: 'Bz7K...',
  amount_base_units: '1000000000',
  idempotency_key: crypto.randomUUID(),
  memo: 'lunch',                     // optional
};

const client_signature_base58 = signCanonical('transfer', body, privateKey);

// Final wire body:
const wire = { ...body, client_signature_base58 };`}
        />
        <p className="dim" style={{ margin: '4px 0 0', fontSize: 12 }}>
          Implementing your own canonical-json? See{' '}
          <code>packages/shared/src/canonical.ts</code> in the repo. The
          algorithm is &lt;30 lines.
        </p>
      </Panel>

      <BotTradingQuickstart apiBase={apiBase} />

      {sections.map((section) => (
        <Panel key={section.id} title={section.title.toUpperCase()}>
          <div id={section.id} style={{ scrollMarginTop: 24 }} />
          {section.intro}
          {section.endpoints.map((ep) => (
            <EndpointBlock key={ep.id} ep={ep} />
          ))}
        </Panel>
      ))}

      <Panel title="ERROR CODES">
        <div id="errors" style={{ scrollMarginTop: 24 }} />
        <ErrorTable
          rows={[
            { status: 400, code: 'BAD_REQUEST', when: 'malformed body, query, or param' },
            { status: 400, code: 'INVALID_SOLUTION', when: 'PoW does not meet difficulty' },
            { status: 400, code: 'INSUFFICIENT_BALANCE', when: 'sender has < (amount + fee)' },
            { status: 400, code: 'CHALLENGE_ALREADY_CLAIMED', when: 'a mint challenge_id was already used' },
            { status: 401, code: 'UNAUTHORIZED', when: 'session required and missing/expired' },
            { status: 401, code: 'INVALID_SIGNATURE', when: 'Ed25519 signature does not verify' },
            { status: 403, code: 'BAD_REQUEST', when: 'feature disabled (e.g. faucet off)' },
            { status: 404, code: 'NOT_FOUND', when: 'resource (account, route) not found' },
            { status: 404, code: 'NAME_NOT_FOUND', when: '/lookup/:name resolves to no account' },
            { status: 409, code: 'NAME_TAKEN', when: 'handle is already in use' },
            { status: 409, code: 'BAD_REQUEST', when: 'idempotency_key reused with different parameters' },
            { status: 409, code: 'SIGNUP_EXPIRED', when: 'signup envelope expired or difficulty changed' },
            { status: 410, code: 'CHALLENGE_EXPIRED', when: 'mining challenge expired or difficulty advanced' },
            { status: 410, code: 'SUPPLY_EXHAUSTED', when: '21M cap reached' },
            { status: 429, code: 'COOLDOWN_ACTIVE', when: 'faucet cooldown for this pubkey or IP' },
            { status: 503, code: 'TREASURY_DRY', when: 'treasury cannot fund a faucet claim' },
            { status: 404, code: 'MARKET_NOT_FOUND', when: 'market_id is unknown or archived' },
            { status: 404, code: 'ORDER_NOT_FOUND', when: 'cancel target order_id is not yours or does not exist' },
            { status: 400, code: 'MARKET_PAUSED', when: 'market.status is not active' },
          ]}
        />
      </Panel>
    </>
  );
}
