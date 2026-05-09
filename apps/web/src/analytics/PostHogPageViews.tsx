import { useEffect } from 'react';
import { usePostHog } from '@posthog/react';
import { useLocation } from 'react-router-dom';

/**
 * Manual `$pageview` for SPA navigation (HashRouter does not trigger full page loads).
 */
export function PostHogPageViews() {
  const posthog = usePostHog();
  const location = useLocation();

  useEffect(() => {
    if (!posthog) return;
    posthog.capture('$pageview', {
      $current_url: window.location.href,
    });
  }, [posthog, location.pathname, location.search, location.hash]);

  return null;
}
