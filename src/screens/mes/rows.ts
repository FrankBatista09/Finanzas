// Orden, listas y formatos de las tablas de la hoja "Mes": lo que renderVals() del prototipo prepara antes de pintar.
// Funciones puras, sin React y sin textos: los que dependen del idioma están en strings.ts.

import { CURRENCIES, VIAS } from '../../../shared/constants';
import { fRate } from '../../../shared/format';
import type { Account, Currency, FixedExpense, ISODate, Month, MonthKey, Transaction } from '../../../shared/types';
import type { AccountOption, Money, PairRate } from '../../store';

// Topes de texto que exige el servidor. La celda no deja pasarse: así el guardado no se rechaza
// (y se deshace) por un texto demasiado largo.
export { MAX_LEN } from '../../../shared/constants';

/** Gastos fijos en el orden de la hoja (`sort`). Los empates conservan el orden en que llegaron. */
export function sortFixed<T extends Pick<FixedExpense, 'sort'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.sort - b.sort);
}

/**
 * Transacciones de la más reciente a la más antigua. El orden es estable: las de un mismo día quedan como
 * estaban (la recién agregada, debajo de las de su misma fecha), igual que en el prototipo.
 */
export function sortTxDesc<T extends Pick<Transaction, 'date'>>(rows: readonly T[]): T[] {
  // Las fechas ISO se ordenan bien como texto; se comparan sin localeCompare para no depender del locale.
  return [...rows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * Opciones de un desplegable de categoría o método. Si la fila trae un valor que no está en la lista
 * (datos importados del Excel o registrados por Claude), se agrega al final: sin eso el <select> mostraría
 * la primera opción y el valor real cambiaría sin que nadie lo pidiera.
 */
export function optionsWith(base: readonly string[], value: string): readonly string[] {
  return base.includes(value) ? base : [...base, value];
}

export interface LabelledOption {
  value: string;
  label: string;
}

/**
 * Las opciones como las pide CellSelect cuando lo que se ve no es lo que se guarda: el valor es el nombre
 * canónico (en inglés) y el texto, su nombre en el idioma actual (catLabel / methodLabel de useI18n).
 * Un valor de fuera de la lista no tiene traducción y sale tal cual.
 */
export function labelled(values: readonly string[], label: (value: string) => string): LabelledOption[] {
  return values.map((value) => ({ value, label: label(value) }));
}

// ── Importes y cuentas de una fila ───────────────────────────────────────────

/** Una fila con sus dos columnas calculadas: el importe en la moneda principal y en la segunda. */
export type WithMoney<T> = { row: T } & Money;

/**
 * Las filas con sus importes ya convertidos (`inBoth` de useFinanzas(), con las tasas del mes). A una fila
 * memorizada se le pasan las dos cifras y no la función, que cambia con cada cambio de estado.
 */
export function withMoney<T extends { amount: number; cur: Currency }>(
  rows: readonly T[],
  inBoth: (amount: number, cur: Currency) => Money,
): WithMoney<T>[] {
  return rows.map((row) => ({ row, ...inBoth(row.amount, row.cur) }));
}

/**
 * Las opciones del selector de cuenta de una fila: las visibles (`base`, la misma lista para todas las filas, así
 * las memorizadas no se repintan) y, solo si la cuenta de la fila no está entre ellas porque se ocultó después,
 * esa detrás con su nombre: tiene que seguir viéndose en vez de cambiarse sola por otra.
 */
export function rowAccountOptions(base: readonly AccountOption[], accounts: readonly Account[], id: string): readonly AccountOption[] {
  if (!id || base.some((o) => o.value === id)) return base;
  return [...base, { value: id, label: accounts.find((a) => a.id === id)?.name ?? '—' }];
}

// ── Tasas del mes ────────────────────────────────────────────────────────────

/**
 * Las monedas que el usuario usa de verdad en este mes: la principal, la segunda, las de sus cuentas visibles y
 * las de los gastos del mes (un gasto en liras sin cuenta en liras también se convierte). En el orden de siempre.
 */
export function usedCurrencies(
  main: Currency,
  second: Currency,
  visible: readonly Pick<Account, 'currency'>[],
  month: { fixed: readonly { cur: Currency }[]; tx: readonly { cur: Currency }[] },
): Currency[] {
  const used = new Set<Currency>([main, second, ...visible.map((a) => a.currency), ...month.fixed.map((f) => f.cur), ...month.tx.map((t) => t.cur)]);
  return CURRENCIES.filter((c) => used.has(c));
}

/**
 * Las tasas que enseña la tarjeta "Tasas del mes": las de los pares entre monedas que se usan y, además, cualquier
 * tasa escrita para este mes (si está escrita se tiene que poder ver, corregir y quitar). Conserva el orden de
 * `rates`, que trae primero el par de la barra superior.
 */
export function shownRates(rates: readonly PairRate[], used: readonly Currency[]): PairRate[] {
  return rates.filter((r) => r.source === 'month' || (used.includes(r.from) && used.includes(r.to)));
}

/**
 * Una tasa como texto: dos decimales, como en toda la app. Una menor que 1 (1 DOP = 0.0170 USD) lleva cuatro,
 * como en la barra superior: con dos no diría nada.
 */
export function showRate(rate: number): string {
  return rate > 0 && rate < 1 ? rate.toFixed(4) : fRate(rate);
}

/**
 * Sugerencias para la vía de un envío: primero las de siempre (VIAS) y después las que ya se usaron en este mes
 * y en los anteriores, de la más reciente a la más antigua. La vía es texto libre; esto solo ahorra escribirla.
 * No se repiten aunque cambien las mayúsculas ("paypal" no se ofrece al lado de "PayPal").
 */
export function viaSuggestions(months: Readonly<Record<MonthKey, Pick<Month, 'transfers'>>>, monthKey: MonthKey): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const offer = (via: string) => {
    const text = via.trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };
  VIAS.forEach(offer);
  // Las claves 'YYYY-MM' se ordenan bien como texto.
  const keys = Object.keys(months)
    .filter((key) => key <= monthKey)
    .sort()
    .reverse();
  for (const key of keys) [...months[key]!.transfers].reverse().forEach((t) => offer(t.via));
  return out;
}

/** '2026-10-02' → '02/10' (columna "Fecha" de los envíos). */
export function shortDate(date: ISODate): string {
  return `${date.slice(8)}/${date.slice(5, 7)}`;
}

/** Cómo se nombra un envío en las etiquetas de sus celdas: "Remitly 02/10". */
export function transferName(t: { via: string; date: ISODate }): string {
  return `${t.via} ${shortDate(t.date)}`.trim();
}

/**
 * La tasa dentro de su campo: con dos decimales al menos, como en el resto de la hoja (58.7 → '58.70'),
 * pero sin recortar los que el usuario haya escrito de más (58.755 se queda en '58.755').
 */
export function rateText(rate: number): string {
  const two = fRate(rate);
  // Un valor no finito no llega del campo (parseAmount lo deja en 0); por si acaso, sale como lo pinta fRate.
  return !Number.isFinite(rate) || Number(two) === rate ? two : String(rate);
}

/** Ancho de la barra de una categoría: su parte del valor mayor (`MonthCalc.catMax`, que nunca es 0). */
export function barWidth(value: number, max: number): string {
  return `${(value / max) * 100}%`;
}
