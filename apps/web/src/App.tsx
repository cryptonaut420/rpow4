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
import { CopyButton } from './components/CopyButton.js';
import { SupplyBar } from './components/SupplyBar.js';
import { MiningBar } from './components/MiningBar.js';
import { MiningProvider } from './mining/MiningProvider.js';
import { shortPubkey } from '@rpow/shared';
import { POSTHOG_ENABLED } from './analytics/posthogClient.js';
import { PostHogPageViews } from './analytics/PostHogPageViews.js';

const HEADER = [
  '+======================================================================+',
  '|                   RPOW4 - Reusable Proofs of Work                    |',
  '+======================================================================+',
].join('\n');

export default function App() {
  const [theme, setTheme] = useState<Theme>(loadTheme());
  useEffect(() => { applyTheme(theme); }, [theme]);
  const wallet = useWallet();
  const { me } = useMe();

  async function logout() {
    try { await api.logout(); } catch { /* ignore */ }
    wallet.lock();
    window.location.href = '/';
  }

  const signedIn = wallet.status === 'unlocked' && !!me;

  return (
    <HashRouter>
      {POSTHOG_ENABLED ? <PostHogPageViews /> : null}
      <MiningProvider>
      <div className="app-shell">
        <header>
          <pre style={{ margin: 0 }}>{HEADER}</pre>
          <SupplyBar />
          <div className="tagline">a modern tribute to a tribute to the original rpow by hal finney</div>
          <nav className="primary-nav" aria-label="primary">
            <div className="nav-group">
              <span className="nav-group-label">wallet</span>
              <NavLink to="/">[ home ]</NavLink>
              <NavLink to="/send">[ send ]</NavLink>
              <NavLink to="/claim">[ claim ]</NavLink>
              <NavLink to="/activity">[ activity ]</NavLink>
            </div>
            <div className="nav-group">
              <span className="nav-group-label">network</span>
              <NavLink to="/stats">[ stats ]</NavLink>
              <NavLink to="/explorer">[ explorer ]</NavLink>
              <NavLink to="/faucet">[ faucet ]</NavLink>
              <NavLink to="/trollbox">[ trollbox ]</NavLink>
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
            <Route path="/login" element={<LoginPage />} />
            <Route path="/send" element={<SendPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/ledger" element={<LedgerPage />} />
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/explorer" element={<ExplorerPage />} />
            <Route path="/explorer/tx/:id" element={<ExplorerPage />} />
            <Route path="/explorer/account/:pubkey" element={<ExplorerPage />} />
            <Route path="/faucet" element={<FaucetPage />} />
            <Route path="/trollbox" element={<TrollboxPage />} />
            <Route path="/claim" element={<ClaimPage />} />
            <Route path="/redeem/:id" element={<RedeemPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/docs" element={<DocsPage />} />
            <Route path="/ecosystem" element={<EcosystemPage />} />
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
      </MiningProvider>
    </HashRouter>
  );
}
