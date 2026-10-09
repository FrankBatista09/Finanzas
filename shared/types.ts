// Modelo de dominio compartido por el frontend (src/), la API (server/, functions/) y el Excel (shared/excel/).
//
// Modelo de dinero:
//  · Tres monedas. Cada usuario elige su moneda PRINCIPAL (en ella se ven presupuesto, totales y columnas) y una
//    SEGUNDA moneda para las líneas "≈".
//  · Cuentas propias de cada usuario (nombre + moneda). El saldo de una cuenta no se escribe mes a mes: es su
//    saldo inicial más todo lo que la mueve (ingresos, gastos pagados desde ella, envíos que salen o entran).
//  · Tasas escritas a mano por par de monedas, cada una con su fecha: una fila se convierte con la tasa vigente
//    en SU fecha, así que escribir una tasa nueva no cambia lo ya registrado. shared/calc.ts resuelve cualquier
//    conversión.
//  · El presupuesto del mes es la suma de un registro de movimientos con fecha (más los ingresos marcados para
//    sumarle y los envíos marcados para moverlo de una cuenta a otra), no un número que se sobrescribe: así queda la historia de cómo cambió.
//  · Cada fila guarda su monto y moneda originales; lo convertido nunca se persiste.

export type Currency = 'DOP' | 'USD' | 'TRY';

/**
 * Oro, medido en gramos. No es una moneda más: solo puede ser la "moneda" de una cuenta (y de los ingresos que le
 * entran). Por eso tiene su propio tipo: lo que es dinero (presupuesto, gastos, envíos, tasas, metas) sigue
 * tipado con Currency y el compilador no deja que el oro se cuele ahí.
 */
export type Gold = 'XAU';

/** En qué puede estar una cuenta: una moneda o gramos de oro. */
export type AccountCurrency = Currency | Gold;

/** Lo que vale 1 gramo de oro, escrito a mano por el usuario en una moneda normal. */
export interface GoldPrice {
  /** Mayor que 0. */
  amount: number;
  currency: Currency;
}

/** 'YYYY-MM' */
export type MonthKey = string;

/** 'YYYY-MM-DD' */
export type ISODate = string;

export type TxSource = 'web' | 'claude' | 'import';

/** Idioma de la interfaz y del Excel que se descarga. Lo elige cada usuario (shared/i18n.ts). */
export type Language = 'en' | 'es' | 'tr';

/**
 * Una persona con sus finanzas aparte. Los usuarios no se guardan en la base: salen de la variable de
 * entorno USERS (shared/users.ts) y cada fila de la base lleva el id de su dueño.
 */
export interface AppUser {
  /** Identificador estable, en minúsculas ('frank'). Es el user_id de la base y el valor de ?user=. */
  id: string;
  /** Nombre que se muestra en el selector ('Frank'). */
  name: string;
}

/** Los tres colores que cada usuario puede elegir, como '#rrggbb'. El resto de la paleta se deriva (src/theme). */
export interface ThemeColors {
  /** Botones, foco de las celdas, barras y el segmento "Transactions" de la dona. */
  accent: string;
  /** Barra superior y el botón de cerrar mes. */
  header: string;
  /** Fondo de la página. */
  background: string;
}

/** Una cuenta del usuario: banco, billetera, PayPal… Su moneda no cambia una vez que tiene movimientos. */
export interface Account {
  id: string;
  name: string;
  currency: AccountCurrency;
  /**
   * Saldo inicial, en la moneda de la cuenta: lo que tenía antes del primer movimiento registrado.
   * "Corregir el saldo" de una cuenta es ajustar este número (shared/calc.ts openingFor).
   */
  opening: number;
  /**
   * Oculta: no aparece en las listas ni en los selectores y no suma al dinero total. Sus movimientos se
   * conservan y su saldo se sigue calculando, por si se vuelve a mostrar.
   */
  hidden: boolean;
  sort: number;
}

/**
 * Tasa escrita a mano: 1 `from` = `rate` `to`, vigente desde `date` (incluida) hasta la siguiente tasa escrita
 * para ese par, sea de este mes o de uno posterior. Un mes puede tener varias del mismo par: una por fecha.
 */
export interface MonthRate {
  from: Currency;
  to: Currency;
  rate: number;
  /** Desde cuándo vale. Cae dentro del mes que la guarda. */
  date: ISODate;
}

/**
 *  initial   la parte con la que arranca una cuenta en el mes (al crear el mes, o la primera vez que se escribe)
 *  adjust    un cambio posterior, a mano
 *  leftover  lo que sobró del mes anterior, sumado a este (como mucho uno por mes)
 */
export type BudgetEntryKind = 'initial' | 'adjust' | 'leftover';

/** Un movimiento del presupuesto del mes. El presupuesto de una cuenta es la suma de los suyos. */
export interface BudgetEntry {
  id: string;
  /** Cae dentro del mes. */
  date: ISODate;
  accountId: string;
  /** En la moneda de la cuenta. Puede ser negativo (un recorte, o un sobrante negativo). */
  amount: number;
  kind: BudgetEntryKind;
  /** Texto libre; '' si no se escribió. */
  note: string;
}

export interface FixedExpense {
  id: string;
  monthKey: MonthKey;
  name: string;
  /** Día del mes en que se cobra; texto libre, '' si no aplica. */
  day: string;
  amount: number;
  cur: Currency;
  paid: boolean;
  /** Cuenta de la que se paga. Mientras esté marcado como pagado le resta (convertido a la moneda de la cuenta). */
  accountId: string;
  sort: number;
}

export interface Transaction {
  id: string;
  /** Mes (hoja) al que pertenece. Normalmente coincide con el mes de `date`, pero no es obligatorio. */
  monthKey: MonthKey;
  date: ISODate;
  desc: string;
  place: string;
  cat: string;
  method: string;
  amount: number;
  cur: Currency;
  /** Cuenta de la que sale el gasto: le resta el monto, convertido a la moneda de la cuenta con la tasa vigente en `date`. */
  accountId: string;
  notes: string;
  source: TxSource;
  createdAt: string | null;
}

/**
 * Gasto "fuera de presupuesto": le resta a su cuenta como una transacción (misma conversión, con la tasa vigente
 * en `date`), pero no cuenta en lo usado, lo disponible, las categorías ni el conteo del presupuesto del mes.
 */
export interface OutsideExpense {
  id: string;
  monthKey: MonthKey;
  date: ISODate;
  name: string;
  /** Texto libre; '' si no se escribió. */
  desc: string;
  /** Cuenta de dinero de la que sale (nunca de oro). */
  accountId: string;
  amount: number;
  cur: Currency;
}

/** Envío de dinero de una cuenta a otra (p. ej. US account → DR account por Remitly). */
export interface Transfer {
  id: string;
  monthKey: MonthKey;
  date: ISODate;
  /** Texto libre: Remitly, PayPal, Wise, efectivo… */
  via: string;
  fromAccountId: string;
  toAccountId: string;
  /** Lo que sale, en la moneda de la cuenta de origen. */
  amount: number;
  /** 1 moneda de origen = `rate` moneda de destino. Lo que entra es amount × rate. Entre cuentas de la misma moneda, 1. */
  rate: number;
  /**
   * true: además de mover los saldos, MUEVE presupuesto en SU mes (`monthKey`): le resta `amount` a la parte de
   * la cuenta de origen y le suma lo recibido (amount × rate) a la de destino. Como con los ingresos, no genera
   * ningún BudgetEntry: lo hace shared/calc.ts (monthCalc, budgetHistory).
   */
  budget: boolean;
  /**
   * Comisión del envío (>= 0; 0 = sin comisión), en la moneda de la cuenta de ORIGEN: lo que cobra Remitly aparte,
   * directo de esa cuenta. Le resta a su saldo y cuenta como una transacción del mes en la categoría "Other"
   * (shared/calc.ts transferFees); no se guarda como transacción.
   */
  fee: number;
}

/** Dinero que entra a una cuenta (sueldo, pago, regalo…). La suma del mes es el "ingreso del mes". */
export interface Income {
  id: string;
  date: ISODate;
  desc: string;
  accountId: string;
  amount: number;
  /**
   * Moneda en la que se cobró; a la cuenta entra convertido a su moneda con la tasa vigente en `date`.
   * 'XAU' si y solo si la cuenta es de oro: entonces `amount` son gramos y no se convierte.
   */
  cur: AccountCurrency;
  /**
   * true: además de entrar a la cuenta, sube el presupuesto del mes de `date`, en la parte de su cuenta, por su
   * monto convertido a la moneda de la cuenta con la tasa vigente en `date`. No genera ningún BudgetEntry: lo
   * suma shared/calc.ts (monthCalc, budgetHistory). Siempre false en un ingreso a una cuenta de oro.
   */
  budget: boolean;
  /**
   * Tasa propia de este ingreso: cantidad de moneda PRINCIPAL por 1 de `cur` (como MonthRate.rate), para cuando
   * el dinero se cambió a otro precio que el del mes. null = automática (la tasa vigente en `date`). Solo cuenta
   * si `cur` no es la principal (ni XAU) y solo en la conversión a la moneda principal (shared/calc.ts incomeIn).
   * Opcional: ausente = null (lo mismo), para no tocar cada fila que se arma a mano; el servidor siempre la manda.
   */
  rate?: number | null;
  /** true: al crearse un mes nuevo se copia este ingreso a él (server/db.ts recurringIncomeStatement). */
  recurring?: boolean;
}

export interface Month {
  key: MonthKey;
  closed: boolean;
  closedAt: string | null;
  /**
   * Registro del presupuesto del mes, por fecha. Es la fuente de verdad: shared/calc.ts calcula con él (más los
   * ingresos y los envíos con `budget: true`). No son saldos.
   */
  budgetLog: BudgetEntry[];
  /**
   * DERIVADO de `budgetLog` (calc.budgetsFromLog): accountId → suma de sus movimientos, en la moneda de la
   * cuenta; las cuentas que suman 0 no aparecen. No incluye los ingresos que suben el presupuesto ni los envíos que lo mueven. El servidor
   * lo calcula al leer y nunca lo guarda; quien cambie `budgetLog` en memoria debe recalcularlo.
   */
  budgets: Record<string, number>;
  /** Tasas escritas a mano con fecha en este mes, por fecha. Lo que falte lo resuelve shared/calc.ts (rateFor). */
  rates: MonthRate[];
  fixed: FixedExpense[];
  transfers: Transfer[];
  tx: Transaction[];
  /**
   * Gastos fuera de presupuesto del mes. Ausente = ninguno: el servidor solo lo manda en los meses que tienen
   * alguno, y así no cambia la forma de un mes que no los usa. Léase con `outsideOf` (shared/calc.ts).
   */
  outside?: OutsideExpense[];
}

export interface Goal {
  id: string;
  name: string;
  /** Moneda de la meta: en ella van el ahorro mensual, el objetivo y lo ahorrado. */
  cur: Currency;
  /**
   * Ahorro mensual planeado, en `cur`. null = aportes variables (sin plan).
   * Con plan van los tres juntos (monthly > 0, start <= end) y el monto objetivo no se guarda:
   * es monthly × meses entre start y end, ambos incluidos. En el formulario se escribe el objetivo o el mensual.
   */
  monthly: number | null;
  start: MonthKey | null;
  end: MonthKey | null;
  /**
   * Moneda en la que también se muestra lo ahorrado (la línea "≈" de la meta). null = la moneda principal del
   * usuario. Puede ser cualquiera, también la de la propia meta (la interfaz entonces no muestra la línea).
   */
  approxCur: Currency | null;
  sort: number;
}

/** Aporte a una meta. Es un apartado, no un movimiento: no cambia el saldo de ninguna cuenta. */
export interface Contribution {
  id: string;
  goalId: string;
  date: ISODate;
  amount: number;
  /** Moneda del aporte; se convierte a la de la meta con la tasa vigente en su fecha. */
  cur: Currency;
  /** Como Income.rate: moneda principal por 1 de `cur`; null = automática. Ver shared/calc.ts contribIn. */
  rate?: number | null;
  /**
   * Cuenta de dinero de la que sale el aporte: le resta a su saldo el monto en la moneda de la cuenta (shared/calc.ts
   * balances). null/ausente = ninguna, el aporte no mueve saldos. No cambia presupuestos ni el mes.
   */
  accountId?: string | null;
}

/**
 * Todo el histórico de UN usuario. Es lo que devuelve GET /api/state y sobre lo que operan los cálculos
 * de shared/calc.ts.
 */
export interface AppState {
  months: Record<MonthKey, Month>;
  accounts: Account[];
  incomes: Income[];
  goals: Goal[];
  contribs: Contribution[];

  /** Moneda en la que se ven el presupuesto, los totales y las columnas de las tablas. */
  mainCurrency: Currency;
  /** Moneda de las líneas "≈". Distinta de la principal. */
  secondCurrency: Currency;
  /** Cuenta de la que sale un gasto cuando no se indica otra (también los que registra Claude). null = ver defaultAccount(). */
  defaultAccountId: string | null;
  /** Tasa USD→DOP de respaldo cuando ningún mes la tiene (settings.default_rate). */
  defaultRate: number;
  /**
   * Precio del oro: lo que vale 1 gramo. null = sin precio: las cuentas de oro se ven solo en gramos y no suman
   * al dinero total (shared/calc.ts balances).
   */
  goldPrice: GoldPrice | null;

  /** Colores elegidos por el usuario; null = la paleta original (shared/theme.ts DEFAULT_THEME). */
  theme: ThemeColors | null;
  /** Idioma elegido por el usuario (settings.language); 'en' si nunca eligió. */
  language: Language;
}
