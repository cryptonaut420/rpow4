import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { MeResponse } from '@rpow/shared';

/**
 * `loading` is the first-fetch flag only — it stays true until the
 * very first /me response arrives, then never flips back. Subsequent
 * `refresh()` calls update `me` in place without re-triggering loading,
 * so background polling (e.g. mid-mining) doesn't make the page flicker
 * to a "loading..." placeholder every refresh.
 */
export function useMe(): { me: MeResponse | null; loading: boolean; refresh: () => Promise<void> } {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async (): Promise<void> => {
    try { setMe(await api.me()); } catch { setMe(null); }
  };
  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);
  return { me, loading, refresh };
}
