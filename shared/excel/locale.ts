// Idiomas del libro de Excel. Todo texto que termina dentro del .xlsx y depende del idioma sale de un
// ExcelLocale: etiquetas, nombres de hojas, de tablas y de columnas, meses, valores Sí/No y los trozos de
// texto de las fórmulas. El generador (export.ts) no lleva textos propios: la estructura del libro, sus
// estilos y sus fórmulas son los mismos en los tres idiomas.
//
// EXCEL_ES son, tal cual, los textos del exportador original del diseño: con él la salida sigue siendo
// idéntica byte a byte a la del script de referencia (export.test.ts). Cambiar un texto ahí rompe esa prueba.

import type { Language } from '../types';
import { EXCEL_EN } from './locale-en';
import { EXCEL_ES } from './locale-es';
import { EXCEL_TR } from './locale-tr';

/**
 * Texto de una fórmula con una expresión en medio: [antes, después]. Con dos expresiones son tres trozos, y
 * así. El orden de las expresiones es fijo; un trozo vacío no se escribe.
 * Español: ['Faltan ', ' aportes · ', ' USD por mes para llegar'] → "Faltan "&$R$6&" aportes · "&…
 */
export type Phrase1 = readonly [before: string, after: string];
export type Phrase2 = readonly [before: string, between: string, after: string];
export type Phrase3 = readonly [before: string, first: string, second: string, after: string];

export interface ExcelLocale {
  /** Idioma al que se traducen las categorías y los métodos guardados (shared/i18n.ts). */
  readonly lang: Language;
  /**
   * Nombres de los meses. Dan nombre a las hojas de mes ("Octubre 2026"), a la columna Mes de los aportes y
   * a las listas CHOOSE de las fórmulas; INDIRECT localiza cada hoja por ese nombre.
   */
  readonly months: readonly string[];
  /** Listas de la hoja Config (desplegables del historial), en el orden de CATS y METHODS. */
  readonly cats: readonly string[];
  readonly methods: readonly string[];
  /** Valores de la columna "Pagado". Van en una lista "a,b" y dentro de fórmulas: sin comas. */
  readonly yes: string;
  readonly no: string;
  /** Texto de la banda oscura de las hojas de mes y de ahorros. */
  readonly brand: string;
  /** Título de la columna oculta de cálculos. */
  readonly calc: string;
  /** La hoja de ajustes se llama "Config" en todos los idiomas (CONFIG_SHEET en export.ts). */
  readonly sheets: { readonly savings: string };
  /**
   * Nombres de tabla: solo letras ASCII, dígitos y guion bajo (Excel no admite espacios ni signos, y así
   * tampoco dependen de cómo trate cada programa las letras turcas). Los de las tablas del mes son prefijos:
   * el generador les añade "_AAAA_MM".
   */
  readonly tables: {
    readonly fixed: string;
    readonly transfers: string;
    readonly tx: string;
    readonly contribs: string;
  };
  /**
   * Encabezados de las tablas. Son también los nombres de columna de las referencias estructuradas
   * (Aportes[Meta]), así que no pueden llevar corchetes, '#' ni comillas simples.
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
  /** Hoja de un mes. */
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
    /** [porcentaje usado del presupuesto] */
    readonly pctUsed: Phrase1;
    /** Centro de la dona, sobre el monto usado. */
    readonly used: string;
    /** Centro de la dona, bajo el monto usado: [presupuesto]. */
    readonly ofBudget: Phrase1;
    readonly fixedTitle: string;
    /** [pagados] [gastos] [total en DOP] */
    readonly fixedMeta: Phrase3;
    readonly byCategory: string;
    /** Primera fila de "Por categoría". */
    readonly fixedCategory: string;
    readonly transfersTitle: string;
    /** [tasa promedio] */
    readonly average: Phrase1;
    readonly txTitle: string;
    /** [número de transacciones] [total en DOP] */
    readonly txMeta: Phrase2;
  };
  /** Dibujo de la dona: idioma de sus textos (atributo lang) y nombres del gráfico, sus cajas de texto y su serie. */
  readonly drawing: {
    readonly lang: string;
    readonly frame: string;
    readonly center: string;
    readonly series: string;
  };
  /** Hoja de ahorros. */
  readonly savings: {
    readonly currentMonth: string;
    readonly totalMoney: string;
    readonly budget: string;
    readonly used: string;
    readonly available: string;
    readonly rate: string;
    /** Subtítulo de una meta sin plan. */
    readonly variable: string;
    /** [número de aportes] */
    readonly contribCount: Phrase1;
    /** [aporte mensual] */
    readonly perMonth: Phrase1;
    /** [aportes que faltan] [USD por mes] */
    readonly remaining: Phrase2;
    /** [porcentaje] [monto objetivo] */
    readonly pctOfTarget: Phrase2;
    /** [mes] [año] */
    readonly target: Phrase2;
    /**
     * Función de Excel que se aplica al nombre del mes dentro de esa frase: en español los meses van en
     * minúscula ("Meta: octubre 2027"); en inglés y en turco, con mayúscula inicial.
     */
    readonly monthCase: 'LOWER' | 'PROPER';
    /** Etiquetas de los tres datos editables de una meta con plan (celdas estrechas: textos cortos). */
    readonly monthly: string;
    readonly start: string;
    readonly end: string;
    readonly incomeTitle: string;
    /** Encabezados de "Ingresos por mes", columnas B a G. */
    readonly incomeCols: readonly [string, string, string, string, string, string];
    readonly contribsTitle: string;
    /** [total en USD] */
    readonly total: Phrase1;
  };
  /** Hoja Config. */
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

/** Textos del libro para el idioma del usuario; inglés si el idioma no se reconoce. */
export function excelLocale(lang: Language): ExcelLocale {
  return EXCEL_LOCALES[lang] ?? EXCEL_EN;
}
