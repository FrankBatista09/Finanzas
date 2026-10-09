// Orden, listas y formatos de las tablas de la hoja "Mes": lo que renderVals() del prototipo prepara antes de pintar.
// Funciones puras, sin React y sin textos: los que dependen del idioma están en strings.ts.

import type { TransferFee } from '../../../shared/calc';
import { CREDIT_CARD_METHOD, METHODS, VIAS } from '../../../shared/constants';
import { fRate } from '../../../shared/format';
import { firstDay } from '../../../shared/month';
import type { Account, CreditCard, Currency, FixedExpense, ISODate, Month, MonthKey, MonthRate, Transaction } from '../../../shared/types';
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
 * Una fila del historial: una transacción (se edita y se borra) o la comisión de un envío (calc.transferFees),
 * que no es una fila guardada: se ve, cuenta en los totales y cambia con su envío.
 */
export type HistoryRow = { kind: 'tx'; key: string; date: ISODate; tx: Transaction } | { kind: 'fee'; key: string; date: ISODate; fee: TransferFee };

/**
 * El historial del mes: las transacciones y las comisiones de los envíos juntas, de la más reciente a la más
 * antigua. Con la misma fecha van primero las transacciones, en su orden, y después las comisiones.
 */
export function historyRows(tx: readonly Transaction[], fees: readonly TransferFee[]): HistoryRow[] {
  return sortTxDesc<HistoryRow>([
    ...tx.map((t) => ({ kind: 'tx' as const, key: t.id, date: t.date, tx: t })),
    ...fees.map((fee) => ({ kind: 'fee' as const, key: `fee:${fee.transferId}`, date: fee.date, fee })),
  ]);
}

/**
 * La comisión del envío más reciente hecho por esa vía (sin distinguir mayúsculas), en este mes o en los
 * anteriores: es la que se propone para el siguiente, porque cada servicio suele cobrar siempre lo mismo. 0 si
 * no hay ninguno. "Más reciente" es por fecha; con la misma fecha, el que se registró después.
 */
export function lastFee(months: Readonly<Record<MonthKey, Pick<Month, 'transfers'>>>, monthKey: MonthKey, via: string): number {
  const wanted = via.trim().toLowerCase();
  let hit: { date: ISODate; fee: number } | null = null;
  for (const key of Object.keys(months).sort()) {
    if (key > monthKey) break;
    for (const t of months[key]!.transfers) {
      if (t.via.trim().toLowerCase() === wanted && (!hit || t.date >= hit.date)) hit = { date: t.date, fee: t.fee || 0 };
    }
  }
  return hit?.fee ?? 0;
}

// ── Tarjetas de crédito en los selectores ────────────────────────────────────

/** Valor de «Pagar con» para una cuenta; con tarjeta es `card:<id>`. */
export const PAY_ACCOUNT = 'account';
const PAY_CARD = 'card:';

/** El valor del selector «Pagar con» de un gasto fijo: la tarjeta que tiene, o la primera activa si no dice cuál. */
export function payWithValue(onCard: boolean, cardId: string | null | undefined, firstActive: string | null): string {
  return onCard ? `${PAY_CARD}${cardId ?? firstActive ?? ''}` : PAY_ACCOUNT;
}

/** Lo contrario: el selector elegido pasa a `onCard` y a la tarjeta (sin tarjeta cuando es una cuenta). */
export function parsePayWith(value: string): { onCard: boolean; cardId?: string } {
  return value.startsWith(PAY_CARD) ? { onCard: true, cardId: value.slice(PAY_CARD.length) } : { onCard: false };
}

export interface CardOption {
  value: string;
  label: string;
}

/** Las tarjetas activas por su nombre; la que ya tiene la fila se queda aunque esté apagada, para que el selector no mienta. */
export function cardOptions(cards: readonly CreditCard[], current?: string | null): CardOption[] {
  return [...cards].filter((c) => c.active || c.id === current).sort((a, b) => a.sort - b.sort).map((c) => ({ value: c.id, label: c.name }));
}

/** «Pagar con»: la cuenta y una opción por tarjeta activa (más la de la fila, si está apagada). */
export function payWithOptions(accountLabel: string, cards: readonly CreditCard[], current?: string | null): CardOption[] {
  return [{ value: PAY_ACCOUNT, label: accountLabel }, ...cardOptions(cards, current).map((o) => ({ value: `${PAY_CARD}${o.value}`, label: o.label }))];
}

/** Los métodos de pago que se ofrecen: sin ninguna tarjeta activa no tiene sentido «Credit card» (salvo que la fila ya lo tenga). */
export function methodChoices(hasCard: boolean, current?: string): readonly string[] {
  const base: readonly string[] = hasCard ? METHODS : METHODS.filter((m) => m !== CREDIT_CARD_METHOD);
  return current === undefined || base.includes(current) ? base : [...base, current];
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
 * Las filas con sus importes ya convertidos (`inBoth` de useFinanzas()): una fila con fecha propia (una
 * transacción), con la tasa vigente en su fecha; una sin fecha (un gasto fijo), con la última del mes. A una fila
 * memorizada se le pasan las dos cifras y no la función, que cambia con cada cambio de estado.
 */
export function withMoney<T extends { amount: number; cur: Currency; date?: ISODate }>(
  rows: readonly T[],
  inBoth: (amount: number, cur: Currency, key?: MonthKey, date?: ISODate) => Money,
): WithMoney<T>[] {
  return rows.map((row) => ({ row, ...inBoth(row.amount, row.cur, undefined, row.date) }));
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

// usedCurrencies y shownRates viven en store/view.ts: la barra superior necesita saber qué tasas hacen falta.
export { accountsInUse, currenciesInUse, hasActivity, shownRates, usedCurrencies } from '../../store/view';

/** No hace falta ninguna tasa: todo el dinero está en una moneda y no hay ninguna escrita este mes que enseñar. */
export function noRatesNeeded(shown: readonly PairRate[]): boolean {
  return shown.length === 0;
}

const samePair = (r: { from: Currency; to: Currency }, from: Currency, to: Currency) =>
  (r.from === from && r.to === to) || (r.from === to && r.to === from);

/**
 * Una fila de la tarjeta "Tasas del mes".
 *  typed     una tasa escrita en este mes, con su fecha: se corrige y se quita.
 *  resolved  la tasa vigente de un par que no tiene ninguna escrita en este mes (valor de respaldo, envíos, cruce
 *            o un mes anterior): no hay nada guardado que quitar; escribir en ella crea la del par, desde `date`.
 */
export type RateRow =
  | { kind: 'typed'; key: string; from: Currency; to: Currency; rate: number; date: ISODate }
  | { kind: 'resolved'; key: string; from: Currency; to: Currency; rate: number; date: ISODate; info: PairRate };

/**
 * La fecha que se propone para una tasa nueva de ese par: `draftDate` (hoy si el mes es el actual; si no, su
 * primer día) cuando el par ya tiene una tasa escrita vigente; si no tiene ninguna, el primer día del mes, para
 * que la tasa cubra también las filas anteriores de este mes. `rates` son las de useFinanzas().
 */
export function newRateDate(from: Currency, to: Currency, rates: readonly PairRate[], monthKey: MonthKey, draftDate: ISODate): ISODate {
  // RateInfo.date solo viene cuando la tasa vigente es una escrita (de este mes o de uno anterior).
  const typed = rates.find((r) => samePair(r, from, to))?.date ?? null;
  return typed === null ? firstDay(monthKey) : draftDate;
}

/**
 * Las filas de la tarjeta: por cada par que se ve (`shown`, en su orden), sus tasas escritas en este mes por
 * fecha (las de una misma fecha, como llegaron) o, si no tiene ninguna, la vigente con su origen. La clave de una
 * fila es su par y su fecha: al escribir en una fila 'resolved' aparece en su sitio la 'typed' con esa misma
 * clave, y el campo en el que se está escribiendo no se desmonta.
 */
export function rateRows(
  shown: readonly PairRate[],
  typed: readonly MonthRate[],
  rates: readonly PairRate[],
  monthKey: MonthKey,
  draftDate: ISODate,
): RateRow[] {
  return shown.flatMap((pair): RateRow[] => {
    const id = [pair.from, pair.to].sort().join('-');
    const mine = typed.filter((r) => r.rate > 0 && samePair(r, pair.from, pair.to)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (mine.length > 0) return mine.map((r) => ({ kind: 'typed', key: `${id}:${r.date}`, from: r.from, to: r.to, rate: r.rate, date: r.date }));
    const date = newRateDate(pair.from, pair.to, rates, monthKey, draftDate);
    return [{ kind: 'resolved', key: `${id}:${date}`, from: pair.from, to: pair.to, rate: pair.rate, date, info: pair }];
  });
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
