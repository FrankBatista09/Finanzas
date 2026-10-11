// Per-user customizable colors. Only the data (three colors) and its validation live here, shared by
// the API and the web. How they become the rest of the palette (hover, donut, readable text…) is up to src/theme.

import type { ThemeColors } from './types';

/** The palette of the original design. A user with no saved theme (theme: null) sees exactly this. */
export const DEFAULT_THEME: ThemeColors = { accent: '#2f7d52', header: '#1d1f1c', background: '#efeee8' };

export interface ThemePreset {
  id: string;
  name: string;
  colors: ThemeColors;
}

/** Themes ready to pick with one click. The first one is the original. */
export const THEME_PRESETS: readonly ThemePreset[] = [
  { id: 'forest', name: 'Forest', colors: DEFAULT_THEME },
  { id: 'ocean', name: 'Ocean', colors: { accent: '#2a6f97', header: '#16202a', background: '#eef1f4' } },
  { id: 'plum', name: 'Plum', colors: { accent: '#7a4b8c', header: '#221a26', background: '#f1eef2' } },
  { id: 'terracotta', name: 'Terracotta', colors: { accent: '#b5553c', header: '#2a1f1b', background: '#f3eee9' } },
  { id: 'rose', name: 'Rose', colors: { accent: '#b24a6e', header: '#261a1f', background: '#f4eef0' } },
  { id: 'amber', name: 'Amber', colors: { accent: '#a8741a', header: '#231d12', background: '#f2efe6' } },
  { id: 'slate', name: 'Slate', colors: { accent: '#4a5d73', header: '#1b1f24', background: '#eceef0' } },
];

const HEX_RE = /^#[0-9a-f]{6}$/;

/** '#RRGGBB' or '#rgb' → '#rrggbb' in lowercase; null if it is not a hexadecimal color. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return HEX_RE.test(s) ? s : null;
}

/** Validates and normalizes a theme received from outside; null if a color is missing or one is not valid. */
export function normalizeTheme(v: unknown): ThemeColors | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const accent = normalizeHex(o.accent);
  const header = normalizeHex(o.header);
  const background = normalizeHex(o.background);
  return accent && header && background ? { accent, header, background } : null;
}

/** true if the theme is the original palette (it is stored as null so it follows changes to the design). */
export function isDefaultTheme(t: ThemeColors | null): boolean {
  return (
    !t ||
    (t.accent === DEFAULT_THEME.accent && t.header === DEFAULT_THEME.header && t.background === DEFAULT_THEME.background)
  );
}
