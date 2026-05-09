import { useNavigate, Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { usePageMeta } from '../hooks/usePageMeta.js';
import { CopyButton } from '../components/CopyButton.js';
import { DisplayNameEditor } from '../components/DisplayNameEditor.js';
import { SaveWalletPrompt } from '../components/SaveWalletPrompt.js';
import { WalletBackupPanel } from '../components/WalletBackupPanel.js';
import { useMe } from '../hooks/useMe.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { api } from '../api.js';
import { formatRpow } from '../lib/format.js';

function WalletHistoryBlurb() {
  return (
    <Panel title="WALLET ORIGINS">
      <div style={{ color: 'var(--dim)', fontSize: 12, lineHeight: 1.6 }}>
        In the earliest Bitcoin releases, the wallet was not a separate app or
        browser extension. The node, miner, and wallet were one program:
        <code style={{ color: 'var(--fg)' }}> bitcoin-qt</code> held keys, talked
        to peers, validated the chain, and mined blocks. Running Bitcoin meant
        carrying the whole stack locally.
        <br /><br />
        Later, wallets split away from full nodes and mining rigs. Seed phrases
        made key backup human-portable: BIP-39 standardized mnemonic words that
        derive a wallet seed, so the important thing to preserve became a short
        phrase instead of a raw private key file. RPOW4 follows that modern
        pattern: your browser holds the signing keys; the public ledger only sees
        the signatures.
      </div>
    </Panel>
  );
}

export function WalletPage() {
  usePageMeta('Wallet', 'Manage your RPOW4 wallet. View your balance, public key, and account details.');
  const wallet = useWallet();
  const { me, loading, refresh } = useMe();
  const nav = useNavigate();

  if (wallet.status === 'loading' || loading) return <Panel><div>loading...</div></Panel>;

  if (wallet.status !== 'unlocked' || !me) {
    return (
      <>
        <Panel title="WALLET">
          <div>not signed in.</div>
          <div style={{ marginTop: 8 }}>
            <Link to="/login">[ {wallet.status === 'locked' ? 'unlock wallet' : 'create or import wallet'} ]</Link>
          </div>
        </Panel>
        <WalletHistoryBlurb />
      </>
    );
  }

  async function logout() {
    try { await api.logout(); } catch { /* tolerate stale/expired session */ }
    wallet.lock();
    await refresh();
  }

  async function wipeLocal() {
    const ok = window.confirm(
      'Wipe the locally-stored wallet on THIS device?\n\n' +
      'You will need your mnemonic / private key to recover. ' +
      'Server ledger balance is unaffected — anyone holding the same ' +
      'keypair can still sign in.',
    );
    if (!ok) return;
    try { await api.logout(); } catch { /* ignore */ }
    await wallet.forget();
    await refresh();
    nav('/login');
  }

  return (
    <>
      <SaveWalletPrompt />
      <Panel title="WALLET">
        <pre style={{ margin: 0 }}>
{`  > BALANCE     : ${formatRpow(me.balance_base_units)} RPOW
  > MINTED      : ${formatRpow(me.minted_base_units)}
  > SENT        : ${formatRpow(me.sent_base_units)}
  > RECEIVED    : ${formatRpow(me.received_base_units)}
`}
        </pre>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ color: 'var(--dim)' }}>PUBKEY :</span>
          <code style={{ wordBreak: 'break-all' }}>{me.pubkey}</code>
          <CopyButton text={me.pubkey} />
        </div>
        <div style={{ marginTop: 8 }}>
          <DisplayNameEditor current={me.display_name} onChanged={refresh} />
        </div>
        <div style={{ marginTop: 12 }}>
          <Link to="/mine">[ MINE ]</Link>{' '}
          <Link to="/send">[ SEND ]</Link>{' '}
          <Link to="/activity">[ ACTIVITY ]</Link>{' '}
          <button onClick={logout} title="end session and lock wallet (encrypted backup is preserved)">
            [ LOGOUT ]
          </button>
        </div>
      </Panel>

      <WalletHistoryBlurb />

      <Panel title="BACKUP / RECOVERY">
        <div style={{ color: 'var(--dim)', fontSize: 12, marginBottom: 8 }}>
          your seed phrase is the only way to recover this wallet on another
          device. there is no
          server-side reset.
        </div>
        <WalletBackupPanel />
        <div style={{ marginTop: 16, paddingTop: 10, borderTop: '1px solid var(--dimmer)' }}>
          <button onClick={wipeLocal} title="remove the encrypted blob from this browser">
            [ wipe local wallet ]
          </button>{' '}
          <span style={{ color: 'var(--dim)', fontSize: 12 }}>
            removes the encrypted blob from this browser. ledger balance is
            untouched — re-import the same mnemonic to regain
            access.
          </span>
        </div>
      </Panel>
    </>
  );
}
