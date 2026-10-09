// Registro de un gasto dictado a Claude. Lo usan POST /api/ingest/transaction y la herramienta
// add_transaction del servidor MCP, así que no sabe nada de HTTP y valida su propia entrada.

import type { IngestResponse, IngestTransaction } from '../shared/api';
import { isMoneyAccount } from '../shared/calc';
import { CATS, CREDIT_CARD_METHOD, METHODS } from '../shared/constants';
import { canonicalCat, canonicalMethod } from '../shared/i18n';
import { currentMonthKey, label, monthOf, monthSpan, todayISO } from '../shared/month';
import type { Account, AppUser, CreditCard } from '../shared/types';
import { createTransaction, ensureMonth, getMonth, listCards, userAccounts } from './db';
import { goldAccountError, invalidData, monthClosedError, noAccountsError, validationError } from './errors';
import { userFromBody } from './users';
import { ingestSchema, parse } from './validate';

// ── Cuentas dichas de palabra ────────────────────────────────────────────────

/**
 * Para comparar nombres como los dice una persona: sin mayúsculas, sin acentos y sin espacios de más
 * ("Cuenta Dólares" = "cuenta dolares", "İş Bankası" = "is bankasi").
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .replace(/\s+/g, ' ')
    .trim();
}

/** El texto viene de fuera: se recorta para que el mensaje no crezca con lo que mande el cliente. */
function shown(text: string): string {
  return text.trim().slice(0, 60);
}

/** Los nombres que se le ofrecen a quien se equivocó: las cuentas que ve (o todas, si las tiene todas ocultas). */
function accountNames(accounts: readonly Account[]): string {
  const sorted = [...accounts].sort((a, b) => a.sort - b.sort);
  const visible = sorted.filter((a) => !a.hidden);
  return (visible.length > 0 ? visible : sorted).map((a) => a.name).join(', ');
}

/**
 * La cuenta que nombra `text`, entre las del usuario: su id tal cual o su nombre, sin distinguir mayúsculas ni
 * acentos; primero el nombre completo y, si ninguna se llama así, un comienzo que solo tenga una ("us" → "US
 * account"). Las cuentas ocultas solo se miran cuando ninguna visible coincide.
 * Lanza ApiError 400 `validation` si no hay ninguna o hay varias, con los nombres de las cuentas en el mensaje
 * para que Claude pueda corregirse. `field` es el nombre del campo en ese mensaje.
 * La usan el registro de gastos de aquí abajo y las herramientas del servidor MCP.
 */
export function matchAccount(accounts: readonly Account[], text: string, field = 'account'): Account {
  const byId = accounts.find((a) => a.id === text.trim());
  if (byId) return byId;

  const wanted = fold(text);
  const visible = accounts.filter((a) => !a.hidden);
  const hidden = accounts.filter((a) => a.hidden);
  const tiers = [
    visible.filter((a) => fold(a.name) === wanted),
    hidden.filter((a) => fold(a.name) === wanted),
    visible.filter((a) => fold(a.name).startsWith(wanted)),
    hidden.filter((a) => fold(a.name).startsWith(wanted)),
  ];
  const found = wanted ? tiers.find((tier) => tier.length > 0) : undefined;
  if (found?.length === 1) return found[0]!;

  const names = accountNames(accounts);
  throw validationError(
    invalidData(
      found
        ? `${field}: "${shown(text)}" matches several accounts; use the full name of one of: ${names}`
        : `${field}: unknown account "${shown(text)}" (accounts: ${names})`,
    ),
  );
}

/**
 * La tarjeta de crédito que nombra `text`: su id o su nombre (sin distinguir mayúsculas ni acentos), primero el nombre
 * completo y, si ninguna se llama así, un comienzo que solo tenga una. Las apagadas solo se miran si ninguna activa
 * coincide. 400 `validation` con los nombres de las tarjetas si no hay ninguna o hay varias.
 */
export function matchCard(cards: readonly CreditCard[], text: string, field = 'card'): CreditCard {
  const byId = cards.find((c) => c.id === text.trim());
  if (byId) return byId;
  const wanted = fold(text);
  const on = cards.filter((c) => c.active);
  const off = cards.filter((c) => !c.active);
  const tiers = [
    on.filter((c) => fold(c.name) === wanted),
    off.filter((c) => fold(c.name) === wanted),
    on.filter((c) => fold(c.name).startsWith(wanted)),
    off.filter((c) => fold(c.name).startsWith(wanted)),
  ];
  const found = wanted ? tiers.find((tier) => tier.length > 0) : undefined;
  if (found?.length === 1) return found[0]!;
  const names = cards.map((c) => c.name).join(', ') || 'none yet';
  throw validationError(
    invalidData(found ? `${field}: "${shown(text)}" matches several credit cards; use the full name of one of: ${names}` : `${field}: unknown credit card "${shown(text)}" (credit cards: ${names})`),
  );
}

// ── Registro ─────────────────────────────────────────────────────────────────

/**
 * Guarda la transacción en las finanzas del usuario `input.user`, que tiene que ser uno de `users` (los
 * configurados, ver server/users.ts configuredUsers); si `users` trae uno solo, es ese y `user` puede faltar.
 * Aplica los valores por defecto del contrato (fecha: hoy en la zona horaria del usuario; categoría 'Food';
 * método 'Debit card'; cuenta: la cuenta por defecto del usuario; moneda: la de esa cuenta) y la guarda en el mes de
 * su fecha, creándolo si no existe. `account` es el id de una cuenta o su nombre (ver matchAccount).
 * Claude habla con cada persona en su idioma: una categoría o un método dichos en español o en turco
 * ('Comida', 'Kredi kartı') se guardan con su nombre canónico; 'Tarjeta' o 'Kart' a secas, como 'Debit card';
 * lo que no es de la lista se guarda tal cual.
 * Si el usuario nunca abrió la web, antes se le crean sus cuentas y metas iniciales.
 * Lanza ApiError: 400 `validation` si la entrada no cumple, el usuario falta o no existe o la cuenta no se
 * reconoce; 409 `month_closed` si ese mes está cerrado.
 */
export async function ingestTransaction(
  db: D1Database,
  users: readonly AppUser[],
  input: IngestTransaction,
  now: Date = new Date(),
): Promise<IngestResponse> {
  const data = parse(ingestSchema, input);
  const user = userFromBody(users, data.user);
  const date = data.date ?? todayISO(now);
  const monthKey = monthOf(date);

  // La cuenta se resuelve antes de tocar nada: una que no se reconoce no llega a crear el mes.
  const { accounts, defaultAccount } = await userAccounts(db, user.id);
  const account = data.account === undefined ? defaultAccount : matchAccount(accounts, data.account);
  if (!account) throw noAccountsError();
  // Una cuenta de oro guarda gramos: de ella no sale ningún gasto.
  if (!isMoneyAccount(account)) throw goldAccountError(account.name);

  // Un año mal puesto dejaría un mes fantasma: solo se crea un mes cercano a hoy (6 atrás, 1 adelante).
  // A un mes que ya existe se puede escribir sea cual sea su fecha.
  const offset = monthSpan(currentMonthKey(now), monthKey) - 1;
  if ((offset < -6 || offset > 1) && !(await getMonth(db, user.id, monthKey))) {
    throw validationError(
      `The date ${date} falls in ${label(monthKey)}, a month that does not exist for ${user.name} and is far from today (${todayISO(now)}). Check the year of the date.`,
    );
  }

  // La tarjeta, solo si el pago es con tarjeta de crédito; sin nombre, createTransaction usa la primera activa.
  const method = data.method ? canonicalMethod(data.method) : METHODS[0];
  const cardId = method === CREDIT_CARD_METHOD && data.card !== undefined ? matchCard(await listCards(db, user.id), data.card).id : undefined;

  const { month, created } = await ensureMonth(db, user.id, monthKey);
  if (month.closed) throw monthClosedError(monthKey);

  const transaction = await createTransaction(
    db,
    user.id,
    {
      monthKey,
      date,
      desc: data.description,
      place: data.place ?? '',
      cat: data.category ? canonicalCat(data.category) : CATS[0],
      method,
      ...(cardId && { cardId }),
      amount: data.amount,
      cur: data.currency ?? account.currency,
      accountId: account.id,
      notes: data.notes ?? '',
    },
    'claude',
    now,
  );
  return { transaction, monthCreated: created };
}
