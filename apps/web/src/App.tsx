import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes, NavLink } from 'react-router-dom';
import { applyTheme, loadTheme, nextTheme, type Theme } from './theme.js';
import { useMe } from './hooks/useMe.js';
import { useWallet } from './wallet/WalletProvider.js';
import { api } from './api.js';
import { LoginPage } from './pages/Login.js';
import { WalletPage } from './pages/Wallet.js';
import { SendPage } from './pages/Send.js';
import { ActivityPage } from './pages/Activity.js';
import { LedgerPage } from './pages/Ledger.js';
import { StatsPage } from './pages/Stats.js';
import { ExplorerPage } from './pages/Explorer.js';
import { FaucetPage } from './pages/Faucet.js';
import { TrollboxPage } from './pages/Trollbox.js';
import { DocsPage } from './pages/Docs.js';
import { HistoryPage } from './pages/History.js';
import { ClaimPage } from './pages/Claim.js';
import { RedeemPage } from './pages/Redeem.js';
import { EcosystemPage } from './pages/Ecosystem.js';
import { PoolHistoryPage } from './pages/PoolHistory.js';
import { LaunchRpowPage } from './pages/LaunchRpow.js';
import { CopyButton } from './components/CopyButton.js';
import { AssetBar } from './components/AssetBar.js';
import { ScrollToTop } from './components/ScrollToTop.js';
import { SupplyBar } from './components/SupplyBar.js';
import { MiningBar } from './components/MiningBar.js';
import { MiningProvider } from './mining/MiningProvider.js';
import { AssetProvider, useAsset } from './assets/AssetProvider.js';
import { shortPubkey } from '@rpow/shared';
import { POSTHOG_ENABLED } from './analytics/posthogClient.js';
import { PostHogPageViews } from './analytics/PostHogPageViews.js';

const HEADER = [
  '+======================================================================+',
  '|                   RPOW4 - Reusable Proofs of Work                    |',
  '+======================================================================+',
].join('\n');

export default function App() {
  return (
    <HashRouter>
      {POSTHOG_ENABLED ? <PostHogPageViews /> : null}
      <AssetProvider>
        <AppShell />
      </AssetProvider>
    </HashRouter>
  );
}

function AppShell() {
  const [theme, setTheme] = useState<Theme>(loadTheme());
  useEffect(() => { applyTheme(theme); }, [theme]);
  const wallet = useWallet();
  const { selectedAsset, selectedSlug, assetPath, isDefaultAsset } = useAsset();
  const { me } = useMe(selectedSlug);

  async function logout() {
    try { await api.logout(); } catch { /* ignore */ }
    wallet.lock();
    window.location.href = '/';
  }

  const signedIn = wallet.status === 'unlocked' && !!me;

  return (
      <MiningProvider>
      <div className="app-shell">
        <header>
          <pre style={{ margin: 0 }}>{HEADER}</pre>
          <SupplyBar />
          <div className="tagline">
            {selectedAsset
              ? `${selectedAsset.display_code} :: ${selectedAsset.nickname}`
              : 'a modern tribute to a tribute to the original rpow by hal finney'}
          </div>
          <AssetBar />
          <nav className="primary-nav" aria-label="primary">
            <div className="nav-group">
              <span className="nav-group-label">wallet</span>
              <NavLink to={assetPath('/')}>[ home ]</NavLink>
              <NavLink to={assetPath('/send')}>[ send ]</NavLink>
              {/* Bearer claim tokens are an RPOW4.0-only feature for now. */}
              {isDefaultAsset ? <NavLink to="/claim">[ claim ]</NavLink> : null}
              <NavLink to={assetPath('/activity')}>[ activity ]</NavLink>
            </div>
            <div className="nav-group">
              <span className="nav-group-label">network</span>
              <NavLink to={assetPath('/stats')}>[ stats ]</NavLink>
              <NavLink to={assetPath('/explorer')}>[ explorer ]</NavLink>
              {isDefaultAsset ? <NavLink to="/faucet">[ faucet ]</NavLink> : null}
              {isDefaultAsset ? <NavLink to="/trollbox">[ trollbox ]</NavLink> : null}
            </div>
            <div className="nav-group">
              <span className="nav-group-label">info</span>
              <NavLink to="/ledger">[ about ]</NavLink>
              <NavLink to="/history">[ history ]</NavLink>
              <NavLink to="/docs">[ docs ]</NavLink>
              <NavLink to="/ecosystem">[ ecosystem ]</NavLink>
            </div>
            <div className="nav-group">
              <span className="nav-group-label">links</span>
              <a href="https://rpowmarket.com/" target="_blank" rel="noopener noreferrer">[ predict ↗ ]</a>
            </div>
          </nav>
          <div className="utility-bar" aria-label="session controls">
            {signedIn ? (
              <>
                <span className="utility-user" title={me!.pubkey}>
                  <code>{me!.display_name ?? shortPubkey(me!.pubkey)}</code>
                </span>
                <CopyButton text={me!.pubkey} title="copy pubkey" />
                <button onClick={logout} title="end session and lock wallet (encrypted backup is preserved)">[ logout ]</button>
              </>
            ) : (
              <NavLink to="/login">[ login ]</NavLink>
            )}
            <span className="utility-sep">·</span>
            <button onClick={() => setTheme(nextTheme(theme))} title="cycle theme">[ theme: {theme} ]</button>
          </div>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<WalletPage />} />
            <Route path="/r/:assetSlug" element={<WalletPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/r/:assetSlug/login" element={<LoginPage />} />
            <Route path="/launch" element={<LaunchRpowPage />} />
            <Route path="/r/:assetSlug/launch" element={<LaunchRpowPage />} />
            <Route path="/send" element={<SendPage />} />
            <Route path="/r/:assetSlug/send" element={<SendPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/r/:assetSlug/activity" element={<ActivityPage />} />
            <Route path="/ledger" element={<LedgerPage />} />
            <Route path="/r/:assetSlug/ledger" element={<LedgerPage />} />
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/r/:assetSlug/stats" element={<StatsPage />} />
            <Route path="/explorer" element={<ExplorerPage />} />
            <Route path="/r/:assetSlug/explorer" element={<ExplorerPage />} />
            <Route path="/explorer/tx/:id" element={<ExplorerPage />} />
            <Route path="/r/:assetSlug/explorer/tx/:id" element={<ExplorerPage />} />
            <Route path="/explorer/account/:pubkey" element={<ExplorerPage />} />
            <Route path="/r/:assetSlug/explorer/account/:pubkey" element={<ExplorerPage />} />
            <Route path="/faucet" element={<FaucetPage />} />
            <Route path="/trollbox" element={<TrollboxPage />} />
            <Route path="/claim" element={<ClaimPage />} />
            <Route path="/redeem/:id" element={<RedeemPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/docs" element={<DocsPage />} />
            <Route path="/ecosystem" element={<EcosystemPage />} />
            <Route path="/pool/history" element={<PoolHistoryPage />} />
            <Route path="/r/:assetSlug/pool/history" element={<PoolHistoryPage />} />
          </Routes>
        </main>
        <footer className="app-footer">
          <a
            href="https://github.com/cryptonaut420/rpow4"
            target="_blank"
            rel="noopener noreferrer"
            title="rpow4 on github"
          >
            [ github ]
          </a>
        </footer>
      </div>
      <MiningBar />
      <ScrollToTop />
      </MiningProvider>
  );
}
