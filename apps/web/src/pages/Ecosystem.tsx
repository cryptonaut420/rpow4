import { Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { usePageMeta } from '../hooks/usePageMeta.js';

interface EcosystemEntry {
  label: string;
  url: string;
  description: string;
  /** Marks the current site so we can render "(you are here)" instead of a link arrow. */
  self?: boolean;
}

const SOCIAL: EcosystemEntry[] = [
  {
    label: 'x.com/rpow4mining',
    url: 'https://x.com/rpow4mining',
    description: 'official RPOW4 account on X (Twitter) — announcements, updates, and mining culture.',
  },
  {
    label: 't.me/rpow4mining',
    url: 'https://t.me/rpow4mining',
    description: 'official RPOW4 Telegram channel — community discussion and announcements.',
  },
];

const SITES: EcosystemEntry[] = [
  {
    label: 'rpow4.com',
    url: 'https://rpow4.com',
    description: 'modern Hal-Finney RPOW tribute with bitcoin-style tokenomics and wallet-native auth (this site).',
    self: true,
  },
  {
    label: 'rpow3.com',
    url: 'https://rpow3.com',
    description: 'earlier RPOW tribute that recreates Hal Finney’s reusable proof-of-work system.',
  },
  {
    label: 'rpow2.com',
    url: 'https://rpow2.com',
    description: 'original community RPOW2 port — the project this lineage built on.',
  },
  {
    label: 'rpow2swap.com',
    url: 'https://rpow2swap.com/',
    description: 'exchange for swapping the RPOW2 token.',
  },
  {
    label: 'rpow2stats.com',
    url: 'http://rpow2stats.com',
    description: 'community stats and network metrics for RPOW2.',
  },
  {
    label: 'rpow.hopeware.ltd',
    url: 'https://rpow.hopeware.ltd/',
    description: 'a CLI tool for performing proof-of-work mining against an RPOW node.',
  },
  {
    label: 'rpowmarket.com',
    url: 'https://rpowmarket.com',
    description: 'parody Bitcoin prediction market with 5-minute up/down bets on RPOW2 play tokens.',
  },
];

const REPOS: EcosystemEntry[] = [
  {
    label: 'github.com/cryptonaut420/rpow4',
    url: 'https://github.com/cryptonaut420/rpow4',
    description: 'source for this site (rpow4).',
  },
  {
    label: 'github.com/arben777/rpow3',
    url: 'https://github.com/arben777/rpow3',
    description: 'source for rpow3 — hashcash mining and Ed25519-signed tokens.',
  },
  {
    label: 'github.com/frkrueger/rpow',
    url: 'https://github.com/frkrueger/rpow',
    description: 'original community RPOW2 implementation.',
  },
  {
    label: 'github.com/ImMike/rpowmarket',
    url: 'https://github.com/ImMike/rpowmarket',
    description: 'source for rpowmarket — the parody prediction market.',
  },
];

function EntryRow({ entry }: { entry: EcosystemEntry }) {
  return (
    <li className="ecosystem-entry">
      <div className="ecosystem-entry-head">
        <span className="ecosystem-entry-bullet">&gt;</span>
        <a href={entry.url} target="_blank" rel="noopener noreferrer" className="ecosystem-entry-link">
          {entry.label}
        </a>
        {entry.self ? <span className="ecosystem-entry-tag">(you are here)</span> : null}
      </div>
      <div className="ecosystem-entry-desc">{entry.description}</div>
    </li>
  );
}

export function EcosystemPage() {
  usePageMeta(
    'Ecosystem',
    'A directory of related projects in the RPOW ecosystem — live sites and source repos.',
  );

  return (
    <>
      <Panel title="ECOSYSTEM">
        <p style={{ margin: '0 0 6px' }}>
          A directory of related projects in the RPOW family — prior tributes, community
          ports, and tooling that orbits the same idea.
        </p>
      </Panel>

      <Panel title="SOCIAL">
        <ul className="ecosystem-list">
          {SOCIAL.map((s) => <EntryRow key={s.url} entry={s} />)}
        </ul>
      </Panel>

      <Panel title="LIVE SITES">
        <ul className="ecosystem-list">
          {SITES.map((s) => <EntryRow key={s.url} entry={s} />)}
        </ul>
      </Panel>

      <Panel title="REPOS">
        <ul className="ecosystem-list">
          {REPOS.map((r) => <EntryRow key={r.url} entry={r} />)}
        </ul>
      </Panel>

      <Panel>
        <div style={{ color: 'var(--dim)', fontSize: 13, lineHeight: 1.55 }}>
          know of more links in the RPOW ecosystem?{' '}
          let us know in the <Link to="/trollbox">[ trollbox ]</Link>!
        </div>
      </Panel>
    </>
  );
}
