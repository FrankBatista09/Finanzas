// Los textos comunes de la app y los ayudantes atados a un idioma. Sin React: sirve igual en un componente
// (a través de useI18n) que en una función pura o en una prueba (createI18n('es')).

import type { RateInfo } from '../../shared/calc';
import { CURRENCIES } from '../../shared/constants';
import { catLabel, FIXED_CATEGORY_NAMES, methodLabel, MONTH_NAMES } from '../../shared/i18n';
import { label } from '../../shared/month';
import type { Currency, Language, MonthKey } from '../../shared/types';
import { defineStrings, translator } from './define';
import type { PlainKey, Translator } from './define';
import { en } from './en';
import { es } from './es';
import { tr } from './tr';

/** Textos de la carcasa y los que comparten las dos pantallas (en.ts lista las claves). */
export const CORE = defineStrings({ en, es, tr });

export type CoreStrings = typeof en;
/** Clave de un texto común sin plural: se puede guardar en una tabla y traducir tal cual, t(key). */
export type CoreKey = PlainKey<CoreStrings>;
export type CoreTranslator = Translator<CoreStrings>;

/** Todo lo que depende del idioma, ya atado a uno. */
export interface I18n {
  lang: Language;
  /** Traductor de los textos comunes: t('add'), t('closeMonth', { month }). */
  t: CoreTranslator;
  /** '2026-10' → 'October 2026' / 'Octubre 2026' / 'Ekim 2026'. */
  label(key: MonthKey): string;
  /** Categoría guardada ('Food') → cómo se muestra; un valor fuera de la lista sale tal cual. */
  catLabel(value: string): string;
  /** Método guardado ('Card') → cómo se muestra. */
  methodLabel(value: string): string;
  /** Nombre de la fila "Fixed expenses" de "By category". */
  fixedCategory: string;
  /** Los doce meses, de enero a diciembre. */
  monthNames: readonly string[];
  /**
   * De dónde salió la tasa `from` → `to` que devolvió shared/calc.ts (RateInfo.source), en palabras: "typed for this
   * month", "from this month's transfers", "crossed through TRY", "from September 2026" o "default value, not set
   * yet". '' si las dos monedas son la misma. Quien enseñe una cifra convertida con una tasa que no es la escrita
   * para ese mes lo dice con esto, y lo destaca cuando `source` es 'default'.
   */
  rateHint(info: RateInfo, from: Currency, to: Currency): string;
}

// Dentro de una frase ("de septiembre 2026") el español escribe el mes en minúscula; el inglés y el turco, no.
const LOWERCASE_MONTH: Record<Language, boolean> = { en: false, es: true, tr: false };

function rateHint(t: CoreTranslator, lang: Language, info: RateInfo, from: Currency, to: Currency): string {
  switch (info.source) {
    case 'same':
      return '';
    case 'month':
      return t('rateTyped');
    case 'transfers':
      return t('rateFromTransfers');
    case 'cross':
      // Con tres monedas, la que hace de puente es la que no está en el par.
      return t('rateCrossed', { currency: CURRENCIES.find((c) => c !== from && c !== to) ?? '' });
    case 'previous': {
      if (!info.monthKey) return t('rateDefault');
      const month = label(info.monthKey, lang);
      return t('rateFromMonth', { month: LOWERCASE_MONTH[lang] ? month.toLowerCase() : month });
    }
    case 'default':
      return t('rateDefault');
  }
}

const cache = new Map<Language, I18n>();

/** Los ayudantes de ese idioma. Siempre el mismo objeto para el mismo idioma. */
export function createI18n(lang: Language): I18n {
  let i18n = cache.get(lang);
  if (!i18n) {
    const t = translator(CORE, lang);
    i18n = {
      lang,
      t,
      label: (key) => label(key, lang),
      catLabel: (value) => catLabel(value, lang),
      methodLabel: (value) => methodLabel(value, lang),
      fixedCategory: FIXED_CATEGORY_NAMES[lang],
      monthNames: MONTH_NAMES[lang],
      rateHint: (info, from, to) => rateHint(t, lang, info, from, to),
    };
    cache.set(lang, i18n);
  }
  return i18n;
}
