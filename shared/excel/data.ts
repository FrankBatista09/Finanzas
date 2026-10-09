// Puente entre el estado de la app y el libro de Excel.
//
// El libro conserva el diseño original, que solo conoce dos monedas (USD y DOP) y dos cuentas (una en cada
// moneda), con el presupuesto, el ingreso y los saldos escritos mes a mes. El estado de la app es otro modelo:
// tres monedas, las cuentas que tenga el usuario, ingresos uno a uno y saldos calculados. Estas dos funciones
// puras llevan de uno a otro. Es un resumen fiel en los totales, no una copia: lo que se pierde en cada
// sentido está en el comentario de cada función. Todas las conversiones pasan por shared/calc.ts.

import type { ImportGoal, ImportMonth, ImportPayload } from '../api';
import {
  accountsById,
  balances,
  budgetsFromLog,
  contribIn,
  convert,
  currentKey,
  incomeInMonth,
  isMoneyBalance,
  monthCalc,
  openingFor,
  sortedKeys,
  transferReceived,
  visibleAccounts,
} from '../calc';
import { f2 } from '../format';
import { firstDay, monthOf } from '../month';
import type { Account, AppState, Contribution, Currency, Goal, Income, Month, MonthKey, Transfer } from '../types';
import { LEGACY_GOALS } from './import';
import type { ExportData, ExportMonth } from './types';

/** Descripción del ingreso que crea una importación con el ingreso del mes del libro (uno por mes importado). */
export const IMPORTED_INCOME = 'Income (imported)';

/** Nombre de la cuenta que se crea al importar si al usuario le falta una visible en esa moneda. */
export const BOOK_ACCOUNT_NAMES = { USD: 'US account', DOP: 'DR account' } as const;

type BookCurrency = keyof typeof BOOK_ACCOUNT_NAMES;

/** Las monedas que el libro sabe escribir; cualquier otra hay que convertirla antes. */
const inBook = (cur: Currency): cur is BookCurrency => cur === 'USD' || cur === 'DOP';

// ── Estado → libro ───────────────────────────────────────────────────────────

function exportMonth(state: AppState, accounts: ReadonlyMap<string, Account>, key: MonthKey): ExportMonth {
  const m = state.months[key]!;
  // El libro solo sabe de dinero: las cuentas de oro (gramos) quedan fuera de sus saldos.
  const visible = balances(state, key)
    .accounts.filter(isMoneyBalance)
    .filter((a) => !a.account.hidden);
  /** Lo que el libro no sabe escribir (TRY) va convertido a DOP: con la tasa de su fecha si la tiene, o la última del mes. */
  const amountInBook = (amount: number, cur: Currency, date?: string) =>
    inBook(cur) ? { amount, cur } : { amount: convert(state, key, amount, cur, 'DOP', date), cur: 'DOP' as const };

  const transfers: ExportMonth['transfers'] = [];
  for (const t of m.transfers) {
    const from = accounts.get(t.fromAccountId)?.currency;
    const to = accounts.get(t.toAccountId)?.currency;
    if (from === 'USD' && to === 'DOP') {
      transfers.push({ date: t.date, via: t.via, usd: t.amount, rate: t.rate });
    } else if (from === 'DOP' && to === 'USD') {
      // Al revés: el libro lo ve como los USD que entraron, a la tasa inversa (da los mismos DOP que salieron).
      transfers.push({ date: t.date, via: t.via, usd: transferReceived(t), rate: t.rate > 0 ? 1 / t.rate : 0 });
    }
  }

  return {
    key,
    budget: monthCalc(state, key).budgetParts.reduce((a, p) => a + convert(state, key, p.amount, p.account.currency, 'DOP'), 0),
    incomeUSD: incomeInMonth(state, key, 'USD'),
    accounts: {
      usd: visible
        .filter((a) => a.account.currency !== 'DOP')
        .reduce((a, b) => a + convert(state, key, b.balance, b.account.currency, 'USD'), 0),
      dop: visible.filter((a) => a.account.currency === 'DOP').reduce((a, b) => a + b.balance, 0),
    },
    fixed: [...m.fixed]
      .sort((a, b) => a.sort - b.sort)
      .map((f) => ({ name: f.name, day: f.day, ...amountInBook(f.amount, f.cur), paid: f.paid })),
    transfers,
    tx: m.tx.map((t) => ({
      date: t.date,
      desc: t.desc,
      place: t.place,
      cat: t.cat,
      method: t.method,
      ...amountInBook(t.amount, t.cur, t.date),
      // El monto original de lo convertido queda a la vista en las notas: "TRY 1,250.00".
      notes: inBook(t.cur) ? t.notes : [t.notes, `${t.cur} ${f2(t.amount)}`].filter(Boolean).join(' · '),
    })),
  };
}

/**
 * Arma la entrada del generador de .xlsx a partir del estado: proyecta el modelo de cuentas sobre la forma del
 * libro (equivale a `downloadExcel()` del prototipo). Categorías, métodos y textos van como están guardados
 * (el generador traduce los valores canónicos).
 *
 * Por cada mes, con las tasas de ese mes:
 *  · budget: el presupuesto total (la suma de las partes por cuenta: su registro más los ingresos que lo suben y el neto de los envíos que lo mueven) en DOP.
 *  · incomeUSD: los ingresos con fecha en el mes, en USD.
 *  · accounts.dop: la suma de los saldos de las cuentas visibles en DOP al final del mes.
 *    accounts.usd: la suma de los saldos de las demás cuentas visibles (USD y TRY), en USD.
 *    Así el "dinero total" del libro (USD × tasa del mes + DOP) es el de la app, salvo por el oro: las cuentas
 *    de oro (gramos) no salen en el libro, tengan o no precio, y sus ingresos en gramos tampoco son ingreso.
 *  · Gastos fijos y transacciones: monto y moneda tal cual si son DOP o USD; si son TRY, el monto convertido a
 *    DOP (la transacción lleva el original al final de sus notas).
 *  · Los gastos fuera de presupuesto (Month.outside) no salen como filas, pero sí están restados de los saldos de
 *    las cuentas (balances), así que el libro y la app muestran el mismo dinero total.
 *  · Las comisiones de los envíos (Transfer.fee) no salen como filas: el libro no las conoce. Sí están ya
 *    restadas en el saldo de la cuenta de origen, pero lo "usado" del libro no las cuenta.
 *  · Envíos: solo los que van entre una cuenta en USD y otra en DOP. USD → DOP como { usd: lo que salió, rate };
 *    DOP → USD como { usd: lo que entró, rate: 1 / rate }. Con ellos el libro calcula la misma tasa del mes que
 *    la app cuando el mes no tiene una escrita a mano.
 * Aportes: tal cual si son DOP o USD; en TRY, convertidos a USD con la tasa del mes de su fecha.
 * Metas: las que están en USD, tal cual; las de otra moneda, con su ahorro mensual convertido a USD a la tasa
 * del mes en curso.
 * La tasa por defecto del libro (hoja Config) es state.defaultRate.
 *
 * Lo que se pierde (el libro es un resumen hasta que se rediseñe):
 *  · qué cuenta pagó cada gasto, cuántas cuentas hay y el saldo de cada una (quedan dos sumas); las cuentas
 *    ocultas no cuentan, igual que en el dinero total de la app;
 *  · el reparto del presupuesto por cuenta y el detalle de los ingresos (queda un total por mes; un ingreso con
 *    fecha en un mes que no existe no sale);
 *  · las tasas escritas a mano: el libro calcula la suya con los envíos del mes y, si no hay, usa la tasa por
 *    defecto (la app, en cambio, la del mes anterior). Cuando la tasa USD→DOP de la app no es la de esos envíos,
 *    o cuando las tres tasas del mes no cuadran entre sí (p. ej. hay envíos USD↔DOP, USD↔TRY y TRY↔DOP a la
 *    vez), lo que el libro muestra convertido, también el dinero total, difiere de lo que muestra la app;
 *  · los envíos que no son entre USD y DOP (hacia o desde una cuenta en TRY, o entre cuentas de la misma moneda);
 *  · la moneda original de lo que estaba en TRY (salvo la nota de las transacciones) y la moneda de las metas.
 */
export function buildExportData(state: AppState): ExportData {
  const accounts = accountsById(state);
  const goals = [...state.goals].sort((a, b) => a.sort - b.sort);
  const goalName = new Map(goals.map((g) => [g.id, g.name]));
  // Sin meses no hay tasas: rateFor da el valor de respaldo sea cual sea la clave.
  const now = currentKey(state) ?? '';
  return {
    months: sortedKeys(state).map((key) => exportMonth(state, accounts, key)),
    contribs: state.contribs.map((c) => ({
      date: c.date,
      goalName: goalName.get(c.goalId) ?? c.goalId,
      ...(inBook(c.cur) ? { amount: c.amount, cur: c.cur } : { amount: contribIn(state, c, 'USD'), cur: 'USD' as const }),
    })),
    // Un plan incompleto sale como meta de aportes variables, que es como lo dibujaría el generador.
    goals: goals.map((g) =>
      g.monthly && g.start && g.end
        ? { name: g.name, monthlyUSD: convert(state, now, g.monthly, g.cur, 'USD'), start: g.start, end: g.end }
        : { name: g.name, monthlyUSD: null, start: null, end: null },
    ),
    defaultRate: state.defaultRate,
  };
}

// ── Libro → estado ───────────────────────────────────────────────────────────

/** Por debajo de esto, una diferencia de ingreso es ruido de la coma flotante y no un ingreso que falte. */
const HALF_CENT = 0.005;

const foldName = (name: string) => name.normalize('NFC').toLowerCase();

/**
 * Nombre de hoy → nombre en la versión 1 de las tres metas que el lector de Excel renombra al leer un libro
 * de entonces ('Emergency fund' → 'Fondo de emergencia').
 */
const FORMER_GOAL_NAME: ReadonlyMap<string, string> = new Map(LEGACY_GOALS.map(([before, now]) => [now, before]));

/**
 * `known`: los envíos USD → DOP que el mes tenía antes de importarlo. El libro no guarda ni la marca `budget` ni
 * la comisión (`fee`): el envío importado que coincide con uno de ellos (fecha, vía, monto y tasa) conserva las
 * dos, para que exportar y volver a cargar no las pierda. Cada uno vale para un solo envío del libro.
 */
function importedMonth(m: ImportMonth, before: Month | undefined, known: readonly Transfer[], usd: Account, dop: Account, newId: () => string): Month {
  const paidFrom = (cur: Currency) => (cur === 'USD' ? usd.id : dop.id);
  const pending = [...known];
  const kept = (t: ImportMonth['transfers'][number]): Pick<Transfer, 'budget' | 'fee'> => {
    const i = pending.findIndex(
      (b) => b.date === t.date && b.via === t.via && Math.abs(b.amount - t.usd) < HALF_CENT && Math.abs(b.rate - t.rate) < 1e-6,
    );
    if (i < 0) return { budget: false, fee: 0 };
    const [match] = pending.splice(i, 1);
    return { budget: match!.budget, fee: match!.fee || 0 };
  };
  return {
    key: m.key,
    closed: m.closed,
    // Sin reloj aquí: un mes que ya estaba cerrado conserva su fecha; a uno recién cerrado se la pone quien guarde.
    closedAt: m.closed ? (before?.closedAt ?? null) : null,
    // El presupuesto lo pone applyImportToState (budgetFromBook), que necesita los ingresos ya resueltos.
    budgetLog: [],
    budgets: {},
    rates: [],
    fixed: m.fixed.map((f, i) => ({
      id: newId(),
      monthKey: m.key,
      name: f.name,
      day: f.day,
      amount: f.amount,
      cur: f.cur,
      paid: f.paid,
      accountId: paidFrom(f.cur),
      sort: i,
    })),
    transfers: m.transfers.map((t) => ({
      id: newId(),
      monthKey: m.key,
      date: t.date,
      via: t.via,
      fromAccountId: usd.id,
      toAccountId: dop.id,
      amount: t.usd,
      rate: t.rate,
      ...kept(t),
    })),
    tx: m.tx.map((t) => ({
      id: newId(),
      monthKey: m.key,
      date: t.date,
      desc: t.desc,
      place: t.place,
      cat: t.cat,
      method: t.method,
      amount: t.amount,
      cur: t.cur,
      accountId: paidFrom(t.cur),
      notes: t.notes,
      source: 'import',
      createdAt: null,
    })),
    // El libro no conoce los gastos fuera de presupuesto: los del mes que se sustituye se conservan, para que no
    // se pierdan y para que el saldo que se calcula al importar (openingFor) los siga restando, como al exportar.
    ...(before?.outside?.length ? { outside: before.outside } : {}),
    // Tampoco conoce la tarjeta de crédito: sus otros cargos y su pago se conservan con el mes (sus saldos siguen
    // restando lo pagado). Los gastos fijos del archivo nacen sin «en tarjeta», que el libro no trae.
    ...(before?.card ? { card: before.card } : {}),
  };
}

/** Metas y aportes después de importar: ver las reglas en `applyImportToState`. */
function importedSavings(
  base: AppState,
  payload: Pick<ImportPayload, 'goals' | 'contribs'>,
  newId: () => string,
): Pick<AppState, 'goals' | 'contribs'> {
  const exact = new Map<string, Goal>();
  const folded = new Map<string, Goal>();
  // Con nombres repetidos gana la primera meta (menor sort).
  const index = (g: Goal) => {
    if (!exact.has(g.name)) exact.set(g.name, g);
    if (!folded.has(foldName(g.name))) folded.set(foldName(g.name), g);
  };
  [...base.goals].sort((a, b) => a.sort - b.sort).forEach(index);

  const created: Goal[] = [];
  let sort = base.goals.reduce((max, g) => Math.max(max, g.sort), -1);
  const goalNamed = (name: string): Goal => {
    const former = FORMER_GOAL_NAME.get(name);
    let goal = exact.get(name) ?? folded.get(foldName(name)) ?? (former === undefined ? undefined : exact.get(former));
    if (!goal) {
      goal = { id: newId(), name, cur: 'USD', monthly: null, start: null, end: null, approxCur: null, sort: ++sort };
      created.push(goal);
      index(goal);
    }
    return goal;
  };

  /** Lo que el archivo dice de cada meta, por id; de las que no nombra no hay nada y se quedan como estén. */
  const fromFile = new Map<string, ImportGoal>();
  for (const g of payload.goals ?? []) fromFile.set(goalNamed(g.name).id, g);
  // El libro no trae la tasa propia ni la cuenta de origen de un aporte: un aporte que ya existía igual (meta, fecha,
  // monto y moneda) las conserva; uno nuevo nace sin ellas. Cada aporte existente se usa una sola vez.
  const unclaimed = [...base.contribs];
  const contribs: Contribution[] | null =
    payload.contribs &&
    payload.contribs.map((c) => {
      // Primero la meta (si hay que crearla, su id va antes que el del aporte).
      const goalId = goalNamed(c.goalName).id;
      const at = unclaimed.findIndex((o) => o.goalId === goalId && o.date === c.date && o.amount === c.amount && o.cur === c.cur);
      const same = at >= 0 ? unclaimed.splice(at, 1)[0] : undefined;
      return { id: newId(), goalId, date: c.date, amount: c.amount, cur: c.cur, rate: same?.rate ?? null, accountId: same?.accountId ?? null };
    });

  const withPlan = (goal: Goal): Goal => {
    const g = fromFile.get(goal.id);
    if (!g) return goal;
    // El plan del libro es en USD, así que la meta pasa a USD con él; sin plan conserva su moneda.
    return g.monthlyUSD !== null && g.start !== null && g.end !== null
      ? { ...goal, cur: 'USD', monthly: g.monthlyUSD, start: g.start, end: g.end }
      : { ...goal, monthly: null, start: null, end: null };
  };
  return { goals: [...base.goals, ...created].map(withPlan), contribs: contribs ?? base.contribs };
}

/**
 * El estado después de importar un libro ya leído (`parseFinanzasXlsx`). Pura: no modifica `base`, y lo que no
 * cambia se comparte con él. `newId` da el id de cada fila que se crea.
 *
 * Meses (si el archivo trae alguno):
 *  · Las dos cuentas del libro son la primera cuenta visible del usuario en USD y la primera en DOP; la que
 *    falte se crea ("US account" / "DR account", saldo inicial 0, al final de la lista).
 *  · Cada mes del archivo sustituye por completo al que hubiera con esa clave; los que no vienen no se tocan.
 *    Queda cerrado o abierto como diga el archivo, sin tasas escritas a mano y con todo el presupuesto en la
 *    cuenta en DOP, como un solo movimiento 'initial' del primer día del mes (menos lo que ya le suban al
 *    presupuesto los ingresos con `budget: true` que el usuario conserve en ese mes). Sus fijos y transacciones se pagan desde la cuenta en USD si su moneda es USD y desde la de
 *    DOP si no (las transacciones, con source 'import'); cada envío va de la cuenta en USD a la de DOP (y conserva su `budget` y su
 *    comisión si coincide con uno USD → DOP que el mes ya tenía: el libro no guarda ni la marca ni la comisión).
 *  · El ingreso del mes del libro es el total del mes. Los ingresos que el usuario ya tiene registrados con
 *    fecha en ese mes no se tocan; lo que le falte al total (en USD, con las tasas del mes ya importado) pasa a
 *    ser un ingreso en USD el día 1 de ese mes, a la cuenta en USD, con la descripción IMPORTED_INCOME.
 *    Sustituye al que hubiera dejado ahí una importación anterior (reimportar no lo duplica y conserva su id;
 *    si no falta nada, se quita). Si el libro trae menos de lo que el usuario ya tiene, no se resta nada.
 *  · Al final se ajusta el saldo inicial de esas dos cuentas (calc.openingFor) para que, al terminar el último
 *    mes importado, las cuentas visibles en DOP sumen la celda en DOP del libro y las demás visibles (en USD)
 *    la celda en USD: es la misma suma que escribe buildExportData. Con solo esas dos cuentas, cada una queda
 *    con su celda. Los saldos que el libro trae para los meses anteriores no se usan: en la app salen de los
 *    movimientos.
 * Metas (si goals ≠ null): se crean las que falten, en USD, y a las que ya existan se les pone el plan del
 * archivo (una meta que recibe un plan pasa a USD, que es la moneda del libro; si el archivo la trae sin plan,
 * lo pierde y conserva su moneda). Las metas del usuario que no vienen en el archivo se conservan.
 * Aportes (si contribs ≠ null): sustituyen a TODOS los existentes; un aporte a una meta que no existe la crea,
 * sin plan.
 * Las metas se buscan por nombre exacto y, si no aparece, sin distinguir mayúsculas. Además, una de las tres
 * metas de la versión 1 (que el lector ya trae con su nombre de hoy) vale por la que el usuario conserve con
 * el nombre de entonces, para que volver a cargar su propio libro en español no se las duplique.
 * Todo lo demás (otras cuentas, también las de oro con sus ingresos en gramos, ajustes como el precio del oro,
 * meses que no vienen, otros ingresos) queda como estaba.
 *
 * Lo que se pierde o conviene saber (el libro es un resumen hasta que se rediseñe):
 *  · de un mes sustituido se pierden las cuentas de cada gasto, las tasas escritas a mano, el reparto y la
 *    historia del presupuesto y los envíos que el libro no trae (los de otras cuentas): el saldo de esas otras cuentas
 *    cambia en consecuencia y no se corrige;
 *  · solo se ajustan las dos cuentas del libro: la diferencia entre lo que dice el libro y lo que suman las
 *    cuentas visibles cae entera en ellas, también la que venga de otra cuenta;
 *  · un ingreso del libro menor que los que el usuario ya tiene en ese mes no borra ni reduce ninguno;
 *  · las filas nuevas no llevan fecha de alta (createdAt null) y un mes recién cerrado no lleva fecha de cierre
 *    (closedAt null): las pone quien guarde el resultado.
 */
export function applyImportToState(base: AppState, payload: ImportPayload, newId: () => string): AppState {
  let next: AppState = base;

  // Si una clave viniera repetida vale la última, como al leer dos hojas del mismo mes.
  const file = new Map(payload.months.map((m) => [m.key, m]));
  const keys = [...file.keys()].sort();
  const lastKey = keys[keys.length - 1];
  if (lastKey !== undefined) {
    const visible = visibleAccounts(base);
    const accounts = [...base.accounts];
    const bookAccount = (currency: BookCurrency): Account => {
      const found = visible.find((a) => a.currency === currency);
      if (found) return found;
      const sort = accounts.reduce((max, a) => Math.max(max, a.sort), -1) + 1;
      const created: Account = { id: newId(), name: BOOK_ACCOUNT_NAMES[currency], currency, opening: 0, hidden: false, sort };
      accounts.push(created);
      return created;
    };
    const usd = bookAccount('USD');
    const dop = bookAccount('DOP');

    const months = { ...base.months };
    const currencyOf = new Map(base.accounts.map((a) => [a.id, a.currency]));
    for (const key of keys) {
      const known = (base.months[key]?.transfers ?? []).filter(
        (t) => currencyOf.get(t.fromAccountId) === 'USD' && currencyOf.get(t.toAccountId) === 'DOP',
      );
      months[key] = importedMonth(file.get(key)!, base.months[key], known, usd, dop, newId);
    }

    const wasImported = (i: Income) => i.desc === IMPORTED_INCOME && file.has(monthOf(i.date));
    const previous = new Map<MonthKey, Income>();
    for (const i of base.incomes) if (wasImported(i) && !previous.has(monthOf(i.date))) previous.set(monthOf(i.date), i);
    const own = base.incomes.filter((i) => !wasImported(i));
    // El ingreso del libro es el total del mes: lo que el usuario ya tiene registrado en él no se cuenta dos veces.
    const withOwn: AppState = { ...base, months, incomes: own };
    const incomes = [...own];
    for (const key of keys) {
      const amount = file.get(key)!.incomeUSD - incomeInMonth(withOwn, key, 'USD');
      if (!(amount >= HALF_CENT)) continue;
      const before = previous.get(key);
      incomes.push({ id: before?.id ?? newId(), date: `${key}-01`, desc: IMPORTED_INCOME, accountId: usd.id, amount, cur: 'USD', budget: before?.budget ?? false, rate: null, recurring: false });
    }

    // El presupuesto del libro es el total del mes: lo que ya le suben los ingresos con `budget` (que se
    // conservan) y el neto de los envíos importados que conservan la suya (lo que mueven de una cuenta a la otra;
    // en DOP no es 0 si su tasa no es la del mes) no se cuenta dos veces. El resto es un solo movimiento 'initial' en la cuenta en DOP. Su id no
    // sale de newId: es fijo por mes (el mes se sustituye entero), así reimportar no lo cambia.
    const withIncomes: AppState = { ...base, accounts, months, incomes };
    for (const key of keys) {
      const raised = monthCalc(withIncomes, key).budgetParts.reduce(
        (a, p) => a + convert(withIncomes, key, p.fromIncomes + p.fromTransfers, p.account.currency, 'DOP'),
        0,
      );
      const amount = file.get(key)!.budget - raised;
      if (Math.abs(amount) < HALF_CENT) continue;
      const budgetLog = [{ id: `imported-budget-${key}`, date: firstDay(key), accountId: dop.id, amount, kind: 'initial' as const, note: '' }];
      months[key] = { ...months[key]!, budgetLog, budgets: budgetsFromLog(budgetLog) };
    }

    // Con el saldo inicial en cero, openingFor devuelve "saldo del libro − movimientos": no depende del inicial
    // que hubiera, así que reimportar el mismo libro deja exactamente el mismo número.
    const zeroed: AppState = {
      ...base,
      months,
      incomes,
      accounts: accounts.map((a) => (a.id === usd.id || a.id === dop.id ? { ...a, opening: 0 } : a)),
    };
    // Cada celda del libro es la suma de un grupo de cuentas visibles (buildExportData): a la cuenta del libro
    // le toca lo que queda después de las demás cuentas visibles de su grupo, que no se tocan.
    const book = file.get(lastKey)!.accounts;
    // Las cuentas de oro no están en ninguna de las dos celdas (buildExportData): ni se cuentan ni se tocan.
    const others = balances(zeroed, lastKey)
      .accounts.filter(isMoneyBalance)
      .filter((a) => !a.account.hidden && a.account.id !== usd.id && a.account.id !== dop.id);
    const otherDop = others.filter((a) => a.account.currency === 'DOP').reduce((a, b) => a + b.balance, 0);
    const otherUsd = others
      .filter((a) => a.account.currency !== 'DOP')
      .reduce((a, b) => a + convert(zeroed, lastKey, b.balance, b.account.currency, 'USD'), 0);
    const opening = new Map([
      [usd.id, openingFor(zeroed, usd.id, lastKey, book.usd - otherUsd)],
      [dop.id, openingFor(zeroed, dop.id, lastKey, book.dop - otherDop)],
    ]);
    next = { ...zeroed, accounts: zeroed.accounts.map((a) => (opening.has(a.id) ? { ...a, opening: opening.get(a.id)! } : a)) };
  }

  if (payload.goals || payload.contribs) next = { ...next, ...importedSavings(base, payload, newId) };
  return next;
}
