// Borradores de las filas de agregar de la hoja "Mes": qué llevan, cuándo se pueden agregar y cómo quedan después.
// Es la lógica de addFixed / addTransfer / addTx del prototipo, sin React.
//
// Los montos son números y 0 significa "vacío", como esperan las celdas de src/ui. En cuenta, moneda y tasa,
// null significa "sin tocar": el campo enseña lo que toca en ese momento (la cuenta por defecto, la moneda de la
// cuenta, la tasa del mes) y lo sigue si eso cambia, hasta que el usuario elige otra cosa.

import { isMoneyAccount } from '../../../shared/calc';
import type { MoneyAccount } from '../../../shared/calc';
import { CATS, CREDIT_CARD_METHOD, CURRENCIES, METHODS, VIAS } from '../../../shared/constants';
import { fRate } from '../../../shared/format';
import type { Account, Currency, ISODate, MonthKey } from '../../../shared/types';
import type { FixedInput, OutsideInput, PairRate, TransferInput, TxInput } from '../../store';
import { newRateDate } from './rows';

// ── Cuenta y moneda de un gasto ──────────────────────────────────────────────

/** Lo que el borrador necesita saber del usuario. Sale tal cual de useFinanzas(). */
export interface DraftContext {
  /** Todas las cuentas, también las ocultas. */
  accounts: readonly Account[];
  defaultAccount: MoneyAccount | null;
  main: Currency;
}

interface Paying {
  /** null = la cuenta por defecto del usuario. */
  accountId: string | null;
  /** null = la moneda de la cuenta elegida. */
  cur: Currency | null;
}

/** La cuenta de la que saldrá el gasto: la elegida si sigue existiendo (y es de dinero: una de oro no paga nada); si no, la de por defecto. */
export function draftAccount(draft: Pick<Paying, 'accountId'>, ctx: DraftContext): MoneyAccount | null {
  return ctx.accounts.filter(isMoneyAccount).find((a) => a.id === draft.accountId) ?? ctx.defaultAccount;
}

/** La moneda del gasto: la elegida o, mientras no se toque, la de su cuenta (la principal si no hay cuentas). */
export function draftCurrency(draft: Paying, ctx: DraftContext): Currency {
  return draft.cur ?? draftAccount(draft, ctx)?.currency ?? ctx.main;
}

// ── Gasto fijo ───────────────────────────────────────────────────────────────

export interface FixedDraft extends Paying {
  name: string;
  day: string;
  amount: number;
  /** "Pay with" = tarjeta de crédito: la cuenta no cuenta (el gasto no sale de ninguna hasta que se paga la tarjeta). */
  onCard: boolean;
  /** Con qué tarjeta si `onCard`; null = la primera activa (y la sigue si cambia). */
  cardId: string | null;
}

export const EMPTY_FIXED: FixedDraft = { name: '', day: '', amount: 0, cur: null, accountId: null, onCard: false, cardId: null };

/** Concepto y monto mayor que 0. Después de agregar, el borrador vuelve entero a EMPTY_FIXED. */
export function canAddFixed(draft: FixedDraft): boolean {
  return draft.name.trim() !== '' && draft.amount > 0;
}

/** Lo que se manda al agregar: moneda y cuenta ya resueltas. Sin cuentas no va ninguna y la capa de datos lo rechaza. */
export function fixedInput(draft: FixedDraft, ctx: DraftContext): FixedInput {
  const account = draftAccount(draft, ctx);
  return {
    name: draft.name,
    day: draft.day,
    amount: draft.amount,
    cur: draftCurrency(draft, ctx),
    ...(account && { accountId: account.id }),
    ...(draft.onCard && { onCard: true, ...(draft.cardId && { cardId: draft.cardId }) }),
  };
}

// ── Transacción ──────────────────────────────────────────────────────────────

export interface TxDraft extends Paying {
  /** null = el usuario no ha tocado la fecha: se usa la del shell (hoy, o el día 1 de un mes que no es el actual). */
  date: ISODate | null;
  desc: string;
  place: string;
  cat: string;
  method: string;
  amount: number;
  notes: string;
  /** Con qué tarjeta si el método es de crédito; null = la primera activa. */
  cardId: string | null;
}

export function newTxDraft(): TxDraft {
  return { date: null, desc: '', place: '', cat: CATS[0], method: METHODS[0], amount: 0, cur: null, accountId: null, notes: '', cardId: null };
}

/** Descripción y monto mayor que 0. */
export function canAddTx(draft: TxDraft): boolean {
  return draft.desc.trim() !== '' && draft.amount > 0;
}

/** Lo que se manda al agregar: el borrador con su fecha, su moneda y su cuenta ya resueltas. */
export function txInput(draft: TxDraft, draftDate: ISODate, ctx: DraftContext): TxInput {
  const account = draftAccount(draft, ctx);
  return {
    date: draft.date ?? draftDate,
    desc: draft.desc,
    place: draft.place,
    cat: draft.cat,
    method: draft.method,
    amount: draft.amount,
    cur: draftCurrency(draft, ctx),
    ...(account && { accountId: account.id }),
    notes: draft.notes,
    ...(draft.method === CREDIT_CARD_METHOD && draft.cardId && { cardId: draft.cardId }),
  };
}

/** Se limpia lo propio de cada gasto; fecha, categoría, método, moneda y cuenta se quedan para cargar varios seguidos. */
export function afterTxAdded(draft: TxDraft): TxDraft {
  return { ...draft, desc: '', place: '', amount: 0, notes: '' };
}

// ── Gasto fuera de presupuesto ───────────────────────────────────────────────

export interface OutsideDraft extends Paying {
  /** null = sin tocar: la fecha del shell, como en TxDraft. */
  date: ISODate | null;
  name: string;
  amount: number;
  desc: string;
}

export function newOutsideDraft(): OutsideDraft {
  return { date: null, name: '', amount: 0, desc: '', cur: null, accountId: null };
}

/** Nombre y monto mayor que 0. */
export function canAddOutside(draft: OutsideDraft): boolean {
  return draft.name.trim() !== '' && draft.amount > 0;
}

export function outsideInput(draft: OutsideDraft, draftDate: ISODate, ctx: DraftContext): OutsideInput {
  const account = draftAccount(draft, ctx);
  return {
    date: draft.date ?? draftDate,
    name: draft.name,
    desc: draft.desc,
    amount: draft.amount,
    cur: draftCurrency(draft, ctx),
    ...(account && { accountId: account.id }),
  };
}

/** Como las transacciones: se limpia lo propio de cada gasto; fecha, moneda y cuenta se quedan para cargar varios seguidos. */
export function afterOutsideAdded(draft: OutsideDraft): OutsideDraft {
  return { ...draft, name: '', amount: 0, desc: '' };
}

// ── Envío ────────────────────────────────────────────────────────────────────

export interface TransferDraft {
  /** null = sin tocar: la fecha del shell, como en TxDraft. */
  date: ISODate | null;
  /** Texto libre, tal como está en el campo (puede estar vacío a media edición; ver transferInput). */
  via: string;
  /** null = sin tocar: ver transferSides. */
  fromAccountId: string | null;
  toAccountId: string | null;
  /** Lo que sale, en la moneda de la cuenta de origen. */
  amount: number;
  /** null = sin tocar: la tasa del mes para las monedas de las dos cuentas, y las sigue si cambian. */
  rate: number | null;
  /** La casilla "Moves budget": marcada de entrada, porque lo que se envía suele ser para gastarlo este mes. */
  budget: boolean;
  /** null = sin tocar: la comisión del último envío por esa vía (TransferContext.lastFee), y la sigue si cambia la vía. */
  fee: number | null;
}

export interface TransferContext extends Pick<DraftContext, 'accounts' | 'defaultAccount'> {
  /** Las cuentas que se ofrecen, en su orden: las visibles de dinero. */
  visible: readonly MoneyAccount[];
  /** La tasa del mes seleccionado para ese par, vigente en la fecha del borrador (useFinanzas().rateOf(from, to, undefined, date).rate). */
  rateOf(from: Currency, to: Currency): number;
  /** La comisión del envío más reciente por esa vía; 0 si no hay ninguno (rows.ts lastFee). */
  lastFee(via: string): number;
}

export interface TransferSides {
  from: MoneyAccount | null;
  to: MoneyAccount | null;
}

/** La vía con la que arranca el borrador, y la que se usa si el campo se deja vacío (un envío sin vía no vale). */
export const DEFAULT_VIA: string = VIAS[0];

/** Lo escrito sin espacios sobrantes o, si no hay nada, la vía por defecto. */
function viaOf(draft: TransferDraft): string {
  return draft.via.trim() || DEFAULT_VIA;
}

export function newTransferDraft(): TransferDraft {
  return { date: null, via: DEFAULT_VIA, fromAccountId: null, toAccountId: null, amount: 0, rate: null, budget: true, fee: null };
}

/** Otra cuenta visible distinta de `than`; mejor una de otra moneda, que es lo que suele ser un envío. */
function another(visible: readonly MoneyAccount[], than: MoneyAccount | null): MoneyAccount | null {
  const rest = visible.filter((a) => a.id !== than?.id);
  return rest.find((a) => a.currency !== than?.currency) ?? rest[0] ?? null;
}

/**
 * Las dos cuentas del borrador. Sin tocar, el dinero llega a la cuenta por defecto (de la que salen los gastos)
 * desde otra cuenta visible, mejor de otra moneda: "US account → DR account". Nunca son la misma; con una sola
 * cuenta falta uno de los lados y el envío no se puede agregar.
 */
export function transferSides(draft: Pick<TransferDraft, 'fromAccountId' | 'toAccountId'>, ctx: TransferContext): TransferSides {
  const chosen = (id: string | null) => ctx.accounts.filter(isMoneyAccount).find((a) => a.id === id) ?? null;
  const from = chosen(draft.fromAccountId);
  let to = chosen(draft.toAccountId);
  if (to && to.id === from?.id) to = null;
  if (!to) to = ctx.defaultAccount && ctx.defaultAccount.id !== from?.id ? ctx.defaultAccount : another(ctx.visible, from);
  return { from: from ?? another(ctx.visible, to), to };
}

/**
 * La tasa con la que se propone un envío: la del mes, con dos decimales como en el resto de la hoja; una menor
 * que 1 (DOP → USD: 0.017) con cuatro cifras significativas, que con dos decimales no diría nada.
 */
export function prefillRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return rate >= 1 ? Number(fRate(rate)) : Number(rate.toPrecision(4));
}

export interface TransferRate {
  rate: number;
  /** Entre cuentas de la misma moneda la tasa es 1 y no se escribe. */
  locked: boolean;
}

/** La tasa que enseña el campo: 1 entre monedas iguales; la que escribió el usuario; si no, la del mes para ese par. */
export function transferRate(draft: TransferDraft, ctx: TransferContext): TransferRate {
  const { from, to } = transferSides(draft, ctx);
  if (!from || !to) return { rate: draft.rate ?? 0, locked: false };
  if (from.currency === to.currency) return { rate: 1, locked: true };
  return { rate: draft.rate ?? prefillRate(ctx.rateOf(from.currency, to.currency)), locked: false };
}

/**
 * Elegir la cuenta de un lado de un envío. Las dos tienen que ser distintas: elegir la que está en el otro lado
 * las intercambia (invertir el envío), que es lo que se quiere y lo único posible con dos cuentas.
 */
export function swapSides(
  row: { fromAccountId: string; toAccountId: string },
  side: 'from' | 'to',
  id: string,
): { fromAccountId: string; toAccountId: string } {
  const other = side === 'from' ? row.toAccountId : row.fromAccountId;
  const mine = side === 'from' ? row.fromAccountId : row.toAccountId;
  const next = id === other ? mine : other;
  return side === 'from' ? { fromAccountId: id, toAccountId: next } : { fromAccountId: next, toAccountId: id };
}

/**
 * El borrador después de elegir una cuenta. Las dos quedan fijadas como se ven (la otra ya no se mueve sola).
 * Una tasa escrita a mano se conserva mientras el envío siga siendo entre las mismas monedas y en el mismo
 * sentido; si cambian, era de otro par y vuelve a seguir la tasa del mes (igual que hace la capa de datos al
 * editar un envío).
 */
export function pickTransferAccount(draft: TransferDraft, ctx: TransferContext, side: 'from' | 'to', id: string): TransferDraft {
  const before = transferSides(draft, ctx);
  const ids = swapSides({ fromAccountId: before.from?.id ?? '', toAccountId: before.to?.id ?? '' }, side, id);
  const next = { ...draft, fromAccountId: ids.fromAccountId || null, toAccountId: ids.toAccountId || null };
  const after = transferSides(next, ctx);
  const samePair = before.from?.currency === after.from?.currency && before.to?.currency === after.to?.currency;
  return samePair ? next : { ...next, rate: null };
}

/** La comisión que enseña el campo: la que escribió el usuario; sin tocar, la del último envío por la vía del borrador. */
export function transferFee(draft: TransferDraft, ctx: Pick<TransferContext, 'lastFee'>): number {
  return draft.fee ?? ctx.lastFee(viaOf(draft));
}

/** El borrador después de escribir en la tasa. Vaciar el campo (0) lo devuelve a la tasa del mes. */
export function typeTransferRate(draft: TransferDraft, rate: number): TransferDraft {
  return { ...draft, rate: rate > 0 ? rate : null };
}

/** Dos cuentas distintas, monto y tasa mayores que 0. La vía no frena: vacía, cuenta como la de por defecto. */
export function canAddTransfer(draft: TransferDraft, ctx: TransferContext): boolean {
  const { from, to } = transferSides(draft, ctx);
  return from !== null && to !== null && from.id !== to.id && draft.amount > 0 && transferRate(draft, ctx).rate > 0;
}

/** Lo que se manda al agregar: fecha, vía, cuentas y tasa ya resueltas (la tasa, la que se ve en el campo). null si no se puede agregar. */
export function transferInput(draft: TransferDraft, draftDate: ISODate, ctx: TransferContext): TransferInput | null {
  const { from, to } = transferSides(draft, ctx);
  if (!from || !to || !canAddTransfer(draft, ctx)) return null;
  return {
    date: draft.date ?? draftDate,
    via: viaOf(draft),
    fromAccountId: from.id,
    toAccountId: to.id,
    amount: draft.amount,
    rate: transferRate(draft, ctx).rate,
    budget: draft.budget,
    fee: transferFee(draft, ctx),
  };
}

/**
 * Solo se limpia el monto: fecha, vía, cuentas, tasa y casilla suelen repetirse en el siguiente envío. La vía queda
 * como se guardó y la comisión vuelve a "sin tocar": propondrá la del envío que se acaba de guardar.
 */
export function afterTransferAdded(draft: TransferDraft): TransferDraft {
  return { ...draft, via: viaOf(draft), amount: 0, fee: null };
}

// ── Tasa del mes ─────────────────────────────────────────────────────────────

export type Pair = readonly [from: Currency, to: Currency];

export interface RateDraft {
  /** null = sin tocar: el primer par de la tarjeta que aún no tiene tasa escrita. */
  pair: Pair | null;
  rate: number;
  /** null = sin tocar: la fecha que toque para el par (rows.ts newRateDate). */
  date: ISODate | null;
}

export const EMPTY_RATE: RateDraft = { pair: null, rate: 0, date: null };

/**
 * El par que propone la fila de agregar: el elegido o, sin tocar, el primero de los que se ven cuya tasa no está
 * escrita para este mes (es la que falta por poner); si todas lo están, el primero.
 */
export function ratePair(draft: RateDraft, shown: readonly PairRate[], main: Currency, second: Currency | null): Pair {
  if (draft.pair) return draft.pair;
  const row = shown.find((r) => r.source !== 'month') ?? shown[0];
  // Sin ninguna tasa que hacer falta ni segunda moneda, la primera otra moneda contra la principal.
  return row ? [row.from, row.to] : [second ?? CURRENCIES.find((c) => c !== main) ?? main, main];
}

/** Elegir una moneda del par. Tienen que ser distintas: elegir la del otro lado las intercambia. */
export function pickRateCurrency(pair: Pair, side: 'from' | 'to', cur: Currency): Pair {
  const [from, to] = pair;
  if (side === 'from') return [cur, cur === to ? from : to];
  return [cur === from ? to : from, cur];
}

/** Una tasa mayor que 0. */
export function canAddRate(draft: RateDraft): boolean {
  return draft.rate > 0;
}

/**
 * La fecha desde la que valdrá la tasa nueva: la elegida o, sin tocar, la que toque para el par (newRateDate):
 * cambia sola con el par mientras el usuario no elija una.
 */
export function rateDate(draft: RateDraft, pair: Pair, rates: readonly PairRate[], monthKey: MonthKey, draftDate: ISODate): ISODate {
  return draft.date ?? newRateDate(pair[0], pair[1], rates, monthKey, draftDate);
}
