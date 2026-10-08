// Modelo de dominio compartido por el frontend (src/), la API (server/, functions/) y el Excel (shared/excel/).
//
// Modelo de dinero:
//  · Tres monedas. Cada usuario elige su moneda PRINCIPAL (en ella se ven presupuesto, totales y columnas) y una
//    SEGUNDA moneda para las líneas "≈".
//  · Cuentas propias de cada usuario (nombre + moneda). El saldo de una cuenta no se escribe mes a mes: es su
//    saldo inicial más todo lo que la mueve (ingresos, gastos pagados desde ella, envíos que salen o entran).
//  · Tasas del mes escritas a mano por par de monedas; shared/calc.ts resuelve cualquier conversión.
//  · Cada fila guarda su monto y moneda originales; lo convertido nunca se persiste.

export type Currency = 'DOP' | 'USD' | 'TRY';

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
  currency: Currency;
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

/** Tasa del mes escrita a mano: 1 `from` = `rate` `to`. */
export interface MonthRate {
  from: Currency;
  to: Currency;
  rate: number;
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
  /** Cuenta de la que sale el gasto: le resta el monto, convertido a la moneda de la cuenta con la tasa del mes. */
  accountId: string;
  notes: string;
  source: TxSource;
  createdAt: string | null;
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
}

/** Dinero que entra a una cuenta (sueldo, pago, regalo…). La suma del mes es el "ingreso del mes". */
export interface Income {
  id: string;
  date: ISODate;
  desc: string;
  accountId: string;
  amount: number;
  /** Moneda en la que se cobró; a la cuenta entra convertido a su moneda con la tasa del mes de `date`. */
  cur: Currency;
}

export interface Month {
  key: MonthKey;
  closed: boolean;
  closedAt: string | null;
  /**
   * Presupuesto del mes, repartido por la cuenta de la que sale: accountId → monto en la moneda de esa cuenta.
   * No son saldos. El total es la suma convertida a la moneda principal (monthCalc().budget).
   */
  budgets: Record<string, number>;
  /** Tasas escritas a mano para este mes. Los pares que falten los resuelve shared/calc.ts (rateFor). */
  rates: MonthRate[];
  fixed: FixedExpense[];
  transfers: Transfer[];
  tx: Transaction[];
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
  sort: number;
}

/** Aporte a una meta. Es un apartado, no un movimiento: no cambia el saldo de ninguna cuenta. */
export interface Contribution {
  id: string;
  goalId: string;
  date: ISODate;
  amount: number;
  /** Moneda del aporte; se convierte a la de la meta con la tasa del mes de su fecha. */
  cur: Currency;
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

  /** Colores elegidos por el usuario; null = la paleta original (shared/theme.ts DEFAULT_THEME). */
  theme: ThemeColors | null;
  /** Idioma elegido por el usuario (settings.language); 'en' si nunca eligió. */
  language: Language;
}
