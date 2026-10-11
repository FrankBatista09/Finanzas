// es-DO number format (1,234.56). Done by hand instead of with toLocaleString so that the result
// is identical in the browser, in Node and in Workers, without depending on the runtime's locale data.

function group(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fixed(n: number, decimals: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const s = Math.abs(v).toFixed(decimals);
  const [int, dec] = s.split('.');
  const body = dec ? `${group(int!)}.${dec}` : group(int!);
  // Avoids "-0.00" when a negative number rounds to zero.
  return v < 0 && +s !== 0 ? `-${body}` : body;
}

/** Two decimals with a thousands separator: 42025.567 → '42,025.57'. Not finite → '0.00'. */
export function f2(n: number): string {
  return fixed(n, 2);
}

/** Rounded integer with a thousands separator: 42025.57 → '42,026'. */
export function f0(n: number): string {
  return fixed(Math.round(Number.isFinite(n) ? n : 0), 0);
}

/**
 * Grams of gold: two decimals, or three if the third one counts (125.5 → '125.50', 1.234 → '1.234'). Without the unit.
 */
export function fGrams(n: number): string {
  const three = fixed(n, 3);
  return three.endsWith('0') ? three.slice(0, -1) : three;
}

/** Rate with two decimals, without a thousands separator: 58.7612 → '58.76'. */
export function fRate(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

/** Percentage with one decimal: 55.1724 → '55.2%' (the "% saved" column). */
export function fPct(n: number): string {
  return `${(Number.isFinite(n) ? n : 0).toFixed(1)}%`;
}

/**
 * Converts the text of a numeric input to a number. Empty or invalid → 0.
 * (The prototype stored the string and did `+v || 0` when calculating; here it is normalized when typed.)
 */
export function parseAmount(v: string | number | null | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v == null) return 0;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : 0;
}
