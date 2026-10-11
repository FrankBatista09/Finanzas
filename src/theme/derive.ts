// From the three colors the user picks (accent, top bar, background) to the rest of the palette.
// Pure function: the theme goes in, a map of CSS variables that override those in src/styles/tokens.css comes out.
// With the original theme (or null) the map comes out empty: nothing is overridden and the app looks exactly as always.
//
// What is derived from each color:
//   · accent      → hover, readable text on top of it, the accent used as text, and the donut shades
//   · bar         → its text, and the shades of inputs, borders and muted text that sit on it
//   · background  → the tab bar and the text and borders that sit directly on the page
// The surfaces (cards), the table colors and the error red do not change.

import { DEFAULT_THEME, normalizeTheme } from '../../shared/theme';
import { contrast, hsl, hueSat, luminance, mix } from './color';

/** WCAG AA minimum contrast for normal text. */
export const MIN_CONTRAST = 4.5;

/**
 * The tokens.css values of the variables a theme can override (theme.test.ts checks that they match).
 * They are used to know the effective value of a variable: `themeVars(theme)[name] ?? DEFAULT_VARS[name]`.
 */
export const DEFAULT_VARS = {
  '--accent': '#2f7d52',
  '--accent-hover': '#23613f',
  '--accent-text': '#23613f',
  '--on-accent': '#ffffff',
  '--donut-fixed': '#2b3a33',
  '--donut-pending': '#c9d3c9',
  '--bar': '#1d1f1c',
  '--bar-text': '#f4f3ee',
  '--bar-input': '#2b2e29',
  '--bar-border': '#3a3d38',
  '--bar-border-strong': '#4a4d47',
  '--text-light': '#a9aba3',
  '--banner-over': '#f0a596',
  '--banner-ok': '#9fd3b2',
  '--page': '#efeee8',
  '--page-text': '#1d1f1c',
  '--page-text-soft': '#45473f',
  '--page-text-muted': '#6b6d66',
  '--page-border': '#cfccc1',
  '--tabs-bg': '#e4e2da',
  '--tabs-text': '#6b6d66',
  '--tabs-border': '#cfccc1',
} as const;

export type ThemeVar = keyof typeof DEFAULT_VARS;
export type ThemeVars = Partial<Record<ThemeVar, string>>;

// Fixed colors of the design to mix with or compare against.
const INK = '#1d1f1c';
const LIGHT = '#f4f3ee';
const WHITE = '#ffffff';
const BLACK = '#000000';
const ERROR = '#b23a2a';
/** The darkest surface that the accent color is written on (table header). */
const SURFACE = '#f6f5f0';

/**
 * Readable text on `bg`: the design's light or dark one, whichever gives more contrast. If neither reaches the
 * minimum (mid-tone backgrounds), pure white or black: one of the two always exceeds it.
 */
function readable(bg: string, light: string, dark: string): string {
  const best = contrast(light, bg) >= contrast(dark, bg) ? light : dark;
  if (contrast(best, bg) >= MIN_CONTRAST) return best;
  return contrast(WHITE, bg) >= contrast(BLACK, bg) ? WHITE : BLACK;
}

/** Moves `color` toward `target` just enough for it to be readable on `bg`. */
function legible(color: string, bg: string, target: string): string {
  let out = color;
  for (let step = 1; step <= 20 && contrast(out, bg) < MIN_CONTRAST; step++) out = mix(color, target, step / 20);
  return out;
}

/**
 * Neighboring shade of `base` for a control or a strip that carries the same text on top: one step toward the text
 * color, as in the design. On a mid-tone background that step would leave the text without contrast; in that
 * case it is taken the other way, which always improves it.
 */
function raised(base: string, text: string, t: number): string {
  const toward = mix(base, text, t);
  if (contrast(text, toward) >= MIN_CONTRAST) return toward;
  return mix(base, luminance(text) > 0.5 ? BLACK : WHITE, t);
}

function accentVars(accent: string): ThemeVars {
  const onAccent = readable(accent, WHITE, INK);
  // The hover moves away from the text color, so it never loses contrast: it darkens under light text and vice versa.
  const away = luminance(onAccent) > 0.5 ? BLACK : WHITE;
  const { h, s } = hueSat(accent);
  const tint = (sat: number, light: number) => hsl(h, Math.min(s, sat), light);
  // Donut: paid fixed expenses in a dark, muted shade of the accent, pending ones in a light one. If the accent is
  // already very dark or very light, the neighboring shade moves to mid gray so the segments can be told apart.
  let fixed = tint(0.15, 0.2);
  if (contrast(fixed, accent) < 1.6) fixed = tint(0.15, 0.46);
  let pending = tint(0.1, 0.81);
  if (contrast(pending, accent) < 1.25) pending = tint(0.1, 0.55);
  return {
    '--accent': accent,
    '--accent-hover': mix(accent, away, 0.22),
    '--accent-text': legible(mix(accent, BLACK, 0.22), SURFACE, BLACK),
    '--on-accent': onAccent,
    '--donut-fixed': fixed,
    '--donut-pending': pending,
  };
}

function headerVars(header: string): ThemeVars {
  const text = readable(header, LIGHT, INK);
  const shade = (t: number) => mix(header, text, t);
  return {
    '--bar': header,
    '--bar-text': text,
    '--bar-input': raised(header, text, 0.065),
    '--bar-border': shade(0.135),
    '--bar-border-strong': shade(0.21),
    '--text-light': legible(shade(0.65), header, text),
    '--banner-over': legible(mix(ERROR, text, 0.55), header, text),
  };
}

function backgroundVars(background: string): ThemeVars {
  const text = readable(background, LIGHT, INK);
  const shade = (t: number) => mix(background, text, t);
  const tabs = raised(background, text, 0.06);
  return {
    '--page': background,
    '--page-text': text,
    '--page-text-soft': legible(shade(0.8), background, text),
    '--page-text-muted': legible(shade(0.62), background, text),
    '--page-border': shade(0.16),
    '--tabs-bg': tabs,
    '--tabs-text': legible(mix(tabs, text, 0.6), tabs, text),
    '--tabs-border': shade(0.16),
  };
}

/**
 * `count` shades for a donut with as many segments as needed (the money per account). They come from the same
 * palette as the budget donut, so they follow the user's colors: they go from the dark shade (--donut-fixed)
 * to the accent and from there to the light one (--donut-pending), evenly spread. With a single segment, the accent.
 */
export function ringShades(theme: unknown, count: number): string[] {
  const vars = { ...DEFAULT_VARS, ...themeVars(theme) };
  const n = Math.max(0, Math.floor(count));
  return Array.from({ length: n }, (_, i) => {
    const at = (i + 0.5) / n;
    return at <= 0.5 ? mix(vars['--donut-fixed'], vars['--accent'], at * 2) : mix(vars['--accent'], vars['--donut-pending'], (at - 0.5) * 2);
  });
}

/**
 * CSS variables that override those in tokens.css for that theme. Each color that matches the original overrides
 * none of its own; a null theme, an incomplete one or one with a color that is not hexadecimal is ignored entirely ({}).
 */
export function themeVars(theme: unknown): ThemeVars {
  const colors = normalizeTheme(theme);
  if (!colors) return {};
  const customAccent = colors.accent !== DEFAULT_THEME.accent;
  const customHeader = colors.header !== DEFAULT_THEME.header;
  const vars: ThemeVars = {
    ...(customAccent ? accentVars(colors.accent) : null),
    ...(customHeader ? headerVars(colors.header) : null),
    ...(colors.background !== DEFAULT_THEME.background ? backgroundVars(colors.background) : null),
  };
  // "Vs. budget" within budget: the accent lightened (or darkened) until it is readable on the bar.
  if (customAccent || customHeader) {
    const barText = readable(colors.header, LIGHT, INK);
    vars['--banner-ok'] = legible(mix(colors.accent, barText, 0.55), colors.header, barText);
  }
  return vars;
}
