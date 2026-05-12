import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAsset } from '../assets/AssetProvider.js';

const POLL_MS = 15_000;

function fmtCompact(baseUnits: string | bigint): string {
  const bu = typeof baseUnits === 'bigint' ? baseUnits : BigInt(baseUnits);
  const rpow = Number(bu) / 1e9;
  if (rpow >= 1_000_000_000) return `${(rpow / 1_000_000_000).toFixed(2)}B`;
  if (rpow >= 1_000_000) return `${(rpow / 1_000_000).toFixed(2)}M`;
  if (rpow >= 1_000) return `${(rpow / 1_000).toFixed(1)}K`;
  if (rpow >= 1) return rpow.toFixed(2);
  if (rpow > 0) return '<1';
  return '0';
}

function formatCapLabel(maxBaseUnits: string): string {
  const n = BigInt(maxBaseUnits);
  const whole = Number(n / 1_000_000_000n);
  if (whole >= 1_000_000_000) return `${(whole / 1_000_000_000).toFixed(2)}B`;
  if (whole >= 1_000_000) return `${(whole / 1_000_000).toFixed(2)}M`;
  if (whole >= 1_000) return `${(whole / 1_000).toFixed(1)}K`;
  return whole.toString();
}

export function SupplyBar() {
  const { selectedSlug, selectedAsset } = useAsset();
  const [minted, setMinted] = useState<string | null>(null);
  const [burned, setBurned] = useState<string | null>(null);
  const [max, setMax] = useState<string | null>(null);
  const [supplyMode, setSupplyMode] = useState<'capped' | 'unlimited'>('capped');
  const [blockHeight, setBlockHeight] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Reset transient state so the bar doesn't show stale percentages from
    // the previously-selected asset while the next /ledger response is in
    // flight.
    setMinted(null);
    setBurned(null);
    setMax(null);
    setBlockHeight(null);

    function poll() {
      api.ledger(selectedSlug)
        .then((r) => {
          if (cancelled) return;
          setMinted(r.minted_supply_counter_base_units);
          setBurned(r.total_burned_base_units ?? '0');
          setMax(r.max_supply_base_units ?? null);
          setSupplyMode(r.supply_mode ?? 'capped');
          setBlockHeight(r.block_height);
        })
        .catch(() => {});
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [selectedSlug]);

  if (!minted) return null;

  const code = selectedAsset?.display_code ?? 'RPOW';
  const burnedBu = burned ? BigInt(burned) : 0n;
  const burnedFragment = burnedBu > 0n
    ? <> &nbsp;·&nbsp; {fmtCompact(burnedBu)} burned</>
    : null;

  // Unlimited assets: no percentage / cap bar. Show running total instead.
  if (supplyMode === 'unlimited' || !max) {
    return (
      <div style={{ margin: '10px 0 8px', userSelect: 'none' }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 6,
        }}>
          <span style={{ fontSize: 11, color: 'var(--dim)', letterSpacing: '0.1em' }}>
            {code} · SUPPLY MINED
          </span>
          <span style={{ fontSize: 22, fontWeight: 'bold', color: 'var(--accent)', letterSpacing: '0.04em', lineHeight: 1 }}>
            {fmtCompact(minted)}
          </span>
        </div>
        <div className="supply-stats" style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 5,
          fontSize: 11,
          color: 'var(--dim)',
          letterSpacing: '0.03em',
        }}>
          <span>{code} · uncapped supply{burnedFragment}</span>
          <span>{blockHeight ? `block #${blockHeight}` : ''}</span>
        </div>
      </div>
    );
  }

  const pctInt = Number(BigInt(minted) * 100_00n / BigInt(max));
  const pct = pctInt / 100;
  const pctStr = pct < 0.01 ? '<0.01%' : `${pct.toFixed(2)}%`;
  const fill = Math.min(pct, 100);
  const remaining = BigInt(max) - BigInt(minted);

  return (
    <div style={{ margin: '10px 0 8px', userSelect: 'none' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: 6,
      }}>
        <span style={{ fontSize: 11, color: 'var(--dim)', letterSpacing: '0.1em' }}>
          {code} · SUPPLY MINED
        </span>
        <span style={{ fontSize: 22, fontWeight: 'bold', color: 'var(--accent)', letterSpacing: '0.04em', lineHeight: 1 }}>
          {pctStr}
        </span>
      </div>

      <div style={{
        height: 8,
        background: 'var(--dimmer)',
        borderRadius: 2,
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${fill}%`,
          background: 'var(--accent)',
          boxShadow: '0 0 10px var(--accent)',
          transition: 'width 2s ease',
          borderRadius: 2,
        }} />
      </div>

      <div className="supply-stats" style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginTop: 5,
        fontSize: 11,
        color: 'var(--dim)',
        letterSpacing: '0.03em',
      }}>
        <span>
          {fmtCompact(minted)} mined &nbsp;·&nbsp; {fmtCompact(remaining)} remaining
          {burnedFragment}
        </span>
        <span>
          {formatCapLabel(max)} {code} max supply{blockHeight ? ` · block #${blockHeight}` : ''}
        </span>
      </div>
    </div>
  );
}
