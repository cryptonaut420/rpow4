import { useMemo, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { usePageMeta } from '../hooks/usePageMeta.js';
import overviewMd from '../content/history/overview.md?raw';
import rpowMd from '../content/history/rpow.md?raw';
import preBitcoinMd from '../content/history/pre-bitcoin.md?raw';
import manifestosMd from '../content/history/manifestos.md?raw';
import whitepaperMd from '../content/history/bitcoin-whitepaper.md?raw';
import declarationMd from '../content/history/bitcoin-declaration.md?raw';
import poolsMd from '../content/history/pools.md?raw';
import sourcesMd from '../content/history/sources.md?raw';

type TabId = 'overview' | 'rpow' | 'prebitcoin' | 'manifestos' | 'whitepaper' | 'declaration' | 'pools' | 'sources';

interface Tab {
  id: TabId;
  label: string;
  title: string;
  body: string;
}

const TABS: Tab[] = [
  { id: 'overview', label: 'overview', title: 'OVERVIEW', body: overviewMd },
  { id: 'rpow', label: 'rpow', title: 'RPOW LINEAGE', body: rpowMd },
  { id: 'prebitcoin', label: 'pre-bitcoin', title: 'PRE-BITCOIN CASH', body: preBitcoinMd },
  { id: 'manifestos', label: 'manifestos', title: 'MANIFESTOS', body: manifestosMd },
  { id: 'whitepaper', label: 'white paper', title: 'BITCOIN WHITE PAPER', body: whitepaperMd },
  { id: 'declaration', label: 'declaration', title: 'BITCOIN DECLARATION', body: declarationMd },
  { id: 'pools', label: 'pools', title: 'MINING POOLS', body: poolsMd },
  { id: 'sources', label: 'sources', title: 'SOURCES', body: sourcesMd },
];

function TabButton({ tab, active, onClick }: { tab: Tab; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        color: active ? 'var(--fg)' : 'var(--dim)',
        fontWeight: active ? 'bold' : 'normal',
      }}
    >
      [ {active ? '*' : ' '} {tab.label} ]
    </button>
  );
}

function MarkdownPane({ body }: { body: string }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: '10px 12px',
        border: '1px solid var(--accent-dim)',
        background: 'var(--bg-2)',
        overflowX: 'auto',
        whiteSpace: 'pre-wrap',
        lineHeight: 1.55,
        fontSize: 13,
      }}
    >
      {body}
    </pre>
  );
}

export function HistoryPage() {
  usePageMeta('History', 'Explore the origins of proof-of-work: Hal Finney\'s RPOW, Bitcoin, the cypherpunk manifesto, and Satoshi\'s whitepaper.');
  const [active, setActive] = useState<TabId>('overview');
  const activeTab = useMemo(() => TABS.find((t) => t.id === active) ?? TABS[0], [active]);

  return (
    <>
      <Panel title="ORIGINS / HISTORY">
        <p style={{ margin: '0 0 10px' }}>
          A public reading room for the ideas that led to Bitcoin and to this RPOW4
          tribute: electronic cash, proof-of-work, cypherpunk politics, smart
          contracts, and the paper that tied the pieces together.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {TABS.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab}
              active={active === tab.id}
              onClick={() => setActive(tab.id)}
            />
          ))}
        </div>
      </Panel>

      <Panel title={activeTab.title}>
        <MarkdownPane body={activeTab.body} />
      </Panel>
    </>
  );
}
