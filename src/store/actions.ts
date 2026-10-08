import type { SettingsUpdate } from '../../shared/api';
import { visibleAccounts } from '../../shared/calc';
import { isLanguage } from '../../shared/i18n';
import { clampToMonth, todayISO } from '../../shared/month';
import { isDefaultTheme, normalizeTheme } from '../../shared/theme';
import type { Currency, ISODate, MonthKey, ThemeColors } from '../../shared/types';
import type { Actions } from './context';
import {
  accountName,
  budgetEntry,
  budgetPart,
  canHideAccount,
  canRemoveAccount,
  canRemoveGoal,
  contributionChange,
  currencyChange,
  fixedChange,
  goalChange,
  incomeChange,
  leftoverEntry,
  LOCAL_ENTRY,
  monthRate,
  newAccount,
  newBudgetEntry,
  newContribution,
  newFixed,
  newGoal,
  newIncome,
  newTransfer,
  newTx,
  openingForBalance,
  transferChange,
  txChange,
  typedRate,
} from './reducers';
import type { FinanzasStore } from './store';
import { newId } from './util';

/** Los flujos que no son una simple escritura: los implementa FinanzasProvider (necesitan navegación y avisos). */
export type Flows = Pick<Actions, 'requestCloseMonth' | 'requestDeleteMonth' | 'importExcel' | 'downloadExcel' | 'devSeed' | 'devReset'>;

const sameTheme = (a: ThemeColors | null, b: ThemeColors | null) =>
  a === b || (a !== null && b !== null && a.accent === b.accent && a.header === b.header && a.background === b.background);

/**
 * La API de acciones de las pantallas, atada a la capa de datos de un usuario y al mes seleccionado. Todo se
 * valida aquí (con las reglas de reducers.ts), contra el estado que se ve en ese momento: lo que el servidor
 * rechazaría no llega a enviarse. Las filas nuevas salen con un id generado en el cliente. `today` da la fecha de
 * los movimientos del presupuesto que se escriben ahora: la misma que les pondrá el servidor (su zona horaria).
 */
export function createActions(
  store: FinanzasStore,
  monthKey: MonthKey | null,
  flows: Flows,
  makeId: () => string = newId,
  today: () => ISODate = todayISO,
): Actions {
  const settings = (patch: SettingsUpdate | null) => {
    if (patch && Object.keys(patch).length > 0) store.dispatch({ type: 'settings/patch', patch });
  };
  const setCurrency = (role: 'main' | 'second', currency: Currency) => {
    if (store.state) settings(currencyChange(store.state, role, currency));
  };

  return {
    ...flows,

    setLanguage(language) {
      if (isLanguage(language) && store.state && store.state.language !== language) settings({ language });
    },
    setTheme(theme) {
      const state = store.state;
      const colors = theme === null ? null : normalizeTheme(theme);
      if (!state || (theme !== null && !colors)) return;
      // La paleta original se guarda como null, para que siga los cambios del diseño.
      const next = isDefaultTheme(colors) ? null : colors;
      if (!sameTheme(next, state.theme)) settings({ theme: next });
    },
    setMainCurrency: (currency) => setCurrency('main', currency),
    setSecondCurrency: (currency) => setCurrency('second', currency),
    setDefaultAccount(accountId) {
      const state = store.state;
      if (!state || state.defaultAccountId === accountId) return;
      if (accountId === null || visibleAccounts(state).some((a) => a.id === accountId)) settings({ defaultAccountId: accountId });
    },

    addAccount(input) {
      const state = store.state;
      const row = state ? newAccount(state, input, makeId()) : null;
      if (!row) return false;
      store.dispatch({ type: 'account/add', row });
      return true;
    },
    renameAccount(id, name) {
      const state = store.state;
      const next = state ? accountName(state, id, name) : null;
      if (next !== null) store.dispatch({ type: 'account/patch', id, patch: { name: next } });
    },
    setAccountHidden(id, hidden) {
      const state = store.state;
      const account = state?.accounts.find((a) => a.id === id);
      if (!state || !account || (hidden && !account.hidden && !canHideAccount(state, id))) return false;
      if (account.hidden !== hidden) store.dispatch({ type: 'account/patch', id, patch: { hidden } });
      return true;
    },
    removeAccount(id) {
      const state = store.state;
      if (!state || !canRemoveAccount(state, id)) return false;
      store.dispatch({ type: 'account/remove', id });
      return true;
    },
    setAccountBalance(id, balance) {
      const state = store.state;
      const opening = state && monthKey ? openingForBalance(state, monthKey, id, balance) : null;
      if (opening === null) return false;
      store.dispatch({ type: 'account/patch', id, patch: { opening } });
      return true;
    },

    setBudgetPart(accountId, amount) {
      const state = store.state;
      const patch = state && monthKey ? budgetPart(state, monthKey, accountId, amount) : null;
      if (!patch || !monthKey) return false;
      store.dispatch({ type: 'month/patch', key: monthKey, patch, date: clampToMonth(today(), monthKey) });
      return true;
    },
    addBudgetEntry(input) {
      const state = store.state;
      const row = state && monthKey ? newBudgetEntry(state, monthKey, input, makeId(), today()) : null;
      if (!row || !monthKey) return false;
      store.dispatch({ type: 'budget/add', key: monthKey, row });
      return true;
    },
    removeBudgetEntry(id) {
      const state = store.state;
      if (!state || !monthKey || !budgetEntry(state, monthKey, id)) return false;
      // Una parte que aún esperaba su retraso se calculó contando con este movimiento: sale antes que el borrado.
      store.flush();
      store.dispatch({ type: 'budget/remove', key: monthKey, id });
      return true;
    },
    addLeftover() {
      const state = store.state;
      const row = state && monthKey ? leftoverEntry(state, monthKey, `${LOCAL_ENTRY}${makeId()}`, today()) : null;
      if (!row || !monthKey) return false;
      // El sobrante sale de las cifras del mes anterior y de este: lo pendiente tiene que haber llegado antes.
      store.flush();
      store.dispatch({ type: 'budget/leftover', key: monthKey, row });
      return true;
    },
    setMonthRate(from, to, rate, date) {
      const state = store.state;
      const next = state && monthKey ? monthRate(state, monthKey, from, to, rate, date) : null;
      if (!next || !monthKey) return false;
      store.dispatch({ type: 'rate/set', key: monthKey, rate: next });
      return true;
    },
    removeMonthRate(from, to, date) {
      const state = store.state;
      // Se pide con el sentido en que se guardó: es el que nombra la tasa en el servidor.
      const typed = state && monthKey ? typedRate(state, monthKey, from, to, date) : null;
      if (typed && monthKey) store.dispatch({ type: 'rate/remove', key: monthKey, from: typed.from, to: typed.to, date: typed.date });
    },

    addFixed(input) {
      const state = store.state;
      const row = state && monthKey ? newFixed(state, monthKey, input, makeId()) : null;
      if (!row) return false;
      store.dispatch({ type: 'fixed/add', row });
      return true;
    },
    patchFixed(id, patch) {
      if (store.state) store.dispatch({ type: 'fixed/patch', id, patch: fixedChange(store.state, patch) });
    },
    removeFixed: (id) => store.dispatch({ type: 'fixed/remove', id }),

    addTx(input) {
      const state = store.state;
      const row = state && monthKey ? newTx(state, monthKey, input, makeId()) : null;
      if (!row) return false;
      store.dispatch({ type: 'tx/add', row });
      return true;
    },
    patchTx(id, patch) {
      if (store.state) store.dispatch({ type: 'tx/patch', id, patch: txChange(store.state, patch) });
    },
    removeTx: (id) => store.dispatch({ type: 'tx/remove', id }),

    addTransfer(input) {
      const state = store.state;
      const row = state && monthKey ? newTransfer(state, monthKey, input, makeId()) : null;
      if (!row) return false;
      store.dispatch({ type: 'transfer/add', row });
      return true;
    },
    patchTransfer(id, patch) {
      if (store.state) store.dispatch({ type: 'transfer/patch', id, patch: transferChange(store.state, id, patch) });
    },
    removeTransfer: (id) => store.dispatch({ type: 'transfer/remove', id }),

    addIncome(input) {
      const state = store.state;
      const row = state ? newIncome(state, input, makeId()) : null;
      if (!row) return false;
      store.dispatch({ type: 'income/add', row });
      return true;
    },
    patchIncome(id, patch) {
      if (store.state) store.dispatch({ type: 'income/patch', id, patch: incomeChange(store.state, patch) });
    },
    removeIncome: (id) => store.dispatch({ type: 'income/remove', id }),

    addContribution(input) {
      const state = store.state;
      const row = state ? newContribution(state, input, makeId()) : null;
      if (!row) return false;
      store.dispatch({ type: 'contribution/add', row });
      return true;
    },
    patchContribution(id, patch) {
      if (store.state) store.dispatch({ type: 'contribution/patch', id, patch: contributionChange(store.state, patch) });
    },
    removeContribution: (id) => store.dispatch({ type: 'contribution/remove', id }),

    addGoal(input) {
      const state = store.state;
      const row = state ? newGoal(state, input, makeId()) : null;
      if (!row) return false;
      store.dispatch({ type: 'goal/add', row });
      return true;
    },
    patchGoal(id, patch) {
      const state = store.state;
      const change = state ? goalChange(state, id, patch) : null;
      if (!change) return false;
      if (Object.keys(change).length > 0) store.dispatch({ type: 'goal/patch', id, patch: change });
      return true;
    },
    removeGoal(id) {
      const state = store.state;
      if (!state || !canRemoveGoal(state, id)) return false;
      store.dispatch({ type: 'goal/remove', id });
      return true;
    },

    reopenMonth(key = monthKey ?? undefined) {
      if (key) store.dispatch({ type: 'month/reopen', key });
    },

    flush: () => store.flush(),
  };
}
