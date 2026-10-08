// Lo que consumen las pantallas y los componentes comunes. Los contextos los llena FinanzasProvider;
// se exportan para poder montar un componente suelto en una prueba con un valor fijo (buildFinanzas, en view.ts,
// arma el de useFinanzas() a partir de un estado).
//
// Los textos no van aquí: salen de useI18n() y useStrings() (src/i18n), que siguen el idioma del usuario
// (state.language) y traen los ayudantes atados a él (meses, categorías, métodos, origen de una tasa).

import { createContext, useContext } from 'react';
import type { ContributionPatch, FixedPatch, GoalPatch, IncomePatch, TransferPatch, TxPatch } from '../../shared/api';
import type { Balances, MonthCalc, RateInfo } from '../../shared/calc';
import type { Account, AppState, AppUser, Currency, ISODate, Language, Month, MonthKey, ThemeColors } from '../../shared/types';
import type { AccountInput, ContributionInput, FixedInput, GoalInput, IncomeInput, TransferInput, TxInput } from './reducers';
import type { Sheet } from './url';
import type { AccountOption, Money, PairRate } from './view';

/**
 * Todas las escrituras, sobre los datos del usuario actual. Son optimistas: el cambio se ve en el acto y, si el
 * servidor lo rechaza, se deshace y aparece un aviso. Lo que el contrato (shared/api.ts) rechazaría se comprueba
 * antes y no llega a enviarse: las que agregan devuelven false, y las ediciones de celda ignoran el campo que no
 * vale (la celda recupera su valor al salir). El objeto es estable mientras no cambien el usuario, el mes
 * seleccionado ni el idioma (los avisos de los flujos salen en el idioma del momento).
 */
export interface Actions {
  // ── Ajustes ────────────────────────────────────────────────────────────────
  /** Cambia el idioma de la interfaz (y del Excel) de este usuario. Se guarda en el acto. */
  setLanguage(language: Language): void;
  /**
   * Cambia los colores de este usuario; null (o los colores originales) vuelve a la paleta por defecto.
   * Se ve en el acto y se guarda con el mismo retraso que una celda. Un tema con algún color no válido se ignora.
   */
  setTheme(theme: ThemeColors | null): void;
  /**
   * Cambia la moneda principal (la de presupuesto, totales y columnas). Elegir la que hoy es la segunda las
   * intercambia, en una sola petición. Se guarda en el acto.
   */
  setMainCurrency(currency: Currency): void;
  /** Cambia la segunda moneda (la de las líneas "≈"). Elegir la que hoy es la principal las intercambia. */
  setSecondCurrency(currency: Currency): void;
  /** La cuenta de la que sale un gasto cuando no se indica otra: una cuenta visible, o null para la automática. */
  setDefaultAccount(accountId: string | null): void;

  // ── Cuentas ────────────────────────────────────────────────────────────────
  /** Crea una cuenta al final de la lista. false si falta el nombre, la moneda no es una de las tres o el saldo inicial no es un número. */
  addAccount(input: AccountInput): boolean;
  /** Un nombre en blanco se ignora (es obligatorio): la celda recupera su valor al salir. */
  renameAccount(id: string, name: string): void;
  /** Oculta o vuelve a mostrar una cuenta. false si no existe o si es la última visible (esa no se puede ocultar). */
  setAccountHidden(id: string, hidden: boolean): boolean;
  /** Elimina una cuenta. false (y no hace nada) si no existe o algo la usa: esa se oculta. */
  removeAccount(id: string): boolean;
  /**
   * Corrige el saldo de una cuenta: el usuario escribe el saldo que tiene de verdad y se guarda el saldo inicial
   * que lo produce al final del mes seleccionado (shared/calc openingFor). false (y no hace nada) si el mes
   * seleccionado no es el último del usuario (useFinanzas().latestMonth): los saldos pasados son historia.
   */
  setAccountBalance(id: string, balance: number): boolean;

  // ── El mes seleccionado ────────────────────────────────────────────────────
  /**
   * La parte del presupuesto del mes seleccionado que sale de esa cuenta, en la moneda de la cuenta; 0 la quita.
   * false si la cuenta no existe, el monto no es un número o el mes está cerrado.
   */
  setBudgetPart(accountId: string, amount: number): boolean;
  /**
   * Escribe a mano la tasa de un par para el mes seleccionado: 1 `from` = `rate` `to`. Hay una sola por par:
   * sustituye a la que hubiera, en el sentido que fuera. false si las monedas son la misma, la tasa no es > 0
   * (una celda a medio escribir) o el mes está cerrado.
   */
  setMonthRate(from: Currency, to: Currency, rate: number): boolean;
  /** Quita la tasa escrita de ese par (en cualquiera de los dos sentidos) del mes seleccionado. */
  removeMonthRate(from: Currency, to: Currency): void;

  /** Agrega al mes seleccionado. false si falta el concepto, el monto no es > 0 o la cuenta indicada no existe. */
  addFixed(input: FixedInput): boolean;
  /** Se ignoran un `name` en blanco, un `amount` negativo y un `accountId` que no exista. */
  patchFixed(id: string, patch: FixedPatch): void;
  removeFixed(id: string): void;

  /** Agrega al mes seleccionado. false si falta la descripción, la fecha no es válida, el monto no es > 0 o la cuenta indicada no existe. */
  addTx(input: TxInput): boolean;
  /** Se ignoran un `desc` en blanco, un `amount` negativo y un `accountId` que no exista. */
  patchTx(id: string, patch: TxPatch): void;
  removeTx(id: string): void;

  /**
   * Agrega al mes seleccionado un envío de una cuenta a otra. false si la vía (texto libre) está en blanco, la fecha
   * no es válida, el monto no es > 0, alguna cuenta no existe, las dos son la misma o la tasa indicada no es > 0.
   * Sin `rate` se usa la tasa del mes para ese par; entre cuentas de la misma moneda siempre es 1.
   */
  addTransfer(input: TransferInput): boolean;
  /**
   * Edita un envío. Se ignora lo que no vale: una vía en blanco, un monto negativo, una tasa que no sea > 0 y un
   * cambio de cuenta que dejaría una cuenta que no existe o la misma en los dos lados. Si al cambiar de cuenta
   * cambian las monedas del envío y no viene otra tasa, la tasa pasa a ser la del mes para el par nuevo.
   */
  patchTransfer(id: string, patch: TransferPatch): void;
  removeTransfer(id: string): void;

  // ── Ingresos, metas y aportes (no pertenecen a un mes) ─────────────────────
  /** false si la fecha no es válida, el monto no es > 0 o la cuenta indicada no existe. Vale cualquier fecha, también de un mes cerrado. */
  addIncome(input: IncomeInput): boolean;
  /** Se ignoran una fecha no válida, un `amount` negativo y un `accountId` que no exista. */
  patchIncome(id: string, patch: IncomePatch): void;
  removeIncome(id: string): void;

  /** false si la meta no existe, la fecha no es válida o el monto no es > 0. */
  addContribution(input: ContributionInput): boolean;
  /** Se ignoran un `goalId` que no exista, una fecha no válida y un `amount` negativo. */
  patchContribution(id: string, patch: ContributionPatch): void;
  removeContribution(id: string): void;

  /**
   * Crea una meta al final de la lista, en la moneda indicada (por defecto, la principal). false (y no hace nada)
   * si falta el nombre o el plan no cumple la regla: sin plan (monthly, start y end en null o sin definir) o con
   * los tres (monthly > 0, start <= end).
   */
  addGoal(input: GoalInput): boolean;
  /**
   * Edita una meta. false (y no hace nada) si no existe, el nombre queda en blanco o el plan resultante no cumple
   * la regla; para quitar el plan hay que mandar los tres campos en null. Un patch sin cambios devuelve true.
   */
  patchGoal(id: string, patch: GoalPatch): boolean;
  /** Elimina una meta. false (y no hace nada) si no existe o tiene aportes. */
  removeGoal(id: string): boolean;

  // ── Flujos ─────────────────────────────────────────────────────────────────
  /** Abre el modal de cierre del mes seleccionado (el modal vive en App). */
  requestCloseMonth(): void;
  /** Reabre un mes cerrado; por defecto, el seleccionado. */
  reopenMonth(key?: MonthKey): void;
  /**
   * Abre el diálogo para borrar un mes (por defecto, el seleccionado), abierto o cerrado. El diálogo vive en App:
   * dice qué se va a borrar y, si se confirma, borra el mes y deja seleccionado el mes en curso del usuario.
   */
  requestDeleteMonth(key?: MonthKey): void;

  /** Lee el .xlsx en el navegador, manda su contenido al servidor, recarga el estado y selecciona el último mes importado. Nunca rechaza. */
  importExcel(file: File): Promise<void>;
  /** Guarda lo pendiente y descarga el Excel del usuario, generado en el navegador, en su idioma, con el estado del servidor. Nunca rechaza (si falla, avisa). */
  downloadExcel(months?: readonly MonthKey[]): Promise<void>;
  /** Solo si el servidor expone /api/dev/*: carga los datos de ejemplo del usuario actual. */
  devSeed(): Promise<void>;
  /** Solo si el servidor expone /api/dev/*: deja en blanco al usuario actual. */
  devReset(): Promise<void>;

  /** Manda ya las ediciones de celda que esperaban su retraso. (Al perder el foco ya se hace solo.) */
  flush(): void;
}

export interface Finanzas {
  /** De quién son los datos que se ven (el del selector de la barra superior). */
  user: AppUser;
  /** Todo el histórico de ese usuario, con las ediciones optimistas ya aplicadas. Su idioma es state.language. */
  state: AppState;
  /** Mes seleccionado (?month=…; si falta o no existe, el mes en curso). */
  monthKey: MonthKey;
  month: Month;
  /** monthCalc(state, monthKey) de shared/calc.ts: las cifras del mes, en la moneda principal. */
  calc: MonthCalc;
  /** 1 segunda = `rate.rate` principal en el mes seleccionado (= calc.rate), con su origen (`rate.source`). */
  rate: RateInfo;

  /** Moneda principal del usuario (= state.mainCurrency): la de presupuesto, totales y la primera columna de importes. */
  main: Currency;
  /** Segunda moneda (= state.secondCurrency): la de las líneas "≈" y la segunda columna de importes. */
  second: Currency;
  /**
   * Un importe en la moneda principal y en la segunda, con las tasas de un mes (por defecto, el seleccionado):
   * las dos columnas de una tabla salen de una llamada. Lo que pertenece a un mes usa las de ese mes; un ingreso
   * o un aporte, las del mes de su fecha: `inBoth(c.amount, c.cur, monthOf(c.date))`.
   * La función cambia con cada cambio de estado: a una fila memorizada se le pasan las cifras, no la función.
   */
  inBoth(amount: number, cur: Currency, key?: MonthKey): Money;
  /** Las tasas del mes seleccionado, una por par de monedas y ya resueltas, con el origen de cada una (view.ts pairRates). */
  rates: readonly PairRate[];
  /** La tasa `from` → `to` de un mes (por defecto, el seleccionado), con su origen: rateFor de shared/calc.ts. */
  rateOf(from: Currency, to: Currency, key?: MonthKey): RateInfo;

  /** Todas las cuentas del usuario, también las ocultas, en su orden. */
  accounts: readonly Account[];
  /** Las que se muestran en listas y selectores. */
  visibleAccounts: readonly Account[];
  /** La cuenta de la que sale un gasto cuando no se indica otra (shared/calc defaultAccount); null solo si no hay cuentas. */
  defaultAccount: Account | null;
  /**
   * Opciones de un selector de cuenta ({ value: id, label: nombre }): las visibles y, detrás, las que se pasen y
   * no estén entre ellas (la cuenta de una fila que después se ocultó): `accountOptions(row.accountId)`.
   */
  accountOptions(...include: (string | null | undefined)[]): AccountOption[];
  /** Saldos de todas las cuentas al final del mes seleccionado y el "Total money" (shared/calc balances). */
  balances: Balances;
  /** El mes seleccionado es el último del usuario: solo entonces se puede corregir un saldo (actions.setAccountBalance). */
  latestMonth: boolean;

  /** El mes seleccionado está cerrado: celdas de solo lectura, sin filas de agregar ni botones ×. */
  readOnly: boolean;
  /** Hoy en la zona horaria del usuario. */
  today: ISODate;
  /** Fecha inicial de las filas de agregar: hoy si el mes seleccionado es el de hoy; si no, su día 1. */
  draftDate: ISODate;
  actions: Actions;
}

export interface Notice {
  id: number;
  text: string;
}

/** En qué va la carga de un Excel; el texto lo pone la barra superior en el idioma actual. */
export type ExcelStatus = { kind: 'reading' } | { kind: 'loaded'; file: string } | { kind: 'failed' };

/** Un diálogo de confirmación abierto para ese mes; `busy` mientras la operación está en curso. */
export interface MonthDialog {
  key: MonthKey;
  busy: boolean;
}

/** Estado de la carcasa (cabecera, pestañas, modales, avisos). Existe siempre, haya datos o no. */
export interface Shell {
  /** 'ready' en cuanto hay datos, aunque un refresco posterior falle. */
  status: 'loading' | 'error' | 'ready';
  /** Vuelve a pedir el estado al servidor. */
  retry(): void;
  retrying: boolean;

  /** Usuarios configurados (GET /api/session); vacío hasta que llega la sesión. */
  users: readonly AppUser[];
  /** Usuario actual; null hasta que llega la sesión. */
  user: AppUser | null;
  /** Cambia de usuario: manda lo pendiente del anterior y carga los datos, el idioma y los colores del otro. */
  goToUser(id: string): void;
  /** Idioma en uso: el del usuario o, antes de tener sus datos, el último usado en este dispositivo. */
  language: Language;

  sheet: Sheet;
  goToSheet(sheet: Sheet): void;
  goToMonth(key: MonthKey): void;

  /** SessionResponse.devTools: muestra "Start blank" y "Restore sample data". */
  devTools: boolean;
  /** Estado del botón "Import Excel" tras una carga; null = el texto normal. */
  excelStatus: ExcelStatus | null;

  /** Modal de cierre abierto para ese mes; `busy` mientras se está cerrando. */
  closeDialog: MonthDialog | null;
  confirmClose(withExcel: boolean): void;
  cancelClose(): void;

  /** Diálogo de borrar mes abierto para ese mes; `busy` mientras se está borrando. */
  deleteDialog: MonthDialog | null;
  confirmDelete(): void;
  cancelDelete(): void;

  notices: readonly Notice[];
  dismissNotice(id: number): void;
}

export const FinanzasContext = createContext<Finanzas | null>(null);
export const ShellContext = createContext<Shell | null>(null);

/** Datos y acciones para las pantallas. Solo se puede usar con el estado ya cargado (dentro de las pantallas lo está). */
export function useFinanzas(): Finanzas {
  const value = useContext(FinanzasContext);
  if (!value) throw new Error('useFinanzas() necesita el estado cargado: úsalo dentro de <FinanzasProvider>, en una pantalla.');
  return value;
}

/** Atajo de useFinanzas().actions. */
export function useActions(): Actions {
  return useFinanzas().actions;
}

export function useShell(): Shell {
  const value = useContext(ShellContext);
  if (!value) throw new Error('useShell() necesita <FinanzasProvider>.');
  return value;
}
