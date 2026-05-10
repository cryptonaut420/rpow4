// Convert a stringified bigint in base units to a human-readable RPOW amount,
// with thousands separators on the whole part. 9 decimals; trims trailing
// zeros after the decimal point.
//
// Examples:
//   formatRpow('0')                → '0'
//   formatRpow('1000000000')       → '1'
//   formatRpow('7812500')          → '0.0078125'
//   formatRpow('500000000')        → '0.5'
//   formatRpow('1234567890000000') → '1,234,567.89'
export function formatRpow(baseUnits: string | bigint): string {
  const bu = typeof baseUnits === 'bigint' ? baseUnits : BigInt(baseUnits);
  const denom = 1_000_000_000n;
  const whole = bu / denom;
  const frac = bu % denom;
  const wholeStr = withThousands(whole.toString());
  if (frac === 0n) return wholeStr;
  const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
  return `${wholeStr}.${fracStr}`;
}

// Insert thousands separators into a non-negative integer string. Implemented
// by hand so we can call it from BigInt values that overflow Number safely.
function withThousands(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Pretty-print a non-RPOW count (block height, transfer count, blocks mined,
// event_seq, etc.) with locale-style thousands separators. Accepts string,
// number, or bigint.
export function formatCount(value: string | number | bigint): string {
  if (typeof value === 'bigint') return withThousands(value.toString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return value.toLocaleString('en-US');
  }
  // Numeric strings: format directly so we don't lose precision on values
  // that overflow Number's safe integer range (block_height can grow large).
  if (/^-?\d+$/.test(value)) {
    const negative = value.startsWith('-');
    const digits = negative ? value.slice(1) : value;
    return (negative ? '-' : '') + withThousands(digits);
  }
  return value;
}

// Inverse of formatRpow: parse a user-typed decimal RPOW string into a
// stringified bigint in base units. Tolerates thousands separators (commas)
// and leading/trailing whitespace so a value pre-filled by formatRpow round-
// trips cleanly through this parser. Throws on invalid input.
//
//   parseRpowToBaseUnits('1')           → '1000000000'
//   parseRpowToBaseUnits('0.0078125')   → '7812500'
//   parseRpowToBaseUnits('1,234.5')     → '1234500000000'
export function parseRpowToBaseUnits(rpow: string): string {
  const s = rpow.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error('invalid RPOW amount');
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '000000000').slice(0, 9);
  const result = BigInt(whole) * 1_000_000_000n + BigInt(fracPadded);
  return result.toString();
}
