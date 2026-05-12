import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { CopyButton } from '../components/CopyButton.js';
import { usePageMeta } from '../hooks/usePageMeta.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { useMe } from '../hooks/useMe.js';
import { api, type AssetSummary } from '../api.js';
import { formatRpow } from '../lib/format.js';
import { useAsset } from '../assets/AssetProvider.js';

const LAUNCH_BURN_BASE_UNITS = '10000000000000';

const DEFAULTS = {
  reward: '50',
  rewardInterval: 210000,
  difficultyStart: 24,
  difficultyStep: 50000,
  difficultyMax: 50,
  poolFeeBps: 200,
  poolFinderBps: 2500,
  poolShareBits: 24,
};

// Mining algorithms exposed in the launch form. Only `rpow_classic` is
// implemented today (and is the only value the server accepts), but we
// surface the other slots as disabled options so creators can see the
// architecture is pluggable. Add a new algo here AND register it on the
// server (`assets` zod schema + challenge dispatcher) to unlock it.
const MINING_ALGOS: Array<{ value: string; label: string; available: boolean }> = [
  { value: 'rpow_classic', label: 'rpow_classic (sha-256 hashcash)', available: true },
  { value: 'keccak256', label: 'keccak256 (coming soon)', available: false },
  { value: 'scrypt', label: 'scrypt (coming soon)', available: false },
  { value: 'randomx', label: 'randomx (coming soon)', available: false },
];

function toBaseUnits(whole: string): string | null {
  const trimmed = whole.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(trimmed)) return null;
  const [intPart, fracPart = ''] = trimmed.split('.');
  const padded = (fracPart + '000000000').slice(0, 9);
  return (BigInt(intPart || '0') * 1_000_000_000n + BigInt(padded || '0')).toString();
}

function safeBaseUnits(whole: string, fallback: string): string {
  return toBaseUnits(whole) ?? fallback;
}

function shareUrl(slug: string): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#/r/${slug}`;
}

export function LaunchRpowPage() {
  usePageMeta('Launch New RPOW', 'Create a custom mineable RPOW asset.');
  const wallet = useWallet();
  const { me } = useMe();
  const { refreshAssets, assetPath } = useAsset();
  const nav = useNavigate();
  const signedIn = wallet.status === 'unlocked' && !!me;

  const [nickname, setNickname] = useState('');
  const [description, setDescription] = useState('');
  const [supplyMode, setSupplyMode] = useState<'capped' | 'unlimited'>('capped');
  const [maxSupplyWhole, setMaxSupplyWhole] = useState('21000000');
  const [rewardWhole, setRewardWhole] = useState(DEFAULTS.reward);
  const [rewardSchedule, setRewardSchedule] = useState<'halving_by_blocks' | 'none'>('halving_by_blocks');
  const [rewardInterval, setRewardInterval] = useState<number>(DEFAULTS.rewardInterval);
  const [difficultyStart, setDifficultyStart] = useState<number>(DEFAULTS.difficultyStart);
  const [difficultyStep, setDifficultyStep] = useState<number>(DEFAULTS.difficultyStep);
  const [difficultyMax, setDifficultyMax] = useState<number>(DEFAULTS.difficultyMax);
  const [miningAlgo, setMiningAlgo] = useState<string>('rpow_classic');
  const [poolEnabled, setPoolEnabled] = useState(true);
  const [poolThreshold, setPoolThreshold] = useState('');
  const [founderWhole, setFounderWhole] = useState('0');
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [launched, setLaunched] = useState<AssetSummary | null>(null);

  const balance = useMemo(() => (me ? BigInt(me.balance_base_units) : 0n), [me]);
  const launchFee = BigInt(LAUNCH_BURN_BASE_UNITS);
  const hasBurnFunds = balance >= launchFee;

  const maxSupplyBase = useMemo(
    () => (supplyMode === 'capped' ? toBaseUnits(maxSupplyWhole) : null),
    [supplyMode, maxSupplyWhole],
  );
  const founderBase = toBaseUnits(founderWhole) ?? '0';
  const founderPreview = BigInt(founderBase);
  const treasuryPreview = founderPreview / 10n;
  const creatorPreview = founderPreview - treasuryPreview;

  // Live form-level validation. We keep this defensive on the client so
  // users get immediate feedback; the server is the authoritative gatekeeper.
  const errors: string[] = [];
  if (nickname.trim().length > 0 && nickname.trim().length < 3) errors.push('nickname must be at least 3 chars');
  if (description.length > 280) errors.push('description max 280 chars');
  if (supplyMode === 'capped' && maxSupplyBase === null) errors.push('max supply must be a positive whole number');
  if (toBaseUnits(rewardWhole) === null) errors.push('starting reward must be a number');
  if (!Number.isFinite(rewardInterval) || rewardInterval <= 0) errors.push('reward interval must be > 0 blocks');
  if (difficultyStart < 4 || difficultyStart > 64) errors.push('starting difficulty must be 4–64 bits');
  if (difficultyMax < difficultyStart) errors.push('max difficulty must be ≥ starting difficulty');
  if (difficultyMax > 64) errors.push('max difficulty must be ≤ 64 bits');
  if (difficultyStep <= 0) errors.push('difficulty step must be > 0 blocks');
  if (poolThreshold && (Number(poolThreshold) < 4 || Number(poolThreshold) > difficultyMax)) {
    errors.push('pool threshold must be between 4 and the max difficulty');
  }
  if (supplyMode === 'unlimited' && founderPreview > 0n) errors.push('founder allocation requires a capped supply');
  if (supplyMode === 'capped' && maxSupplyBase) {
    const maxAllocation = (BigInt(maxSupplyBase) * 20n) / 100n;
    if (founderPreview > maxAllocation) errors.push('founder allocation cannot exceed 20% of max supply');
  }

  if (!signedIn) {
    return (
      <Panel title="LAUNCH NEW RPOW">
        <div style={{ color: 'var(--dim)', marginBottom: 8 }}>
          you need to login before launching a new mineable rpow.
        </div>
        <div>
          <Link to={`/login?returnTo=${encodeURIComponent(assetPath('/launch'))}`}>[ login to launch ]</Link>
        </div>
      </Panel>
    );
  }

  if (launched) {
    const url = shareUrl(launched.slug);
    return (
      <Panel title="ASSET LAUNCHED">
        <pre style={{ margin: 0 }}>
{`  > ${launched.display_code} :: ${launched.nickname}
  > slug          : ${launched.slug}
  > supply mode   : ${launched.supply_mode}
  > burn paid     : ${formatRpow(LAUNCH_BURN_BASE_UNITS)} RPOW4
  > mining algo   : ${launched.mining_algo}`}
        </pre>
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px dashed var(--accent-dim)' }}>
          <div style={{ color: 'var(--dim)', fontSize: 12, marginBottom: 6 }}>
            share this link so others can mine it:
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <code style={{ wordBreak: 'break-all', fontSize: 12 }}>{url}</code>
            <CopyButton text={url} />
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <button onClick={() => nav(`/r/${launched.slug}`)}>[ open {launched.display_code} ]</button>{' '}
          <button onClick={() => { setLaunched(null); setNickname(''); setDescription(''); }}>
            [ launch another ]
          </button>
        </div>
      </Panel>
    );
  }

  async function submit() {
    if (errors.length > 0 || !hasBurnFunds) return;
    setSubmitting(true);
    setStatus('');
    try {
      const res = await api.launchAsset({
        nickname: nickname.trim(),
        description: description.trim(),
        supply_mode: supplyMode,
        ...(maxSupplyBase ? { max_supply_base_units: maxSupplyBase } : {}),
        initial_reward_base_units: safeBaseUnits(rewardWhole, '50000000000'),
        reward_schedule_type: rewardSchedule,
        reward_interval_blocks: rewardInterval,
        difficulty_start_bits: difficultyStart,
        difficulty_step_blocks: difficultyStep,
        difficulty_max_bits: difficultyMax,
        mining_algo: miningAlgo as 'rpow_classic',
        pool_enabled: poolEnabled,
        pool_enable_at_difficulty_bits: poolThreshold ? Number(poolThreshold) : null,
        pool_fee_bps: DEFAULTS.poolFeeBps,
        pool_finder_bps: DEFAULTS.poolFinderBps,
        pool_share_bits: DEFAULTS.poolShareBits,
        founder_allocation_base_units: founderBase,
      });
      await refreshAssets();
      setLaunched(res.asset);
    } catch (e: any) {
      setStatus(e?.message ?? e?.error ?? 'launch failed');
    } finally {
      setSubmitting(false);
    }
  }

  const submitDisabled =
    submitting || nickname.trim().length < 3 || errors.length > 0 || !hasBurnFunds;

  return (
    <>
      <Panel title="LAUNCH NEW RPOW">
        <div style={{ color: 'var(--dim)', marginBottom: 12, fontSize: 12, lineHeight: 1.6 }}>
          Burn <strong style={{ color: 'var(--fg)' }}>{formatRpow(LAUNCH_BURN_BASE_UNITS)} RPOW4</strong>{' '}
          to mint a new mineable asset family. The defaults below mirror RPOW4.0
          (21M cap, 50-RPOW reward, 210k-block halving). Anything you change is
          locked into your asset's tokenomics — there is no edit-after-launch.
          {hasBurnFunds ? null : (
            <div style={{ color: 'var(--error)', marginTop: 8 }}>
              you need at least {formatRpow(LAUNCH_BURN_BASE_UNITS)} RPOW4 to launch
              (current balance: {formatRpow(me!.balance_base_units)} RPOW4).
            </div>
          )}
        </div>

        <div className="form-grid">
          <label>
            nickname
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="e.g. Laser Beans"
              maxLength={40}
            />
          </label>
          <label>
            description
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={280}
              placeholder="optional, up to 280 chars"
            />
          </label>
          <label>
            supply
            <select value={supplyMode} onChange={(e) => setSupplyMode(e.target.value as 'capped' | 'unlimited')}>
              <option value="capped">capped (default)</option>
              <option value="unlimited">unlimited</option>
            </select>
          </label>
          {supplyMode === 'capped' ? (
            <label>
              max supply (whole {nickname.trim() || 'RPOW'})
              <input value={maxSupplyWhole} onChange={(e) => setMaxSupplyWhole(e.target.value)} />
            </label>
          ) : null}
          <label>
            starting reward (whole / block)
            <input value={rewardWhole} onChange={(e) => setRewardWhole(e.target.value)} />
          </label>
          <label>
            reward schedule
            <select
              value={rewardSchedule}
              onChange={(e) => setRewardSchedule(e.target.value as 'halving_by_blocks' | 'none')}
            >
              <option value="halving_by_blocks">halve every interval (Bitcoin-style)</option>
              <option value="none">no reduction (constant reward)</option>
            </select>
          </label>
          {rewardSchedule === 'halving_by_blocks' ? (
            <label>
              halving interval (blocks)
              <input
                type="number"
                value={rewardInterval}
                min={1}
                onChange={(e) => setRewardInterval(Number(e.target.value))}
              />
            </label>
          ) : null}
          <label>
            starting difficulty (bits)
            <input
              type="number"
              value={difficultyStart}
              min={4}
              max={64}
              onChange={(e) => setDifficultyStart(Number(e.target.value))}
            />
          </label>
          <label>
            difficulty step (blocks per +1 bit)
            <input
              type="number"
              value={difficultyStep}
              min={1}
              onChange={(e) => setDifficultyStep(Number(e.target.value))}
            />
          </label>
          <label>
            max difficulty (bits)
            <input
              type="number"
              value={difficultyMax}
              min={4}
              max={64}
              onChange={(e) => setDifficultyMax(Number(e.target.value))}
            />
          </label>
          <label>
            mining algo
            <select value={miningAlgo} onChange={(e) => setMiningAlgo(e.target.value)}>
              {MINING_ALGOS.map((a) => (
                <option key={a.value} value={a.value} disabled={!a.available}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            pool mining
            <select
              value={poolEnabled ? 'yes' : 'no'}
              onChange={(e) => setPoolEnabled(e.target.value === 'yes')}
            >
              <option value="yes">enabled</option>
              <option value="no">disabled</option>
            </select>
          </label>
          {poolEnabled ? (
            <label>
              enable pool at difficulty
              <input
                value={poolThreshold}
                onChange={(e) => setPoolThreshold(e.target.value)}
                placeholder="optional, e.g. 28"
              />
            </label>
          ) : null}
          {supplyMode === 'capped' ? (
            <label>
              founder allocation (whole, max 20% of supply)
              <input value={founderWhole} onChange={(e) => setFounderWhole(e.target.value)} />
            </label>
          ) : null}
        </div>

        <pre style={{ marginTop: 14 }}>
{`  > launch burn      : ${formatRpow(LAUNCH_BURN_BASE_UNITS)} RPOW4 (irreversible)
  > creator genesis  : ${formatRpow(creatorPreview.toString())} (90% of allocation)
  > treasury cut     : ${formatRpow(treasuryPreview.toString())} (10% of allocation)
  > supply           : ${supplyMode === 'unlimited' ? 'uncapped' : `${maxSupplyWhole} whole units max`}
  > reward schedule  : ${rewardSchedule === 'none' ? 'constant ' + rewardWhole + ' / block' : `${rewardWhole} / block, halves every ${rewardInterval.toLocaleString()} blocks`}
  > difficulty curve : ${difficultyStart} → ${difficultyMax} bits, +1 every ${difficultyStep.toLocaleString()} blocks
  > pool mining      : ${poolEnabled ? `enabled${poolThreshold ? ` at ≥${poolThreshold} bits` : ''}` : 'disabled'}
  > mining algo      : ${miningAlgo}`}
        </pre>

        {errors.length > 0 ? (
          <ul style={{ marginTop: 10, color: 'var(--error)', fontSize: 12, paddingLeft: 18 }}>
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        ) : null}
        {status ? <div className="error" style={{ marginTop: 8 }}>error: {status}</div> : null}

        <div style={{ marginTop: 12 }}>
          <button onClick={submit} disabled={submitDisabled}>
            [ {submitting ? 'launching...' : 'burn + launch'} ]
          </button>
        </div>
      </Panel>
    </>
  );
}
