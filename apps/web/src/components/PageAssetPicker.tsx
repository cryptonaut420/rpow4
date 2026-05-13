import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { MeBalanceEntry } from '@rpow/shared';
import { api } from '../api.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { DEFAULT_ASSET_SLUG, useAsset } from '../assets/AssetProvider.js';
import { formatRpow } from '../lib/format.js';

/**
 * Compact in-page asset picker shown at the top of pages like Send and
 * Activity. Lists every mineable asset where the signed-in account has a
 * balance row (RPOW4.0 always pinned), with the spendable balance inline so
 * users can switch context without leaving the page.
 *
 * Switching navigates between `<unscoped>` and `/r/<slug><unscoped>` while
 * preserving query string, so the global instance dropdown stays in sync
 * via slugFromPath.
 *
 * RPOW2 (and any future external/bridged asset) is intentionally absent —
 * those assets live on `/assets/rpow2`, not the per-asset send/activity
 * routes.
 */
export function PageAssetPicker({ label = 'asset' }: { label?: string }) {
  const wallet = useWallet();
  const { selectedSlug, selectedAsset } = useAsset();
  const nav = useNavigate();
  const location = useLocation();
  const [balances, setBalances] = useState<MeBalanceEntry[] | null>(null);

  useEffect(() => {
    if (wallet.status !== 'unlocked') {
      setBalances(null);
      return;
    }
    let cancelled = false;
    api.balances()
      .then((r) => { if (!cancelled) setBalances(r.balances); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [wallet.status]);

  const mineable = (balances ?? []).filter((b) => b.asset_kind === 'mineable');
  // Always include the default + currently-selected slug so the picker
  // never goes out of sync with the URL while balances are loading or if
  // the user only has zero balances elsewhere.
  const ensureSlugs = new Set(mineable.map((b) => b.asset_slug));
  if (!ensureSlugs.has(DEFAULT_ASSET_SLUG)) {
    mineable.unshift({
      asset_id: '__default-fallback__',
      asset_slug: DEFAULT_ASSET_SLUG,
      display_code: 'RPOW4.0',
      nickname: 'RPOW4',
      asset_kind: 'mineable',
      system_default: true,
      sequence_number: 1,
      balance_base_units: '0',
      minted_base_units: '0',
      sent_base_units: '0',
      received_base_units: '0',
      events_count: 0,
    });
    ensureSlugs.add(DEFAULT_ASSET_SLUG);
  }
  if (!ensureSlugs.has(selectedSlug) && selectedAsset?.asset_kind === 'mineable') {
    mineable.push({
      asset_id: selectedAsset.id,
      asset_slug: selectedAsset.slug,
      display_code: selectedAsset.display_code,
      nickname: selectedAsset.nickname,
      asset_kind: 'mineable',
      system_default: selectedAsset.system_default,
      sequence_number: 0,
      balance_base_units: '0',
      minted_base_units: '0',
      sent_base_units: '0',
      received_base_units: '0',
      events_count: 0,
    });
  }

  // Don't render the picker if the user only has one mineable asset to
  // pick from — the global instance dropdown already covers that case and
  // an extra control would just be noise.
  if (mineable.length < 2) return null;

  function handleChange(nextSlug: string) {
    if (nextSlug === selectedSlug) return;
    // Strip the `/r/<slug>` prefix from the current path and re-attach
    // the new one. Keeps query params (e.g. send?to=...) intact.
    const stripped = location.pathname.replace(/^\/r\/[^/]+/, '') || '/';
    const next = nextSlug === DEFAULT_ASSET_SLUG ? stripped : `/r/${nextSlug}${stripped === '/' ? '' : stripped}`;
    nav(`${next}${location.search}`);
  }

  return (
    <div className="page-asset-picker">
      <label>
        <span className="dim" style={{ fontSize: 11, letterSpacing: '0.05em' }}>{label.toUpperCase()} :</span>{' '}
        <select value={selectedSlug} onChange={(e) => handleChange(e.target.value)}>
          {mineable.map((b) => (
            <option key={b.asset_id} value={b.asset_slug}>
              {b.display_code} · {b.nickname} — {formatRpow(b.balance_base_units)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
