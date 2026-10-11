// The app's common strings and the helpers bound to a language. No React: it works the same in a component
// (through useI18n) as in a pure function or a test (createI18n('es')).

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

/** Strings of the shell and those shared by the two screens (en.ts lists the keys). */
export const CORE = defineStrings({ en, es, tr });

export type CoreStrings = typeof en;
/** Key of a common string with no plural: it can be stored in a table and translated as is, t(key). */
export type CoreKey = PlainKey<CoreStrings>;
export type CoreTranslator = Translator<CoreStrings>;

/** Everything that depends on the language, already bound to one. */
export interface I18n {
  lang: Language;
  /** Translator of the common strings: t('add'), t('closeMonth', { month }). */
  t: CoreTranslator;
  /** '2026-10' → 'October 2026' / 'Octubre 2026' / 'Ekim 2026'. */
  label(key: MonthKey): string;
  /** Stored category ('Food') → how it is displayed; a value outside the list comes out as is. */
  catLabel(value: string): string;
  /** Stored method ('Card') → how it is displayed. */
  methodLabel(value: string): string;
  /** Name of the "Fixed expenses" row of "By category". */
  fixedCategory: string;
  /** The twelve months, January to December. */
  monthNames: readonly string[];
  /**
   * Where the `from` → `to` rate returned by shared/calc.ts came from (RateInfo.source), in words: "typed for this
   * month", "from this month's transfers", "crossed through TRY", "from September 2026" or "default value, not set
   * yet". '' if the two currencies are the same. Whoever shows a figure converted with a rate that is not the one typed
   * for that month says so with this, and highlights it when `source` is 'default'.
   */
  rateHint(info: RateInfo, from: Currency, to: Currency): string;
}

// Inside a phrase ("de septiembre 2026") Spanish writes the month in lower case; English and Turkish do not.
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
      // With three currencies, the one acting as the bridge is the one not in the pair.
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

/** The helpers of that language. Always the same object for the same language. */
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
