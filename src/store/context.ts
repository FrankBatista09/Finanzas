// What the screens and the shared components consume. FinanzasProvider fills the contexts;
// they are exported so a test can mount a standalone component with a fixed value (buildFinanzas, in view.ts,
// builds the one for useFinanzas() from a state).
//
// The texts do not live here: they come from useI18n() and useStrings() (src/i18n), which follow the user's language
// (state.language) and bring the helpers bound to it (months, categories, methods, the source of a rate).

import { createContext, useContext } from 'react';
import type { CloseRequest, ContributionPatch, CreditCardPatch, FixedPatch, GoalPatch, IncomePatch, OutsidePatch, TransferPatch, TxPatch } from '../../shared/api';
import type { Balances, Leftover, MonthCalc, MoneyAccount, RateInfo } from '../../shared/calc';
import type { Account, AppState, AppUser, Currency, ISODate, Language, Month, MonthKey, ThemeColors } from '../../shared/types';
import type {
  AccountInput,
  BudgetEntryInput,
  CardInput,
  ContributionInput,
  FixedInput,
  GoalInput,
  IncomeInput,
  OutsideInput,
  TransferInput,
  TxInput,
} from './reducers';
import type { Sheet } from './url';
import type { AccountOption, Money, PairRate } from './view';

/**
 * All the writes, on the current user's data. They are optimistic: the change shows at once and, if the
 * server rejects it, it is undone and a notice appears. What the contract (shared/api.ts) would reject is checked
 * beforehand and never gets sent: the ones that add return false, and cell edits ignore the field that is not
 * valid (the cell gets its value back on leaving). The object is stable as long as the user, the selected
 * month and the language do not change (the flows' notices come out in the language of the moment).
 */
export interface Actions {
  // ── Settings ───────────────────────────────────────────────────────────────
  /** Changes this user's interface (and Excel) language. Saved at once. */
  setLanguage(language: Language): void;
  /**
   * Changes this user's colors; null (or the original colors) goes back to the default palette.
   * It shows at once and is saved with the same delay as a cell. A theme with any invalid color is ignored.
   */
  setTheme(theme: ThemeColors | null): void;
  /**
   * Changes the main currency (the one for the budget, totals and columns). Picking the one that is currently the
   * second swaps them, in a single request. Saved at once.
   */
  setMainCurrency(currency: Currency): void;
  /** Changes the second currency (the one for the "≈" lines). Picking the one that is currently the main one swaps them. */
  /** null = no second currency. */
  setSecondCurrency(currency: Currency | null): void;
  /** The account an expense comes out of when no other is given: a visible money account (not a gold one), or null for the automatic one. */
  setDefaultAccount(accountId: string | null): void;
  /**
   * The gold price: what 1 gram is worth, in one of the three currencies. With it the gold accounts add to the total
   * money; an amount of 0 (the empty field) removes it and they show only in grams again. false if the amount is not
   * a number >= 0. Saved with the same delay as a cell.
   */
  setGoldPrice(amount: number, currency: Currency): boolean;

  // ── Accounts ───────────────────────────────────────────────────────────────
  /** Creates an account at the end of the list. false if the name is missing, the currency is neither one of the three nor gold, or the opening balance is not a number. */
  addAccount(input: AccountInput): boolean;
  /** A blank name is ignored (it is required): the cell gets its value back on leaving. */
  renameAccount(id: string, name: string): void;
  /** Hides an account or shows it again. false if it does not exist or if it is the last visible money account (that one cannot be hidden). */
  setAccountHidden(id: string, hidden: boolean): boolean;
  /** Deletes an account. false (and does nothing) if it does not exist or something uses it: that one is hidden instead. */
  removeAccount(id: string): boolean;
  /**
   * Corrects an account's balance: the user types the balance they really have, and the opening balance that
   * produces it at the end of the selected month is stored (shared/calc openingFor). false (and does nothing) if the
   * selected month is not the user's latest (useFinanzas().latestMonth): past balances are history.
   */
  setAccountBalance(id: string, balance: number): boolean;

  // ── The selected month ─────────────────────────────────────────────────────
  /**
   * The part of the selected month's budget that comes out of that account, in the account's currency, as it is
   * shown (with what the incomes that raise the budget add to it). The budget is not overwritten: the server
   * appends the difference to its log. 0 brings what the log adds up to down to zero. false if the account does not
   * exist, the amount is not a number >= 0, it falls below what those incomes already add up to, or the month is closed.
   */
  setBudgetPart(accountId: string, amount: number): boolean;
  /**
   * Adds a movement to the selected month's budget log (it adds to or subtracts from an account's part). false if
   * the account does not exist, the amount is 0 or not a number, the date is not in the month or the month is closed.
   */
  addBudgetEntry(input: BudgetEntryInput): boolean;
  /**
   * Removes a movement from the selected month's budget log (not an income: that one is edited as an
   * income). false if it is not there, if the month is closed, or if it was just added and has no server id yet.
   */
  removeBudgetEntry(id: string): boolean;
  /**
   * Adds what was left over from the previous month (useFinanzas().leftover) to the selected month's budget, only once.
   * false if there is no previous month, it was already added, the leftover was 0 or the month is closed.
   */
  addLeftover(): boolean;
  /**
   * Types a pair's rate by hand, from a date in the selected month: 1 `from` = `rate` `to`. There is one per pair
   * and date: it replaces the one for that date, whichever direction it had; the ones for other dates still apply to
   * what was recorded earlier. false if the currencies are the same, the rate is not > 0 (a half-typed cell), the date
   * is not in the month or the month is closed.
   */
  setMonthRate(from: Currency, to: Currency, rate: number, date: ISODate): boolean;
  /** Removes the typed rate for that pair (in either direction) and that date of the selected month. */
  removeMonthRate(from: Currency, to: Currency, date: ISODate): void;

  /** A credit card's "Other charges" in the selected month (in the credit card's currency, >= 0). false if the amount is not valid or the month is closed. */
  setCardOther(cardId: string, other: number): boolean;
  /** The cashback a credit card generated in the selected month (its currency, >= 0). false if not valid, the card has no cashback or the month is closed. */
  setCardCashback(cardId: string, cashback: number): boolean;
  /**
   * Adds a payment on that credit card in the selected month: `amount` in the credit card's currency (> 0 and at most what is left,
   * `CardCalc.remainder`) from that money account, dated today. There can be several payments in the month. false if it cannot be done.
   */
  payCard(cardId: string, amount: number, accountId: string): boolean;
  /** Removes all the payments on that credit card in the selected month. */
  unpayCard(cardId: string): void;
  /** Removes one payment on that credit card in the selected month. */
  removeCardPayment(cardId: string, id: string): void;

  /** Adds a credit card (at the end). false if the name is missing, it is a duplicate or some field is not valid. */
  addCard(input: CardInput): boolean;
  /** Edits a credit card. false if it cannot be done (e.g. turning it off while something is owed on it: see canTurnOffCard). */
  patchCard(id: string, patch: CreditCardPatch): boolean;
  /** Deletes a credit card that nothing uses. false if it is in use. */
  removeCard(id: string): boolean;

  /** Adds to the selected month. false if the item is missing, the amount is not > 0 or the given account does not exist. */
  addFixed(input: FixedInput): boolean;
  /** A blank `name`, a negative `amount` and an `accountId` that does not exist are ignored. */
  patchFixed(id: string, patch: FixedPatch): void;
  removeFixed(id: string): void;

  /** Adds to the selected month. false if the description is missing, the date is not valid, the amount is not > 0 or the given account does not exist. */
  addTx(input: TxInput): boolean;
  /** A blank `desc`, a negative `amount` and an `accountId` that does not exist are ignored. */
  patchTx(id: string, patch: TxPatch): void;
  removeTx(id: string): void;

  /** Adds an outside-budget expense to the selected month. false if the name is missing, the date is not valid, the amount is not > 0 or the given account does not exist or is a gold account. */
  addOutside(input: OutsideInput): boolean;
  /** A blank `name`, a negative `amount` and an `accountId` that does not exist are ignored. */
  patchOutside(id: string, patch: OutsidePatch): void;
  removeOutside(id: string): void;
  /** Moves a transaction of the selected month to "Outside budget" (a single call to the server: it is neither duplicated nor lost). */
  moveTxOutside(id: string): void;
  /** The reverse path: category "Other", method "Transfer" and no place. */
  moveOutsideToBudget(id: string): void;

  /**
   * Adds a transfer from one account to another to the selected month. false if the via (free text) is blank, the date
   * is not valid, the amount is not > 0, either account does not exist, both are the same or the given rate is not > 0.
   * With no `rate`, the pair's rate in effect on the transfer's date is used; between same-currency accounts it is always 1.
   */
  addTransfer(input: TransferInput): boolean;
  /**
   * Edits a transfer. What is not valid is ignored: a blank via, a negative amount, a rate that is not > 0 and an
   * account change that would leave an account that does not exist or the same one on both sides. If changing the account
   * changes the transfer's currencies and no other rate comes with it, the rate becomes the month rate for the new pair.
   */
  patchTransfer(id: string, patch: TransferPatch): void;
  removeTransfer(id: string): void;

  // ── Incomes, goals and contributions (they do not belong to a month) ───────
  /**
   * false if the date is not valid, the amount is not > 0 or the given account does not exist. Any date is valid, even
   * one in a closed month. With `budget: true` the income also raises the budget of the month of its date. A gold
   * account takes in grams: the income stays in XAU and never raises the budget.
   */
  addIncome(input: IncomeInput): boolean;
  /**
   * An invalid date, a negative `amount` and an `accountId` that does not exist are ignored. Moving the income to a
   * gold account leaves it in grams and not raising the budget; moving it out of one, in the new account's currency.
   */
  patchIncome(id: string, patch: IncomePatch): void;
  removeIncome(id: string): void;

  /** false if the goal does not exist, the date is not valid or the amount is not > 0. */
  addContribution(input: ContributionInput): boolean;
  /** A `goalId` that does not exist, an invalid date and a negative `amount` are ignored. */
  patchContribution(id: string, patch: ContributionPatch): void;
  removeContribution(id: string): void;

  /**
   * Creates a goal at the end of the list, in the given currency (by default, the main one) and with its "≈" currency
   * (`approxCur`; null or not given, the main one). false (and does nothing)
   * if the name is missing or the plan breaks the rule: no plan (monthly, start and end null or undefined) or all
   * three (monthly > 0, start <= end).
   */
  addGoal(input: GoalInput): boolean;
  /**
   * Edits a goal. false (and does nothing) if it does not exist, the name ends up blank or the resulting plan breaks
   * the rule; to remove the plan, all three fields must be sent as null. A patch with no changes returns true.
   */
  patchGoal(id: string, patch: GoalPatch): boolean;
  /** Deletes a goal. false (and does nothing) if it does not exist or has contributions. */
  removeGoal(id: string): boolean;

  // ── Flows ──────────────────────────────────────────────────────────────────
  /** Opens the close-month dialog for the selected month (the dialog lives in App). */
  requestCloseMonth(): void;
  /** Reopens a closed month; by default, the selected one. */
  reopenMonth(key?: MonthKey): void;
  /**
   * Opens the dialog to delete a month (by default, the selected one), open or closed. The dialog lives in App:
   * it says what will be deleted and, if confirmed, deletes the month and leaves the user's current month selected.
   */
  requestDeleteMonth(key?: MonthKey): void;

  /** Reads the .xlsx in the browser, sends its content to the server, reloads the state and selects the last imported month. Never rejects. */
  importExcel(file: File): Promise<void>;
  /** Saves what is pending and downloads the user's Excel, generated in the browser, in their language, from the server's state. Never rejects (if it fails, it shows a notice). */
  downloadExcel(months?: readonly MonthKey[]): Promise<void>;
  /** Only if the server exposes /api/dev/*: loads the current user's sample data. */
  devSeed(): Promise<void>;
  /** Only if the server exposes /api/dev/*: leaves the current user blank. */
  devReset(): Promise<void>;

  /** Immediately sends the cell edits that were waiting out their delay. (Losing focus already does this by itself.) */
  flush(): void;
}

export interface Finanzas {
  /** Whose data is on screen (the one from the top bar's select). */
  user: AppUser;
  /** That user's whole history, with the optimistic edits already applied. Their language is state.language. */
  state: AppState;
  /** Selected month (?month=…; if it is missing or does not exist, the current month). */
  monthKey: MonthKey;
  month: Month;
  /** monthCalc(state, monthKey) from shared/calc.ts: the month's figures, in the main currency. */
  calc: MonthCalc;
  /** 1 second = `rate.rate` main in the selected month (= calc.rate), with its source (`rate.source`); null with no second currency. */
  rate: RateInfo | null;
  /** The top bar's rate: second → main or, with no second, the first one that is needed; null if none is needed. */
  barRate: PairRate | null;

  /** The user's main currency (= state.mainCurrency): the one for the budget, totals and the first amount column. */
  main: Currency;
  /** Second currency (= state.secondCurrency): the one for the "≈" lines and the second amount column; null = none, nothing is shown in it. */
  second: Currency | null;
  /**
   * An amount in the main currency and in the second one, with a month's rates (by default, the selected one):
   * both columns of a table come from one call. With `date`, with the rate in effect that day: that is what a
   * row with its own date gets (a transaction: `inBoth(t.amount, t.cur, undefined, t.date)`); without it, with the
   * month's last one (a fixed expense, a total).
   * The function changes with every state change: a memoized row is passed the figures, not the function.
   */
  inBoth(amount: number, cur: Currency, key?: MonthKey, date?: ISODate): Money;
  /** The selected month's rates, one per currency pair and already resolved, with the source of each one (view.ts pairRates). */
  rates: readonly PairRate[];
  /** The `from` → `to` rate of a month (by default, the selected one; with `date`, the one in effect that day), with its source: rateFor from shared/calc.ts. */
  rateOf(from: Currency, to: Currency, key?: MonthKey, date?: ISODate): RateInfo;
  /** The leftover from the month before the selected one and whether it was already added to its budget (shared/calc leftoverFor). */
  leftover: Leftover;

  /** All of the user's accounts, hidden ones too, in their order. */
  accounts: readonly Account[];
  /**
   * The money accounts shown in the lists and selects of the Month sheet and of the settings. The gold ones are
   * not here: they only show in "Savings" (they come from `balances`) and in the incomes (`incomeAccountOptions`).
   */
  visibleAccounts: readonly MoneyAccount[];
  /** The account an expense comes out of when no other is given (shared/calc defaultAccount); null only if there are no money accounts. */
  defaultAccount: MoneyAccount | null;
  /**
   * Options of an account select ({ value: id, label: name }) for what is money (expenses, transfers): the
   * visible ones that are not gold and, after them, the ones passed in that are not among them (the account of a row
   * that was hidden afterwards): `accountOptions(row.accountId)`.
   */
  accountOptions(...include: (string | null | undefined)[]): AccountOption[];
  /** Like `accountOptions`, with the gold accounts too: which account an income goes into. */
  incomeAccountOptions(...include: (string | null | undefined)[]): AccountOption[];
  /** Balances of all the accounts at the end of the selected month and the "Total money" (shared/calc balances). */
  balances: Balances;
  /** The selected month is the user's latest: only then can a balance be corrected (actions.setAccountBalance). */
  latestMonth: boolean;

  /** The selected month is closed: read-only cells, no add rows or × buttons. */
  readOnly: boolean;
  /** Today in the user's time zone. */
  today: ISODate;
  /** Initial date of the add rows: today if the selected month is today's; otherwise, its day 1. */
  draftDate: ISODate;
  actions: Actions;
}

export interface Notice {
  id: number;
  text: string;
}

/** How an Excel import is going; the top bar supplies the text in the current language. */
export type ExcelStatus = { kind: 'reading' } | { kind: 'loaded'; file: string } | { kind: 'failed' };

/** A confirmation dialog open for that month; `busy` while the operation is in progress. */
export interface MonthDialog {
  key: MonthKey;
  busy: boolean;
}

/** State of the shell (top bar, tabs, dialogs, notices). It always exists, whether there is data or not. */
export interface Shell {
  /** 'ready' as soon as there is data, even if a later refresh fails. */
  status: 'loading' | 'error' | 'ready';
  /** Requests the state from the server again. */
  retry(): void;
  retrying: boolean;

  /** Configured users (GET /api/session); empty until the session arrives. */
  users: readonly AppUser[];
  /** Current user; null until the session arrives. */
  user: AppUser | null;
  /** Switches users: sends what the previous one had pending and loads the other one's data, language and colors. */
  goToUser(id: string): void;
  /** Language in use: the user's or, before their data is available, the last one used on this device. */
  language: Language;

  sheet: Sheet;
  goToSheet(sheet: Sheet): void;
  goToMonth(key: MonthKey): void;

  /** SessionResponse.devTools: shows "Start blank" and "Restore sample data". */
  devTools: boolean;
  /** State of the "Import Excel" button after an import; null = the normal text. */
  excelStatus: ExcelStatus | null;

  /** Close-month dialog open for that month; `busy` while it is being closed. */
  closeDialog: MonthDialog | null;
  /** `request`: the next month's initial parts and whether the leftover is added to it; without it, the server copies this month's. */
  confirmClose(withExcel: boolean, request?: CloseRequest): void;
  cancelClose(): void;

  /** Delete-month dialog open for that month; `busy` while it is being deleted. */
  deleteDialog: MonthDialog | null;
  confirmDelete(): void;
  cancelDelete(): void;

  notices: readonly Notice[];
  dismissNotice(id: number): void;
}

export const FinanzasContext = createContext<Finanzas | null>(null);
export const ShellContext = createContext<Shell | null>(null);

/** Data and actions for the screens. It can only be used once the state is loaded (inside the screens it is). */
export function useFinanzas(): Finanzas {
  const value = useContext(FinanzasContext);
  if (!value) throw new Error('useFinanzas() necesita el estado cargado: úsalo dentro de <FinanzasProvider>, en una pantalla.');
  return value;
}

/** Shortcut for useFinanzas().actions. */
export function useActions(): Actions {
  return useFinanzas().actions;
}

export function useShell(): Shell {
  const value = useContext(ShellContext);
  if (!value) throw new Error('useShell() necesita <FinanzasProvider>.');
  return value;
}
