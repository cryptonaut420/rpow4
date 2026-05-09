import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { WalletProvider } from './wallet/WalletProvider.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalletProvider>
      <App />
    </WalletProvider>
  </StrictMode>,
);
