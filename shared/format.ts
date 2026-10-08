// Formato numérico es-DO (1,234.56). Se hace a mano en vez de con toLocaleString para que el resultado
// sea idéntico en el navegador, en Node y en Workers, sin depender de los datos de locale del runtime.

function group(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fixed(n: number, decimals: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const s = Math.abs(v).toFixed(decimals);
  const [int, dec] = s.split('.');
  const body = dec ? `${group(int!)}.${dec}` : group(int!);
  // Evita "-0.00" cuando un negativo redondea a cero.
  return v < 0 && +s !== 0 ? `-${body}` : body;
}

/** Dos decimales con separador de miles: 42025.567 → '42,025.57'. No finito → '0.00'. */
export function f2(n: number): string {
  return fixed(n, 2);
}

/** Entero redondeado con separador de miles: 42025.57 → '42,026'. */
export function f0(n: number): string {
  return fixed(Math.round(Number.isFinite(n) ? n : 0), 0);
}

/** Tasa con dos decimales, sin separador de miles: 58.7612 → '58.76'. */
export function fRate(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

/** Porcentaje con un decimal: 55.1724 → '55.2%' (la columna "% ahorro"). */
export function fPct(n: number): string {
  return `${(Number.isFinite(n) ? n : 0).toFixed(1)}%`;
}

/**
 * Convierte el texto de un input numérico a número. Vacío o inválido → 0.
 * (El prototipo guardaba el string y hacía `+v || 0` al calcular; aquí se normaliza al escribir.)
 */
export function parseAmount(v: string | number | null | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v == null) return 0;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : 0;
}
