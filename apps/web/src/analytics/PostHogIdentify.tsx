import { useEffect, useRef } from 'react';
import { usePostHog } from '@posthog/react';
import { useMe } from '../hooks/useMe.js';
import { useWallet } from '../wallet/WalletProvider.js';

/**
 * Links PostHog persons to the unlocked wallet pubkey (pseudonymous ID).
 * Only calls `reset()` after a prior `identify`, so anonymous visitors are not reset on every load.
 */
export function PostHogIdentify() {
  const posthog = usePostHog();
  const wallet = useWallet();
  const { me } = useMe();
  /** Set once we have called `identify` for this tab — cleared after `reset` on lock / forget. */
  const hadLinkedWallet = useRef(false);

  useEffect(() => {
    if (!posthog) return;
    if (wallet.status === 'loading') return;

    if (wallet.status === 'unlocked' && wallet.meta) {
      const pubkey = wallet.meta.pubkey;
      posthog.identify(pubkey, {
        pubkey,
        ...(me?.display_name ? { display_name: me.display_name } : {}),
      });
      hadLinkedWallet.current = true;
      return;
    }

    if (hadLinkedWallet.current) {
      posthog.reset();
      hadLinkedWallet.current = false;
    }
  }, [posthog, wallet.status, wallet.meta?.pubkey, me?.display_name]);

  return null;
}
