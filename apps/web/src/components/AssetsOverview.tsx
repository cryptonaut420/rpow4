import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { MeBalanceEntry } from '@rpow/shared';
import { Panel } from './Panel.js';
import { api } from '../api.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { DEFAULT_ASSET_SLUG, useAsset } from '../assets/AssetProvider.js';
import { formatRpow } from '../lib/format.js';

const POLL_MS = 15_000;
const RPOW2_ASSET_PATH = '/assets/rpow2';

/**
 * Multi-asset overview shown at the top of the wallet page. Lists every
 * asset where the signed-in account has activity (RPOW4.0 always pinned),
 * with quick actions per row. Mineable assets get [send] / [activity]
 * deep-links into their asset-scoped routes; RPOW2 gets links to its
 * deposits/withdrawals page and local ledger activity.
 *
 * The currently-focused asset (based on URL slug) is highlighted with a `*`
 * marker so users can correlate this hub view with the per-asset detail
 * panel below it.
 *
 * Polls every {@link POLL_MS}ms while the page is visible so balances stay
 * roughly fresh as mining/sending happens elsewhere in the app.
 */
export function AssetsOverview() {
  const wallet = useWallet();
  const { selectedSlug, assetPath } = useAsset();
  const location = useLocation();
  const [balances, setBalances] = useState<MeBalanceEntry[] | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async (silent = false) => {
    if (wallet.status !== 'unlocked') return;
    try {
      const r = await api.balances();
      setBalances(r.balances);
      setError('');
    } catch (e: any) {
      if (!silent) setError(e?.message ?? 'failed to load balances');
    }
  }, [wallet.status]);

  useEffect(() => {
    if (wallet.status !== 'unlocked') {
      setBalances(null);
      return;
    }
    void refresh();
    const id = window.setInterval(() => {
      if (document.hidden) return;
      void refresh(true);
    }, POLL_MS);
    const onVis = () => { if (!document.hidden) void refresh(true); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [refresh, wallet.status]);

  if (wallet.status !== 'unlocked') return null;

  return (
    <Panel title="YOUR ASSETS">
      {error && !balances ? (
        <div className="error" style={{ marginBottom: 8 }}>{error}</div>
      ) : null}
      {!balances ? (
        <div style={{ color: 'var(--dim)' }}>loading balances…</div>
      ) : balances.length === 0 ? (
        <div style={{ color: 'var(--dim)' }}>(no assets yet — start mining RPOW4.0 below)</div>
      ) : (
        <div className="assets-overview">
          {balances.map((b) => (
            <AssetRow
              key={b.asset_id}
              entry={b}
              active={b.asset_slug === selectedSlug || location.pathname === `/assets/${b.asset_slug}` || location.pathname.startsWith(`/assets/${b.asset_slug}/`)}
              assetPath={assetPath}
            />
          ))}
        </div>
      )}
      <div className="assets-overview-footer">
        <Link to={RPOW2_ASSET_PATH}>[ RPOW2 deposits / withdrawals ]</Link>{' '}
        <Link to={assetPath('/launch', DEFAULT_ASSET_SLUG)}>[ launch new rpow ]</Link>
      </div>
    </Panel>
  );
}

function AssetRow({
  entry,
  active,
  assetPath,
}: {
  entry: MeBalanceEntry;
  active: boolean;
  assetPath: (path?: string, slug?: string) => string;
}) {
  const isExternal = entry.asset_kind === 'external_custodial';
  const balance = formatRpow(entry.balance_base_units);
  const focusHref = isExternal ? RPOW2_ASSET_PATH : assetPath('/', entry.asset_slug);

  return (
    <div className={`assets-overview-row ${active ? 'active' : ''} ${isExternal ? 'external' : ''}`}>
      <div className="assets-overview-left">
        <Link to={focusHref} className="assets-overview-name" title={entry.nickname}>
          <span className="assets-overview-marker">{active ? '*' : ' '}</span>
          <span className="assets-overview-code">{entry.display_code}</span>
          <span className="assets-overview-nickname">
            {entry.nickname}
            {entry.system_default ? ' (original)' : ''}
          </span>
        </Link>
      </div>
      <div className="assets-overview-balance">
        <strong>{balance}</strong> <span className="dim">{entry.display_code}</span>
      </div>
      <div className="assets-overview-actions">
        {isExternal ? (
          <>
            <Link to={RPOW2_ASSET_PATH}>[ deposits / withdrawals ]</Link>{' '}
            <Link to="/assets/rpow2/activity">[ activity ]</Link>
          </>
        ) : (
          <>
            <Link to={assetPath('/send', entry.asset_slug)}>[ send ]</Link>{' '}
            <Link to={assetPath('/activity', entry.asset_slug)}>[ activity ]</Link>
          </>
        )}
      </div>
    </div>
  );
}
