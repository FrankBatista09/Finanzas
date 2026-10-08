// Mecanismo de traducción, sin librería: un diccionario por idioma con las mismas claves, interpolación
// de {parámetros} y singular/plural. No sabe nada de React (el hook está en useI18n.ts) ni de qué textos hay.
//
// El diccionario inglés define las claves. Los demás se tipan con su misma forma, así que una clave que falte
// (o sobre) en español o en turco no compila.

import type { Language } from '../../shared/types';

/** Texto con singular y plural. Se elige con el parámetro `count`: `one` si es 1, `other` en el resto. */
export interface Plural {
  one: string;
  other: string;
}

export type Entry = string | Plural;
export type Dict = Readonly<Record<string, Entry>>;

/** La forma de un diccionario: las mismas claves, y plural donde el inglés lo sea. */
export type Shape<D extends Dict> = { readonly [K in keyof D]: D[K] extends string ? string : Plural };

/** Los textos de una parte de la app en todos los idiomas. Se crea con defineStrings(). */
export type Strings<D extends Dict> = Readonly<Record<Language, Shape<D>>>;

/** Valores que se meten en el texto: "Close {month}" + { month: 'October 2026' }. Los números van ya formateados. */
export type Params = Readonly<Record<string, string | number>>;

/** Las claves con singular y plural: al traducirlas hay que pasar `count`. */
export type PluralKey<D extends Dict> = { [K in keyof D]: D[K] extends string ? never : K }[keyof D];
/** Las claves de un texto sin plural: se pueden traducir sin parámetros. */
export type PlainKey<D extends Dict> = Exclude<keyof D, PluralKey<D>>;

/** Función de traducción de un diccionario en un idioma. Las claves con plural exigen `count`. */
export interface Translator<D extends Dict> {
  (key: PlainKey<D>, params?: Params): string;
  (key: PluralKey<D>, params: Params & { count: number }): string;
}

/**
 * Declara los textos de una parte de la app. Cada pantalla tiene los suyos en su carpeta:
 *
 *   export const MES = defineStrings({
 *     en: { paidOf: '{paid} of {total} paid', txCount: { one: '{count} transaction', other: '{count} transactions' } },
 *     es: { paidOf: '{paid} de {total} pagados', txCount: { one: '{count} transacción', other: '{count} transacciones' } },
 *     tr: { paidOf: '{total} giderin {paid} tanesi ödendi', txCount: { one: '{count} işlem', other: '{count} işlem' } },
 *   });
 */
export function defineStrings<D extends Dict>(
  dicts: { en: D } & { [L in Exclude<Language, 'en'>]: NoInfer<Shape<D>> },
): Strings<D> {
  return dicts as unknown as Strings<D>;
}

/** Sustituye cada {nombre} por su valor. Un parámetro que no venga se deja tal cual, para que se note. */
export function interpolate(text: string, params: Params): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

const cache = new WeakMap<object, Map<Language, unknown>>();

/**
 * El traductor de esos textos en ese idioma. Para los mismos argumentos devuelve siempre la misma función,
 * así que se puede usar como dependencia de un efecto o pasar a un componente memorizado.
 */
export function translator<D extends Dict>(strings: Strings<D>, lang: Language): Translator<D> {
  let byLang = cache.get(strings);
  if (!byLang) cache.set(strings, (byLang = new Map()));
  const cached = byLang.get(lang);
  if (cached) return cached as Translator<D>;

  const dict: Readonly<Record<string, Entry>> = strings[lang];
  const fallback: Readonly<Record<string, Entry>> = strings.en;
  const t = (key: string, params?: Params): string => {
    // Los tipos ya impiden una clave inexistente; el respaldo es para un idioma que llegara sin su diccionario.
    const entry = dict?.[key] ?? fallback[key];
    if (entry === undefined) return key;
    const text = typeof entry === 'string' ? entry : params?.count === 1 ? entry.one : entry.other;
    return params ? interpolate(text, params) : text;
  };
  byLang.set(lang, t);
  return t as Translator<D>;
}
