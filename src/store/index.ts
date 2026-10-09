// Punto de entrada de la capa de datos para pantallas y componentes.

export { FinanzasContext, ShellContext, useActions, useFinanzas, useShell } from './context';
export type { Actions, ExcelStatus, Finanzas, MonthDialog, Notice, Shell } from './context';
export { FinanzasProvider } from './FinanzasProvider';
export { accountInUse, canHideAccount, canRemoveAccount, canRemoveCard, canTurnOffCard, cardInUse, isLocalEntry, latestKey, normalizeGoalPlan, snapToTotal } from './reducers';
export type { AccountInput, BudgetEntryInput, CardInput, ContributionInput, FixedInput, GoalInput, GoalPlan, IncomeInput, OutsideInput, TransferInput, TxInput } from './reducers';
export { DEBOUNCE_MS, FinanzasStore, FinanzasStores, SESSION_KEY, stateKey } from './store';
export type { Sheet } from './url';
export { accountOptions, barRate, buildFinanzas, inBoth, incomeAccountOptions, pairRates } from './view';
export type { AccountOption, FinanzasInput, Money, PairRate } from './view';
