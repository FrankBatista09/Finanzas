// The language in React. It comes, in this order, from:
//   1. <I18nProvider lang>: FinanzasProvider sets it to the user's language or, before it has their data,
//      to the last one used on the device (loading and error screens).
//   2. Whatever state is in FinanzasContext (state.language): a screen mounted on its own in a test, with only
//      its FinanzasContext, renders in that state's language without having to wrap it in anything.
//   3. English.
// In the app the first two always match: with data loaded, the provider carries state.language.

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
 * The current language and its helpers: `t` (common strings), `lang`, `label` (months), `catLabel`, `methodLabel`,
 * `fixedCategory`, `monthNames` and `rateHint` (where a rate came from). The object is stable until the language changes.
 */
export function useI18n(): I18n {
  return createI18n(useLanguage());
}

/** The translator of a screen's own strings (the ones it declared with defineStrings) in the current language. */
export function useStrings<D extends Dict>(strings: Strings<D>): Translator<D> {
  return translator(strings, useLanguage());
}
