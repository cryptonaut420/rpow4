import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { usePageMeta } from '../hooks/usePageMeta.js';
import { api } from '../api.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { useMe } from '../hooks/useMe.js';
import { formatRpow } from '../lib/format.js';
import type { ClaimStatusResponse } from '@rpow/shared';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; claim: ClaimStatusResponse };

export function RedeemPage() {
  usePageMeta('Redeem', 'Redeem a bearer claim token to your RPOW wallet.');
  const { id } = useParams<{ id: string }>();
  const wallet = useWallet();
  const { me, refresh } = useMe();

  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [redeeming, setRedeeming] = useState(false);
  const [redeemError, setRedeemError] = useState('');
  const [redeemed, setRedeemed] = useState<{ amount_base_units: string; transfer_id: string } | null>(null);

  useEffect(() => {
    if (!id) { setLoadState({ kind: 'not-found' }); return; }
    let cancelled = false;
    setLoadState({ kind: 'loading' });
    api.getClaim(id)
      .then((claim) => { if (!cancelled) setLoadState({ kind: 'ready', claim }); })
      .catch((err) => {
        if (cancelled) return;
        if (err?.error === 'NOT_FOUND') setLoadState({ kind: 'not-found' });
        else setLoadState({ kind: 'error', message: err?.message ?? 'failed to load claim' });
      });
    return () => { cancelled = true; };
  }, [id]);

  async function handleRedeem() {
    if (!id || loadState.kind !== 'ready' || loadState.claim.state !== 'pending') return;
    setRedeeming(true);
    setRedeemError('');
    try {
      const r = await api.redeemClaim(id);
      await refresh();
      setRedeemed({ amount_base_units: r.amount_base_units, transfer_id: r.transfer_id });
    } catch (err: any) {
      const code = err?.error ?? 'INTERNAL';
      const msgMap: Record<string, string> = {
        ALREADY_REDEEMED: 'this claim has already been redeemed',
        CLAIM_CANCELLED: 'this claim was cancelled by the sender',
        NOT_FOUND: 'claim not found',
        UNAUTHORIZED: 'session expired — sign in again',
        BAD_REQUEST: err?.message ?? 'bad request',
      };
      setRedeemError(msgMap[code] ?? (err?.message ?? code));
      // Reload the latest claim state so the UI reflects reality.
      if (id) {
        api.getClaim(id)
          .then((claim) => setLoadState({ kind: 'ready', claim }))
          .catch(() => {});
      }
    } finally {
      setRedeeming(false);
    }
  }

  return (
    <Panel title="REDEEM CLAIM TOKEN">
      {loadState.kind === 'loading' && (
        <div style={{ color: 'var(--dim)' }}>loading…</div>
      )}

      {loadState.kind === 'not-found' && (
        <div>
          <div className="error">claim not found — the link may be invalid.</div>
          <div style={{ marginTop: 8 }}>
            <Link to="/">[ home ]</Link>
          </div>
        </div>
      )}

      {loadState.kind === 'error' && (
        <div className="error">{loadState.message}</div>
      )}

      {redeemed ? (
        <div>
          <div style={{ color: 'var(--accent)', marginBottom: 8 }}>
            redeemed! <strong>{formatRpow(redeemed.amount_base_units)} RPOW</strong> added to your wallet.
          </div>
          <div style={{ fontSize: 12, color: 'var(--dim)' }}>
            transfer id: <code>{redeemed.transfer_id}</code>
          </div>
          <div style={{ marginTop: 12 }}>
            <Link to="/">[ go to wallet ]</Link>
            {' · '}
            <Link to="/activity">[ view activity ]</Link>
          </div>
        </div>
      ) : loadState.kind === 'ready' && (
        <ClaimView
          claim={loadState.claim}
          wallet={wallet}
          me={me}
          redeeming={redeeming}
          onRedeem={handleRedeem}
          redeemError={redeemError}
        />
      )}
    </Panel>
  );
}

interface ClaimViewProps {
  claim: ClaimStatusResponse;
  wallet: ReturnType<typeof useWallet>;
  me: ReturnType<typeof useMe>['me'];
  redeeming: boolean;
  onRedeem: () => void;
  redeemError: string;
}

function ClaimView({ claim, wallet, me, redeeming, onRedeem, redeemError }: ClaimViewProps) {
  const isPending = claim.state === 'pending';

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div>
          AMOUNT : <strong style={{ fontSize: 16 }}>{formatRpow(claim.amount_base_units)} RPOW</strong>
        </div>
        {claim.memo && (
          <div style={{ marginTop: 4, color: 'var(--dim)' }}>
            MEMO   : <em>&ldquo;{claim.memo}&rdquo;</em>
          </div>
        )}
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--dim)' }}>
          STATUS : <span style={{ color: isPending ? 'var(--accent)' : 'var(--dim)' }}>{claim.state}</span>
          {claim.redeemed_at && <> · redeemed {new Date(claim.redeemed_at).toLocaleString()}</>}
          {claim.cancelled_at && <> · cancelled {new Date(claim.cancelled_at).toLocaleString()}</>}
        </div>
        <div style={{ marginTop: 2, fontSize: 12, color: 'var(--dim)' }}>
          CREATED : {new Date(claim.created_at).toLocaleString()}
        </div>
      </div>

      {!isPending && (
        <div style={{ color: 'var(--dim)', fontSize: 13 }}>
          {claim.state === 'redeemed'
            ? 'this claim has already been redeemed.'
            : 'this claim was cancelled by the sender.'}
        </div>
      )}

      {isPending && wallet.status === 'unlocked' && me && (
        <div>
          <button
            type="button"
            disabled={redeeming}
            onClick={onRedeem}
            style={{ fontSize: 13, padding: '6px 14px' }}
          >
            [ {redeeming ? 'redeeming…' : `redeem to my account`} ]
          </button>
          <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 4 }}>
            signed in as{' '}
            <strong style={{ color: 'var(--fg)' }}>{me.display_name ?? `${me.pubkey.slice(0, 12)}…`}</strong>
          </div>
          {redeemError && (
            <div className="error" style={{ marginTop: 8 }}>error: {redeemError}</div>
          )}
        </div>
      )}

      {isPending && wallet.status !== 'unlocked' && (
        <div style={{ marginTop: 8 }}>
          <Link to="/login">
            [ sign in to redeem {formatRpow(claim.amount_base_units)} RPOW ]
          </Link>
        </div>
      )}
    </div>
  );
}
