import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { CopyButton } from '../components/CopyButton.js';
import { api } from '../api.js';
import { useWallet } from '../wallet/WalletProvider.js';
import type { ActivityEntry } from '@rpow/shared';
import { shortPubkey } from '@rpow/shared';
import { formatRpow } from '../lib/format.js';

export function ActivityPage() {
  const wallet = useWallet();
  const [items, setItems] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (wallet.status !== 'unlocked') { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    api.activity()
      .then((r) => { if (!cancelled) setItems(r); })
      .catch((e: any) => { if (!cancelled) setError(e?.message ?? 'failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [wallet.status]);

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

  if (loading) return <Panel title="ACTIVITY"><div>loading...</div></Panel>;
  if (error) return <Panel title="ACTIVITY"><div className="error">{error}</div></Panel>;
  if (!items || items.length === 0) {
    return (
      <Panel title="ACTIVITY">
        <div style={{ color: 'var(--dim)' }}>(no activity yet — try mining or sending)</div>
      </Panel>
    );
  }

  return (
    <Panel title="ACTIVITY">
      <div style={{ display: 'grid', gridTemplateColumns: 'auto auto auto 1fr auto', columnGap: 12, rowGap: 4, alignItems: 'center' }}>
        {items.map((e, idx) => {
          const when = e.at.replace('T', ' ').slice(0, 19);
          const tag = e.type.toUpperCase();
          const sign = e.type === 'send' ? '-' : '+';
          const amt = `${sign}${formatRpow(e.amount_base_units)}`;
          return (
            <RowFragment
              key={idx}
              when={when}
              tag={tag}
              amt={amt}
              counterparty={e.counterparty_pubkey ?? null}
              counterpartyName={e.counterparty_display_name ?? null}
              sigSnippet={e.client_signature_base58 ?? null}
            />
          );
        })}
      </div>
    </Panel>
  );
}

function RowFragment({
  when, tag, amt, counterparty, counterpartyName, sigSnippet,
}: {
  when: string;
  tag: string;
  amt: string;
  counterparty: string | null;
  counterpartyName: string | null;
  sigSnippet: string | null;
}) {
  return (
    <>
      <span style={{ color: 'var(--dim)' }}>{when}</span>
      <span style={{ color: 'var(--accent)' }}>{tag}</span>
      <span style={{ textAlign: 'right' }}>{amt}</span>
      <span style={{ color: 'var(--dim)' }}>
        {counterparty ? (
          <span title={counterparty}>
            <code>{counterpartyName ?? shortPubkey(counterparty)}</code>{' '}
            <CopyButton text={counterparty} label="copy" />
          </span>
        ) : ''}
      </span>
      <span style={{ color: 'var(--dim)', fontSize: 12 }}>
        {sigSnippet ? <span title={sigSnippet}>sig:{sigSnippet.slice(0, 8)}…</span> : ''}
      </span>
    </>
  );
}
