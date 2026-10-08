// El idioma en React. Sale, por este orden, de:
//   1. <I18nProvider lang>: FinanzasProvider lo pone con el idioma del usuario o, antes de tener sus datos,
//      con el último usado en el dispositivo (pantallas de carga y de error).
//   2. El estado que haya en FinanzasContext (state.language): una pantalla montada suelta en una prueba, solo
//      con su FinanzasContext, sale en el idioma de ese estado sin tener que envolverla en nada.
//   3. Inglés.
// En la app los dos primeros coinciden siempre: con datos cargados, el proveedor lleva state.language.

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { DEFAULT_LANGUAGE } from '../../shared/i18n';
import type { Language } from '../../shared/types';
import { FinanzasContext } from '../store/context';
import { createI18n } from './core';
import type { I18n } from './core';
import { translator } from './define';
import type { Dict, Strings, Translator } from './define';

const LanguageContext = createContext<Language | null>(null);

export function I18nProvider({ lang, children }: { lang: Language; children: ReactNode }) {
  return <LanguageContext value={lang}>{children}</LanguageContext>;
}

function useLanguage(): Language {
  const explicit = useContext(LanguageContext);
  const finanzas = useContext(FinanzasContext);
  return explicit ?? finanzas?.state.language ?? DEFAULT_LANGUAGE;
}

/**
 * El idioma actual y sus ayudantes: `t` (textos comunes), `lang`, `label` (meses), `catLabel`, `methodLabel`,
 * `fixedCategory`, `monthNames` y `rateHint` (de dónde salió una tasa). El objeto es estable mientras no cambie el idioma.
 */
export function useI18n(): I18n {
  return createI18n(useLanguage());
}

/** El traductor de los textos propios de una pantalla (los que declaró con defineStrings) en el idioma actual. */
export function useStrings<D extends Dict>(strings: Strings<D>): Translator<D> {
  return translator(strings, useLanguage());
}
