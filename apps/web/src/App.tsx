import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes, NavLink } from 'react-router-dom';
import { applyTheme, loadTheme, nextTheme, type Theme } from './theme.js';
import { useMe } from './hooks/useMe.js';
import { useWallet } from './wallet/WalletProvider.js';
import { api } from './api.js';
import { LoginPage } from './pages/Login.js';
import { WalletPage } from './pages/Wallet.js';
import { MinePage } from './pages/Mine.js';
import { SendPage } from './pages/Send.js';
import { ActivityPage } from './pages/Activity.js';
import { LedgerPage } from './pages/Ledger.js';
import { StatsPage } from './pages/Stats.js';
import { ExplorerPage } from './pages/Explorer.js';
import { FaucetPage } from './pages/Faucet.js';
import { CopyButton } from './components/CopyButton.js';
import { SupplyBar } from './components/SupplyBar.js';
import { shortPubkey } from '@rpow/shared';

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
      <div className="app-shell">
        <header>
          <pre style={{ margin: 0 }}>{HEADER}</pre>
          <SupplyBar />
          <div className="tagline">a modern tribute to a tribute to the original rpow by hal finney</div>
          <nav style={{ marginTop: 8 }}>
            <NavLink to="/">[ wallet ]</NavLink>{' '}
            <NavLink to="/mine">[ mine ]</NavLink>{' '}
            <NavLink to="/send">[ send ]</NavLink>{' '}
            <NavLink to="/activity">[ activity ]</NavLink>{' '}
            <NavLink to="/ledger">[ ledger ]</NavLink>{' '}
            <NavLink to="/stats">[ stats ]</NavLink>{' '}
            <NavLink to="/explorer">[ explorer ]</NavLink>{' '}
            <NavLink to="/faucet">[ faucet ]</NavLink>{' '}
            {signedIn ? (
              <>
                <span style={{ color: 'var(--dim)' }} title={me!.pubkey}>
                  · <code>{me!.display_name ?? shortPubkey(me!.pubkey)}</code>
                </span>{' '}
                <CopyButton text={me!.pubkey} title="copy pubkey" />{' '}
                <button onClick={logout} title="end session and lock wallet (encrypted backup is preserved)">[ logout ]</button>
              </>
            ) : (
              <NavLink to="/login">[ login ]</NavLink>
            )}
            {' · '}
            <button onClick={() => setTheme(nextTheme(theme))} title="cycle theme">[ theme: {theme} ]</button>
          </nav>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<WalletPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/mine" element={<MinePage />} />
            <Route path="/send" element={<SendPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/ledger" element={<LedgerPage />} />
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/explorer" element={<ExplorerPage />} />
            <Route path="/explorer/tx/:id" element={<ExplorerPage />} />
            <Route path="/explorer/account/:pubkey" element={<ExplorerPage />} />
            <Route path="/faucet" element={<FaucetPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
