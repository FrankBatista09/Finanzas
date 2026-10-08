// Colores personalizables por usuario. Aquí solo va el dato (tres colores) y su validación, que comparten
// la API y la web. Cómo se convierten en el resto de la paleta (hover, dona, texto legible…) es cosa de src/theme.

import type { ThemeColors } from './types';

/** La paleta del diseño original. Un usuario sin tema guardado (theme: null) ve exactamente esto. */
export const DEFAULT_THEME: ThemeColors = { accent: '#2f7d52', header: '#1d1f1c', background: '#efeee8' };

export interface ThemePreset {
  id: string;
  name: string;
  colors: ThemeColors;
}

/** Temas listos para elegir con un clic. El primero es el original. */
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

/** '#RRGGBB' o '#rgb' → '#rrggbb' en minúsculas; null si no es un color hexadecimal. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return HEX_RE.test(s) ? s : null;
}

/** Valida y normaliza un tema recibido de fuera; null si falta algún color o alguno no es válido. */
export function normalizeTheme(v: unknown): ThemeColors | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const accent = normalizeHex(o.accent);
  const header = normalizeHex(o.header);
  const background = normalizeHex(o.background);
  return accent && header && background ? { accent, header, background } : null;
}

/** true si el tema es la paleta original (se guarda como null para que siga los cambios del diseño). */
export function isDefaultTheme(t: ThemeColors | null): boolean {
  return (
    !t ||
    (t.accent === DEFAULT_THEME.accent && t.header === DEFAULT_THEME.header && t.background === DEFAULT_THEME.background)
  );
}
