// Languages of the app. Only what the web, the Excel and the server share goes here: the list of languages, the
// month names and the translation of the values with a fixed list (categories and methods).
// The interface texts live in src/i18n; those of the Excel workbook, in shared/excel/locale-*.ts.
//
// Data rule: what is stored does not depend on the language. Categories and methods are stored under their
// canonical English name (shared/constants.ts) and translated only when shown; a value outside the list
// (free text or imported data) is shown as is. The texts the user types (descriptions,
// places, notes, names of expenses and of goals) are never translated.

import { CATS, METHODS } from './constants';
import type { Language } from './types';

export const DEFAULT_LANGUAGE: Language = 'en';

/** In the order of the select. `name` is the language's name in that same language. */
export const LANGUAGES: readonly { id: Language; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'es', name: 'Español' },
  { id: 'tr', name: 'Türkçe' },
];

export function isLanguage(v: unknown): v is Language {
  return v === 'en' || v === 'es' || v === 'tr';
}

export const MONTH_NAMES: Record<Language, readonly string[]> = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  es: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'],
  tr: ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'],
};

/** Category names in each language, in the same order as CATS. */
export const CAT_NAMES: Record<Language, readonly string[]> = {
  en: CATS,
  es: ['Comida', 'Supermercado', 'Transporte', 'Entretenimiento', 'Salud', 'Ropa', 'Hogar', 'Suscripciones', 'Educación', 'Viajes', 'Otros'],
  tr: ['Yemek', 'Market', 'Ulaşım', 'Eğlence', 'Sağlık', 'Giyim', 'Ev', 'Abonelikler', 'Eğitim', 'Seyahat', 'Diğer'],
};

/** Payment method names in each language, in the same order as METHODS. */
export const METHOD_NAMES: Record<Language, readonly string[]> = {
  en: METHODS,
  es: ['Tarjeta de débito', 'Tarjeta de crédito', 'Transferencia', 'App del banco', 'Efectivo'],
  tr: ['Banka kartı', 'Kredi kartı', 'Havale', 'Banka uygulaması', 'Nakit'],
};

// There used to be a single card ('Card' / 'Tarjeta' / 'Kart'). Those words keep coming in: people dictate them to Claude
// and they are in the Excel workbooks already exported (and in the list of their Config sheet). They mean the debit card.
const LEGACY_METHODS: Readonly<Record<string, (typeof METHODS)[number]>> = { card: 'Debit card', tarjeta: 'Debit card', kart: 'Debit card' };

/** The "Fixed expenses" row of "By category" (it is not a stored category: CategorySum.fixed identifies it). */
export const FIXED_CATEGORY_NAMES: Record<Language, string> = {
  en: 'Fixed expenses',
  es: 'Gastos fijos',
  tr: 'Sabit giderler',
};

const fold = (s: string) => s.trim().toLocaleLowerCase('en-US');

function translate(value: string, canonical: readonly string[], names: Record<Language, readonly string[]>, lang: Language): string {
  const i = canonical.indexOf(value);
  return i < 0 ? value : (names[lang][i] ?? value);
}

/** Text in any of the languages → canonical value; what is not recognized comes back as is (without extra spaces). */
function canonical(text: string, list: readonly string[], names: Record<Language, readonly string[]>): string {
  const t = fold(text);
  for (const lang of Object.keys(names) as Language[]) {
    const i = names[lang].findIndex((n) => fold(n) === t);
    if (i >= 0) return list[i]!;
  }
  return text.trim();
}

/** Stored category → how it is shown in `lang`. */
export function catLabel(value: string, lang: Language): string {
  return translate(value, CATS, CAT_NAMES, lang);
}

/** Stored method → how it is shown in `lang`. */
export function methodLabel(value: string, lang: Language): string {
  return translate(value, METHODS, METHOD_NAMES, lang);
}

/** 'Comida', 'Yemek' or 'food' → 'Food'. For reading Excel workbooks in another language and what the user dictates to Claude. */
export function canonicalCat(text: string): string {
  return canonical(text, CATS, CAT_NAMES);
}

// No accents and the Turkish ı as i: that way 'tarjeta de credito' and 'KREDİ KARTI' are recognized like the exact name.
const foldLoose = (s: string) => fold(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replaceAll('ı', 'i');

/**
 * 'Tarjeta de crédito', 'kredi kartı' or 'credit card' → 'Credit card'; 'Efectivo' or 'Nakit' → 'Cash'.
 * The old words ('Card', 'Tarjeta', 'Kart') → 'Debit card'. What is not recognized comes back as is.
 */
export function canonicalMethod(text: string): string {
  const t = foldLoose(text);
  const legacy = Object.hasOwn(LEGACY_METHODS, t) ? LEGACY_METHODS[t] : undefined;
  if (legacy) return legacy;
  for (const lang of Object.keys(METHOD_NAMES) as Language[]) {
    const i = METHOD_NAMES[lang].findIndex((n) => foldLoose(n) === t);
    if (i >= 0) return METHODS[i]!;
  }
  return text.trim();
}
