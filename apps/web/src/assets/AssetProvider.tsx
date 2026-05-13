import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type AssetSummary } from '../api.js';

export const DEFAULT_ASSET_SLUG = 'rpow4-0';

interface AssetContextValue {
  assets: AssetSummary[];
  selectedAsset: AssetSummary | null;
  selectedSlug: string;
  loading: boolean;
  refreshAssets(): Promise<void>;
  assetPath(path?: string, slug?: string): string;
  selectAsset(slug: string): void;
  isDefaultAsset: boolean;
}

const AssetContext = createContext<AssetContextValue | null>(null);

function slugFromPath(pathname: string): string {
  // Only `/r/<slug>/...` paths scope to a specific instance. Standalone pages
  // like `/markets`, `/news`, `/assets/rpow2` (RPOW2 deposits/withdrawals),
  // `/docs`, etc. inherit whatever instance the user last selected — they do
  // not change the active instance.
  const m = pathname.match(/^\/r\/([^/]+)(?:\/|$)/);
  return m?.[1] ?? DEFAULT_ASSET_SLUG;
}

function stripAssetPrefix(pathname: string): string {
  const stripped = pathname.replace(/^\/r\/[^/]+/, '');
  return stripped || '/';
}

export function AssetProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const nav = useNavigate();
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const urlSlug = slugFromPath(location.pathname);

  const refreshAssets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.assets();
      setAssets(res.assets);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAssets();
  }, [refreshAssets]);

  const selectedAsset = useMemo(() => {
    // Only mineable assets count as "instances" of the platform. Non-mineable
    // assets (RPOW2 etc.) are accessed through dedicated pages, so if a URL
    // points at one we transparently fall back to the platform default
    // instead of letting it become the active instance. Same fallback for
    // unknown / paused / archived slugs so the rest of the UI never points
    // at a non-existent asset.
    const found = assets.find((a) => a.slug === urlSlug);
    if (found && found.asset_kind === 'mineable') return found;
    return assets.find((a) => a.slug === DEFAULT_ASSET_SLUG) ?? null;
  }, [assets, urlSlug]);

  // Expose the *effective* slug (the slug of the asset actually selected),
  // not the raw URL slug, so API calls always target a real asset. While
  // the assets list is still loading we fall back to the URL slug so deep
  // links don't briefly thrash the default asset's caches.
  const selectedSlug = selectedAsset?.slug ?? urlSlug;
  const isDefaultAsset = selectedSlug === DEFAULT_ASSET_SLUG;

  // Stale `/r/<non-mineable-or-unknown>/...` URLs (an old bookmark to a
  // paused/archived asset, a typo, or `/r/rpow2/wallet`) are quietly
  // normalized to the equivalent default-asset URL so the address bar
  // stays in sync with the active instance and API calls don't 404.
  useEffect(() => {
    if (loading || assets.length === 0) return;
    if (urlSlug === DEFAULT_ASSET_SLUG) return;
    const found = assets.find((a) => a.slug === urlSlug);
    const isUnknownOrNonMineable = !found || found.asset_kind !== 'mineable';
    if (isUnknownOrNonMineable) {
      const stripped = stripAssetPrefix(location.pathname);
      nav(`${stripped}${location.search}`, { replace: true });
    }
  }, [assets, urlSlug, loading, location.pathname, location.search, nav]);

  const assetPath = useCallback((path = '/', slug = selectedSlug) => {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    if (slug === DEFAULT_ASSET_SLUG) return normalized;
    return `/r/${slug}${normalized === '/' ? '' : normalized}`;
  }, [selectedSlug]);

  const selectAsset = useCallback((slug: string) => {
    const current = stripAssetPrefix(location.pathname);
    nav(`${assetPath(current, slug)}${location.search}`);
  }, [assetPath, location.pathname, location.search, nav]);

  return (
    <AssetContext.Provider value={{
      assets,
      selectedAsset,
      selectedSlug,
      loading,
      refreshAssets,
      assetPath,
      selectAsset,
      isDefaultAsset,
    }}>
      {children}
    </AssetContext.Provider>
  );
}

export function useAsset(): AssetContextValue {
  const ctx = useContext(AssetContext);
  if (!ctx) throw new Error('useAsset() must be used inside <AssetProvider>');
  return ctx;
}
