// Entry point of the translations for components and screens.
//
//   const { t, lang, label, catLabel, methodLabel, rateHint } = useI18n();   // common strings and current-language helpers
//   const s = useStrings(MES);                                      // the screen's own strings, declared with defineStrings
//
// Outside React (pure functions, tests): createI18n(lang) and translator(MES, lang); a user's language
// is state.language. The common keys are in en.ts; each screen declares its own in its folder.

export { CORE, createI18n } from './core';
export type { CoreKey, CoreStrings, CoreTranslator, I18n } from './core';
export { defineStrings, interpolate, translator } from './define';
export type { Dict, Entry, Params, PlainKey, Plural, PluralKey, Shape, Strings, Translator } from './define';
export { I18nProvider, useI18n, useStrings } from './useI18n';
