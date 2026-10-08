// De los tres colores que elige el usuario (acento, barra superior, fondo) al resto de la paleta.
// Función pura: entra el tema, sale un mapa de variables CSS que sustituyen a las de src/styles/tokens.css.
// Con el tema original (o null) el mapa sale vacío: no se sustituye nada y la app se ve exactamente como siempre.
//
// Qué se deriva de cada color:
//   · acento  → hover, texto legible encima, el acento usado como texto, y los tonos de la dona
//   · barra   → su texto, y los tonos de inputs, bordes y texto atenuado que van sobre ella
//   · fondo   → la barra de pestañas y el texto y los bordes que van directamente sobre la página
// Las superficies (tarjetas), los colores de tabla y el rojo de error no cambian.

import { DEFAULT_THEME, normalizeTheme } from '../../shared/theme';
import { contrast, hsl, hueSat, luminance, mix } from './color';

/** Contraste mínimo de WCAG AA para texto normal. */
export const MIN_CONTRAST = 4.5;

/**
 * Los valores de tokens.css de las variables que un tema puede sustituir (theme.test.ts comprueba que coinciden).
 * Sirven para saber el valor efectivo de una variable: `themeVars(theme)[name] ?? DEFAULT_VARS[name]`.
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

// Colores fijos del diseño con los que se mezcla o se compara.
const INK = '#1d1f1c';
const LIGHT = '#f4f3ee';
const WHITE = '#ffffff';
const BLACK = '#000000';
const ERROR = '#b23a2a';
/** La superficie más oscura sobre la que se escribe con el color de acento (encabezado de tabla). */
const SURFACE = '#f6f5f0';

/**
 * Texto legible sobre `bg`: el claro o el oscuro del diseño, el que más contraste dé. Si ninguno llega al
 * mínimo (fondos de tono medio), blanco o negro puros: uno de los dos siempre lo supera.
 */
function readable(bg: string, light: string, dark: string): string {
  const best = contrast(light, bg) >= contrast(dark, bg) ? light : dark;
  if (contrast(best, bg) >= MIN_CONTRAST) return best;
  return contrast(WHITE, bg) >= contrast(BLACK, bg) ? WHITE : BLACK;
}

/** Acerca `color` a `target` lo justo para que se lea sobre `bg`. */
function legible(color: string, bg: string, target: string): string {
  let out = color;
  for (let step = 1; step <= 20 && contrast(out, bg) < MIN_CONTRAST; step++) out = mix(color, target, step / 20);
  return out;
}

/**
 * Tono vecino de `base` para un control o una franja que lleva encima el mismo texto: un paso hacia el color
 * del texto, como en el diseño. Sobre un fondo de tono medio ese paso dejaría el texto sin contraste; entonces
 * se da hacia el otro lado, que siempre lo mejora.
 */
function raised(base: string, text: string, t: number): string {
  const toward = mix(base, text, t);
  if (contrast(text, toward) >= MIN_CONTRAST) return toward;
  return mix(base, luminance(text) > 0.5 ? BLACK : WHITE, t);
}

function accentVars(accent: string): ThemeVars {
  const onAccent = readable(accent, WHITE, INK);
  // El hover se aleja del color del texto, así nunca pierde contraste: oscurece bajo texto claro y al revés.
  const away = luminance(onAccent) > 0.5 ? BLACK : WHITE;
  const { h, s } = hueSat(accent);
  const tint = (sat: number, light: number) => hsl(h, Math.min(s, sat), light);
  // Dona: fijos pagados en un tono oscuro y apagado del acento, pendientes en uno claro. Si el acento ya es
  // muy oscuro o muy claro, el tono vecino se mueve al gris medio para que los segmentos se distingan.
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
 * `count` tonos para una dona con tantos segmentos como haga falta (el dinero por cuenta). Salen de la misma
 * paleta que la dona de presupuesto, así que siguen los colores del usuario: van del tono oscuro (--donut-fixed)
 * al acento y de ahí al claro (--donut-pending), repartidos por igual. Con un solo segmento, el acento.
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
 * Variables CSS que sustituyen a las de tokens.css para ese tema. Cada color que coincide con el original no
 * sustituye nada de lo suyo; un tema null, incompleto o con un color que no sea hexadecimal se ignora entero ({}).
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
  // "Vs. budget" dentro de presupuesto: el acento aclarado (u oscurecido) hasta leerse sobre la barra.
  if (customAccent || customHeader) {
    const barText = readable(colors.header, LIGHT, INK);
    vars['--banner-ok'] = legible(mix(colors.accent, barText, 0.55), colors.header, barText);
  }
  return vars;
}
