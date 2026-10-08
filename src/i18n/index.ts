// Punto de entrada de las traducciones para componentes y pantallas.
//
//   const { t, lang, label, catLabel, methodLabel, rateHint } = useI18n();   // textos comunes y ayudantes del idioma actual
//   const s = useStrings(MES);                                      // textos propios, declarados con defineStrings
//
// Fuera de React (funciones puras, pruebas): createI18n(lang) y translator(MES, lang); el idioma de un usuario
// es state.language. Las claves comunes están en en.ts; cada pantalla declara las suyas en su carpeta.

export { CORE, createI18n } from './core';
export type { CoreKey, CoreStrings, CoreTranslator, I18n } from './core';
export { defineStrings, interpolate, translator } from './define';
export type { Dict, Entry, Params, PlainKey, Plural, PluralKey, Shape, Strings, Translator } from './define';
export { I18nProvider, useI18n, useStrings } from './useI18n';
