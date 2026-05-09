import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useWallet } from '../wallet/WalletProvider.js';
import type { MeResponse } from '@rpow/shared';

/**
 * `loading` is the first-fetch flag only — it stays true until the
 * very first /me response arrives, then never flips back. Subsequent
 * `refresh()` calls update `me` in place without re-triggering loading,
 * so background polling (e.g. mid-mining) doesn't make the page flicker
 * to a "loading..." placeholder every refresh.
 *
 * The hook is wallet-aware so every consumer (App nav, MiningProvider,
 * page-local copies) automatically picks up a fresh identity the moment
 * the wallet flips to 'unlocked' — no remount / page refresh required.
 */
export function useMe(): { me: MeResponse | null; loading: boolean; refresh: () => Promise<void> } {
  const wallet = useWallet();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async (): Promise<void> => {
    try { setMe(await api.me()); } catch { setMe(null); }
  };
  useEffect(() => {
    if (wallet.status === 'loading') return;
    if (wallet.status === 'unlocked') {
      refresh().finally(() => setLoading(false));
    } else {
      setMe(null);
      setLoading(false);
    }
  }, [wallet.status]);
  return { me, loading, refresh };
}
