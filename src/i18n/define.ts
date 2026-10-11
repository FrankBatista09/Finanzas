// Translation mechanism, with no library: one dictionary per language with the same keys, interpolation
// of {parameters} and singular/plural. It knows nothing about React (the hook is in useI18n.ts) or which strings exist.
//
// The English dictionary defines the keys. The others are typed with the same shape, so a key that is missing
// (or extra) in Spanish or Turkish does not compile.

import type { Language } from '../../shared/types';

/** String with singular and plural. It is chosen with the `count` parameter: `one` if it is 1, `other` otherwise. */
export interface Plural {
  one: string;
  other: string;
}

export type Entry = string | Plural;
export type Dict = Readonly<Record<string, Entry>>;

/** The shape of a dictionary: the same keys, and plural wherever the English one is. */
export type Shape<D extends Dict> = { readonly [K in keyof D]: D[K] extends string ? string : Plural };

/** The strings of one part of the app in every language. Created with defineStrings(). */
export type Strings<D extends Dict> = Readonly<Record<Language, Shape<D>>>;

/** Values inserted into the string: "Close {month}" + { month: 'October 2026' }. Numbers come already formatted. */
export type Params = Readonly<Record<string, string | number>>;

/** The keys with singular and plural: translating them requires passing `count`. */
export type PluralKey<D extends Dict> = { [K in keyof D]: D[K] extends string ? never : K }[keyof D];
/** The keys of a string with no plural: they can be translated without parameters. */
export type PlainKey<D extends Dict> = Exclude<keyof D, PluralKey<D>>;

/** Translation function of a dictionary in one language. Keys with a plural require `count`. */
export interface Translator<D extends Dict> {
  (key: PlainKey<D>, params?: Params): string;
  (key: PluralKey<D>, params: Params & { count: number }): string;
}

/**
 * Declares the strings of one part of the app. Each screen has its own in its folder:
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

/** Replaces each {name} with its value. A parameter that is not provided is left as is, so that it stands out. */
export function interpolate(text: string, params: Params): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

const cache = new WeakMap<object, Map<Language, unknown>>();

/**
 * The translator of those strings in that language. For the same arguments it always returns the same function,
 * so it can be used as an effect dependency or passed to a memoized component.
 */
export function translator<D extends Dict>(strings: Strings<D>, lang: Language): Translator<D> {
  let byLang = cache.get(strings);
  if (!byLang) cache.set(strings, (byLang = new Map()));
  const cached = byLang.get(lang);
  if (cached) return cached as Translator<D>;

  const dict: Readonly<Record<string, Entry>> = strings[lang];
  const fallback: Readonly<Record<string, Entry>> = strings.en;
  const t = (key: string, params?: Params): string => {
    // The types already rule out a nonexistent key; the fallback is for a language that arrives without its dictionary.
    const entry = dict?.[key] ?? fallback[key];
    if (entry === undefined) return key;
    const text = typeof entry === 'string' ? entry : params?.count === 1 ? entry.one : entry.other;
    return params ? interpolate(text, params) : text;
  };
  byLang.set(lang, t);
  return t as Translator<D>;
}
