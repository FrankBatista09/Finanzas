// Pone el tema del usuario en la página: variables CSS en el elemento raíz (ganan a las de tokens.css)
// y el color de la barra del navegador (<meta name="theme-color">).

import { normalizeTheme } from '../../shared/theme';
import type { ThemeColors } from '../../shared/types';
import { DEFAULT_VARS, themeVars } from './derive';
import type { ThemeVar } from './derive';

/** Lo mínimo del DOM que hace falta; en la app es document.documentElement y el <meta> de index.html. */
export interface ThemeTarget {
  root: { style: { setProperty(name: string, value: string): void; removeProperty(name: string): unknown } };
  meta: { setAttribute(name: string, value: string): void } | null;
}

function pageTarget(): ThemeTarget {
  return { root: document.documentElement, meta: document.querySelector('meta[name="theme-color"]') };
}

/**
 * Aplica el tema (null = la paleta original). Lo que el tema no sustituye se quita del elemento raíz, de modo
 * que vuelve a mandar tokens.css: pasar de un tema a otro, o a ninguno, no deja restos del anterior.
 */
export function applyTheme(theme: ThemeColors | null, target: ThemeTarget = pageTarget()): void {
  const vars = themeVars(theme);
  for (const name of Object.keys(DEFAULT_VARS) as ThemeVar[]) {
    const value = vars[name];
    if (value === undefined) target.root.style.removeProperty(name);
    else target.root.style.setProperty(name, value);
  }
  target.meta?.setAttribute('content', normalizeTheme(theme)?.header ?? DEFAULT_VARS['--bar']);
}
