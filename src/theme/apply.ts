// Puts the user's theme on the page: CSS variables on the root element (they win over those in tokens.css)
// and the color of the browser bar (<meta name="theme-color">).

import { normalizeTheme } from '../../shared/theme';
import type { ThemeColors } from '../../shared/types';
import { DEFAULT_VARS, themeVars } from './derive';
import type { ThemeVar } from './derive';

/** The minimum of the DOM that is needed; in the app it is document.documentElement and the <meta> from index.html. */
export interface ThemeTarget {
  root: { style: { setProperty(name: string, value: string): void; removeProperty(name: string): unknown } };
  meta: { setAttribute(name: string, value: string): void } | null;
}

function pageTarget(): ThemeTarget {
  return { root: document.documentElement, meta: document.querySelector('meta[name="theme-color"]') };
}

/**
 * Applies the theme (null = the original palette). Whatever the theme does not override is removed from the root
 * element, so tokens.css takes over again: going from one theme to another, or to none, leaves no trace of the old one.
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
