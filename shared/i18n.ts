// Idiomas de la app. Aquí va solo lo que comparten la web, el Excel y el servidor: la lista de idiomas, los
// nombres de los meses y la traducción de los valores con lista fija (categorías y métodos).
// Los textos de la interfaz viven en src/i18n; los del libro de Excel, en shared/excel/locale-*.ts.
//
// Regla de datos: lo que se guarda no depende del idioma. Categorías y métodos se guardan con su nombre
// canónico en inglés (shared/constants.ts) y se traducen solo al mostrarlos; un valor fuera de la lista
// (texto libre o datos importados) se muestra tal cual. Los textos que escribe el usuario (descripciones,
// lugares, notas, nombres de gastos y de metas) nunca se traducen.

import { CATS, METHODS } from './constants';
import type { Language } from './types';

export const DEFAULT_LANGUAGE: Language = 'en';

/** En el orden del selector. `name` es el nombre del idioma en ese mismo idioma. */
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

/** Nombres de las categorías en cada idioma, en el mismo orden que CATS. */
export const CAT_NAMES: Record<Language, readonly string[]> = {
  en: CATS,
  es: ['Comida', 'Supermercado', 'Transporte', 'Entretenimiento', 'Salud', 'Ropa', 'Hogar', 'Suscripciones', 'Educación', 'Viajes'],
  tr: ['Yemek', 'Market', 'Ulaşım', 'Eğlence', 'Sağlık', 'Giyim', 'Ev', 'Abonelikler', 'Eğitim', 'Seyahat'],
};

/** Nombres de los métodos de pago en cada idioma, en el mismo orden que METHODS. */
export const METHOD_NAMES: Record<Language, readonly string[]> = {
  en: METHODS,
  es: ['Tarjeta', 'Transferencia', 'App del banco'],
  tr: ['Kart', 'Havale', 'Banka uygulaması'],
};

/** La fila "Fixed expenses" de "By category" (no es una categoría guardada: la identifica CategorySum.fixed). */
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

/** Texto en cualquiera de los idiomas → valor canónico; lo que no se reconoce vuelve tal cual (sin espacios sobrantes). */
function canonical(text: string, list: readonly string[], names: Record<Language, readonly string[]>): string {
  const t = fold(text);
  for (const lang of Object.keys(names) as Language[]) {
    const i = names[lang].findIndex((n) => fold(n) === t);
    if (i >= 0) return list[i]!;
  }
  return text.trim();
}

/** Categoría guardada → cómo se muestra en `lang`. */
export function catLabel(value: string, lang: Language): string {
  return translate(value, CATS, CAT_NAMES, lang);
}

/** Método guardado → cómo se muestra en `lang`. */
export function methodLabel(value: string, lang: Language): string {
  return translate(value, METHODS, METHOD_NAMES, lang);
}

/** 'Comida', 'Yemek' o 'food' → 'Food'. Para leer libros de Excel en otro idioma y lo que dicta el usuario a Claude. */
export function canonicalCat(text: string): string {
  return canonical(text, CATS, CAT_NAMES);
}

/** 'Tarjeta', 'Kart' o 'card' → 'Card'. */
export function canonicalMethod(text: string): string {
  return canonical(text, METHODS, METHOD_NAMES);
}
