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
  const selectedSlug = slugFromPath(location.pathname);

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

  const selectedAsset = useMemo(
    () => assets.find((a) => a.slug === selectedSlug) ?? assets.find((a) => a.slug === DEFAULT_ASSET_SLUG) ?? null,
    [assets, selectedSlug],
  );
  const isDefaultAsset = selectedSlug === DEFAULT_ASSET_SLUG;

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
