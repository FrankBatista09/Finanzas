// Punto de entrada de la capa de datos para pantallas y componentes.

export { FinanzasContext, ShellContext, useActions, useFinanzas, useShell } from './context';
export type { Actions, ExcelStatus, Finanzas, MonthDialog, Notice, Shell } from './context';
export { FinanzasProvider } from './FinanzasProvider';
export { accountInUse, canHideAccount, canRemoveAccount, isLocalEntry, latestKey, normalizeGoalPlan } from './reducers';
export type { AccountInput, BudgetEntryInput, ContributionInput, FixedInput, GoalInput, GoalPlan, IncomeInput, TransferInput, TxInput } from './reducers';
export { DEBOUNCE_MS, FinanzasStore, FinanzasStores, SESSION_KEY, stateKey } from './store';
export type { Sheet } from './url';
export { accountOptions, buildFinanzas, inBoth, pairRates } from './view';
export type { AccountOption, FinanzasInput, Money, PairRate } from './view';
