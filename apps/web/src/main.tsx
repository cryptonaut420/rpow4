import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PostHogProvider } from '@posthog/react';
import App from './App.js';
import { PostHogIdentify } from './analytics/PostHogIdentify.js';
import { posthogClient } from './analytics/posthogClient.js';
import { WalletProvider } from './wallet/WalletProvider.js';

const tree = posthogClient ? (
  <PostHogProvider client={posthogClient}>
    <WalletProvider>
      <PostHogIdentify />
      <App />
    </WalletProvider>
  </PostHogProvider>
) : (
  <WalletProvider>
    <App />
  </WalletProvider>
);

createRoot(document.getElementById('root')!).render(<StrictMode>{tree}</StrictMode>);
