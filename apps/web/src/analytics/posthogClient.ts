import posthog from 'posthog-js';

/**
 * PostHog is enabled only when `VITE_PUBLIC_POSTHOG_TOKEN` is set at build time.
 * Never commit real tokens — load from `.env` / CI secrets (see `.env.example`).
 */
const token = import.meta.env.VITE_PUBLIC_POSTHOG_TOKEN;
const host =
  import.meta.env.VITE_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

export const POSTHOG_ENABLED: boolean = typeof token === 'string' && token.length > 0;

/** Initialized client, or `null` when analytics are disabled. */
export const posthogClient: typeof posthog | null = (() => {
  if (typeof token !== 'string' || token.length === 0) return null;
  posthog.init(token, {
    api_host: host,
    defaults: '2026-01-30',
    /** HashRouter SPA: capture manually on route changes (see PostHogPageViews). */
    capture_pageview: false,
    persistence: 'localStorage+cookie',
  });
  return posthog;
})();
