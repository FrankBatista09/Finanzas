import type { Account, AccountCurrency, Currency, Goal, Gold } from './types';

/** Nombre de la app: marca de la barra superior, título de la pestaña y nombre del archivo de Excel. */
export const APP_NAME = 'FE Finance';

// Los valores que se GUARDAN (categorías, métodos) son estos nombres canónicos en inglés, sea cual sea el idioma
// de quien los registra; al mostrarlos se traducen (shared/i18n.ts catLabel / methodLabel). Un valor fuera de la
// lista (texto libre, datos importados) se muestra tal cual.

export const CATS = [
  'Food',
  'Groceries',
  'Transport',
  'Entertainment',
  'Health',
  'Clothing',
  'Home',
  'Subscriptions',
  'Education',
  'Travel',
  'Other',
] as const;

export const METHODS = ['Debit card', 'Credit card', 'Transfer', 'Bank app', 'Cash'] as const;

/** Categoría y método de la transacción que nace al pasar un gasto de "fuera de presupuesto" al presupuesto (no los tiene). */
export const MOVED_TO_BUDGET = { cat: 'Other', method: 'Transfer' } as const;

/** Sugerencias para la vía de un envío. Es texto libre: se puede escribir cualquier otra. */
export const VIAS = ['Remitly', 'PayPal'] as const;

/** En el orden en que se ofrecen en los selectores. */
export const CURRENCIES: readonly Currency[] = ['DOP', 'USD', 'TRY'];

/** El oro como "moneda" de una cuenta: se mide en gramos (shared/types.ts Gold). */
export const GOLD: Gold = 'XAU';
/** Unidad en la que se muestran los saldos de oro: "125.50 g". Igual en los tres idiomas. */
export const GOLD_UNIT = 'g';
/** Decimales que se aceptan y se muestran, como mucho, en una cantidad de oro. */
export const GOLD_DECIMALS = 3;

/** Lo que se ofrece al crear o editar una CUENTA, y solo ahí: las monedas y el oro. */
export const ACCOUNT_CURRENCIES: readonly AccountCurrency[] = [...CURRENCIES, GOLD];

export function isGold(currency: AccountCurrency | null | undefined): currency is Gold {
  return currency === GOLD;
}

/** Monedas con las que arranca un usuario nuevo; cada quien las cambia en Settings. */
export const DEFAULT_MAIN_CURRENCY: Currency = 'DOP';
export const DEFAULT_SECOND_CURRENCY: Currency = 'USD';

/**
 * Largo máximo de los textos. Lo exige la API (server/validate.ts) y lo aplican las celdas (maxLength),
 * para que un guardado no se rechace por un texto demasiado largo. `label` vale para categoría, método y vía.
 */
export const MAX_LEN = { name: 120, desc: 200, place: 120, label: 60, day: 20, notes: 1000 } as const;

/** Tasa USD→DOP de referencia (Remitly): respaldo cuando ningún mes tiene tasa ni envíos para ese par. */
export const DEFAULT_RATE = 58.76;

/**
 * Último respaldo de las conversiones: cuántas unidades de cada moneda vale 1 USD. Solo se usa cuando ni el mes
 * ni ninguno anterior tiene tasa para el par; la interfaz avisa cuando una cifra sale de aquí (RateInfo.source
 * === 'default'), porque es un valor fijo y no el del mercado. El de DOP lo sustituye settings.default_rate.
 */
export const DEFAULT_USD_RATES: Readonly<Record<Currency, number>> = { USD: 1, DOP: DEFAULT_RATE, TRY: 42 };

/** Los usuarios viven en República Dominicana (UTC-4, sin horario de verano): "hoy" se calcula en esta zona. */
export const TIMEZONE = 'America/Santo_Domingo';

/**
 * Cuentas con las que arranca un usuario nuevo (las crea el servidor la primera vez que entra). Son las dos del
 * diseño original; cada quien agrega las suyas (PayPal, TR account…), las renombra u oculta las que no use.
 * El nombre de una cuenta es un dato del usuario y no se traduce.
 */
export const DEFAULT_ACCOUNTS: readonly Account[] = [
  { id: 'us', name: 'US account', currency: 'USD', opening: 0, hidden: false, sort: 0 },
  { id: 'dr', name: 'DR account', currency: 'DOP', opening: 0, hidden: false, sort: 1 },
];

/**
 * Metas con las que arranca un usuario nuevo (las crea el servidor la primera vez que entra).
 * Son de aportes variables; las metas con plan (monto objetivo y fechas) las agrega cada quien desde Savings.
 * El nombre de una meta es un dato del usuario (lo puede cambiar) y no se traduce.
 */
export const DEFAULT_GOALS: readonly Goal[] = [
  { id: 'emergency', name: 'Emergency fund', cur: 'USD', monthly: null, start: null, end: null, approxCur: null, sort: 0 },
  { id: 'personal', name: 'Personal savings', cur: 'USD', monthly: null, start: null, end: null, approxCur: null, sort: 1 },
];
