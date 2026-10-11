// Languages of the Excel workbook. Every text that ends up inside the .xlsx and depends on the language comes
// from an ExcelLocale: labels, names of sheets, tables and columns, months, Yes/No values and the pieces of
// text of the formulas. The generator (export.ts) carries no texts of its own: the workbook's structure, its
// styles and its formulas are the same in the three languages.
//
// EXCEL_ES holds, unchanged, the texts of the design's original exporter: with it the output is still
// byte-for-byte identical to the reference script's (export.test.ts). Changing a text there breaks that test.

import type { Language } from '../types';
import { EXCEL_EN } from './locale-en';
import { EXCEL_ES } from './locale-es';
import { EXCEL_TR } from './locale-tr';

/**
 * Text of a formula with an expression in the middle: [before, after]. With two expressions it is three pieces,
 * and so on. The order of the expressions is fixed; an empty piece is not written.
 * Spanish: ['Faltan ', ' aportes · ', ' USD por mes para llegar'] → "Faltan "&$R$6&" aportes · "&…
 */
export type Phrase1 = readonly [before: string, after: string];
export type Phrase2 = readonly [before: string, between: string, after: string];
export type Phrase3 = readonly [before: string, first: string, second: string, after: string];

export interface ExcelLocale {
  /** Language the stored categories and methods are translated into (shared/i18n.ts). */
  readonly lang: Language;
  /**
   * Month names. They name the month sheets ("October 2026"), the Month column of the contributions and
   * the CHOOSE lists of the formulas; INDIRECT locates each sheet by that name.
   */
  readonly months: readonly string[];
  /**
   * Lists of the Config sheet (the history's dropdowns): the ten categories and the three methods of the
   * original design, not today's lists (CATS, METHODS). The rows do carry any of today's values, translated.
   */
  readonly cats: readonly string[];
  readonly methods: readonly string[];
  /** Values of the "Paid" column. They go in an "a,b" list and inside formulas: no commas. */
  readonly yes: string;
  readonly no: string;
  /** Text of the dark band of the month and savings sheets. */
  readonly brand: string;
  /** Title of the hidden calculations column. */
  readonly calc: string;
  /** The settings sheet is called "Config" in every language (CONFIG_SHEET in export.ts). */
  readonly sheets: { readonly savings: string };
  /**
   * Table names: only ASCII letters, digits and underscores (Excel does not allow spaces or symbols, and this
   * way they do not depend on how each program handles Turkish letters either). The month tables' names are
   * prefixes: the generator appends "_YYYY_MM" to them.
   */
  readonly tables: {
    readonly fixed: string;
    readonly transfers: string;
    readonly tx: string;
    readonly contribs: string;
  };
  /**
   * Table headers. They are also the column names of the structured references
   * (Contributions[Goal]), so they cannot contain brackets, '#' or single quotes.
   */
  readonly cols: {
    readonly paid: string;
    readonly item: string;
    readonly day: string;
    readonly amount: string;
    readonly currency: string;
    readonly date: string;
    readonly via: string;
    readonly rate: string;
    readonly description: string;
    readonly place: string;
    readonly category: string;
    readonly method: string;
    readonly notes: string;
    readonly month: string;
    readonly goal: string;
  };
  /** A month's sheet. */
  readonly month: {
    readonly rate: string;
    readonly hint: string;
    readonly totalMoney: string;
    readonly usAccount: string;
    readonly drAccount: string;
    readonly income: string;
    readonly incomeMinusUsed: string;
    readonly budgetUsed: string;
    readonly fixedPaid: string;
    readonly transactions: string;
    readonly fixedPending: string;
    readonly free: string;
    readonly planned: string;
    readonly usedSoFar: string;
    readonly available: string;
    readonly availableAfter: string;
    readonly usedUSD: string;
    /** [percentage of the budget used] */
    readonly pctUsed: Phrase1;
    /** Center of the donut, above the used amount. */
    readonly used: string;
    /** Center of the donut, below the used amount: [budget]. */
    readonly ofBudget: Phrase1;
    readonly fixedTitle: string;
    /** [paid] [expenses] [total in DOP] */
    readonly fixedMeta: Phrase3;
    readonly byCategory: string;
    /** First row of "By category". */
    readonly fixedCategory: string;
    readonly transfersTitle: string;
    /** [average rate] */
    readonly average: Phrase1;
    readonly txTitle: string;
    /** [number of transactions] [total in DOP] */
    readonly txMeta: Phrase2;
  };
  /** Donut drawing: language of its texts (lang attribute) and names of the chart, its text boxes and its series. */
  readonly drawing: {
    readonly lang: string;
    readonly frame: string;
    readonly center: string;
    readonly series: string;
  };
  /** Savings sheet. */
  readonly savings: {
    readonly currentMonth: string;
    readonly totalMoney: string;
    readonly budget: string;
    readonly used: string;
    readonly available: string;
    readonly rate: string;
    /** Subtitle of a goal with no plan. */
    readonly variable: string;
    /** [number of contributions] */
    readonly contribCount: Phrase1;
    /** [monthly contribution] */
    readonly perMonth: Phrase1;
    /** [contributions left] [USD per month] */
    readonly remaining: Phrase2;
    /** [percentage] [target amount] */
    readonly pctOfTarget: Phrase2;
    /** [month] [year] */
    readonly target: Phrase2;
    /**
     * Excel function applied to the month name inside that phrase: in Spanish the months go in
     * lower case ("Meta: octubre 2027"); in English and in Turkish, with an initial capital.
     */
    readonly monthCase: 'LOWER' | 'PROPER';
    /** Labels of the three editable values of a goal with a plan (narrow cells: short texts). */
    readonly monthly: string;
    readonly start: string;
    readonly end: string;
    readonly incomeTitle: string;
    /** Headers of "Income by month", columns B to G. */
    readonly incomeCols: readonly [string, string, string, string, string, string];
    readonly contribsTitle: string;
    /** [total in USD] */
    readonly total: Phrase1;
  };
  /** Config sheet. */
  readonly config: {
    readonly title: string;
    readonly settings: string;
    readonly defaultRate: string;
    readonly currentMonth: string;
    readonly cats: string;
    readonly methods: string;
    readonly goals: string;
  };
}

export { EXCEL_EN, EXCEL_ES, EXCEL_TR };

export const EXCEL_LOCALES: Readonly<Record<Language, ExcelLocale>> = { en: EXCEL_EN, es: EXCEL_ES, tr: EXCEL_TR };

/** Workbook texts for the user's language; English if the language is not recognized. */
export function excelLocale(lang: Language): ExcelLocale {
  return EXCEL_LOCALES[lang] ?? EXCEL_EN;
}
