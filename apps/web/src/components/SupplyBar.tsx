import { useEffect, useState } from 'react';
import { api } from '../api.js';

const POLL_MS = 15_000;

function fmtCompact(baseUnits: string | bigint): string {
  const bu = typeof baseUnits === 'bigint' ? baseUnits : BigInt(baseUnits);
  const rpow = Number(bu) / 1e9;
  if (rpow >= 1_000_000) return `${(rpow / 1_000_000).toFixed(2)}M`;
  if (rpow >= 1_000) return `${(rpow / 1_000).toFixed(1)}K`;
  if (rpow >= 1) return rpow.toFixed(2);
  return '<1';
}

export function SupplyBar() {
  const [minted, setMinted] = useState<string | null>(null);
  const [max, setMax] = useState<string | null>(null);
  const [blockHeight, setBlockHeight] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    function poll() {
      api.ledger()
        .then((r) => {
          if (cancelled) return;
          setMinted(r.minted_supply_counter_base_units);
          setMax(r.max_supply_base_units);
          setBlockHeight(r.block_height);
        })
        .catch(() => {});
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!minted || !max) return null;

  const pctInt = Number(BigInt(minted) * 100_00n / BigInt(max));
  const pct = pctInt / 100;
  const pctStr = pct < 0.01 ? '<0.01%' : `${pct.toFixed(2)}%`;
  const fill = Math.min(pct, 100);
  const remaining = BigInt(max) - BigInt(minted);

  return (
    <div style={{ margin: '10px 0 8px', userSelect: 'none' }}>
      {/* Label + percentage */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: 6,
      }}>
        <span style={{ fontSize: 11, color: 'var(--dim)', letterSpacing: '0.1em' }}>
          SUPPLY MINED
        </span>
        <span style={{ fontSize: 22, fontWeight: 'bold', color: 'var(--accent)', letterSpacing: '0.04em', lineHeight: 1 }}>
          {pctStr}
        </span>
      </div>

      {/* Bar */}
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

      {/* Stats */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginTop: 5,
        fontSize: 11,
        color: 'var(--dim)',
        letterSpacing: '0.03em',
      }}>
        <span>
          {fmtCompact(minted)} mined &nbsp;·&nbsp; {fmtCompact(remaining)} remaining
        </span>
        <span>
          21M RPOW max supply{blockHeight ? ` · block #${blockHeight}` : ''}
        </span>
      </div>
    </div>
  );
}
