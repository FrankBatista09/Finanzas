import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, normalizeHex, THEME_PRESETS } from '../../shared/theme';
import type { ThemeColors } from '../../shared/types';
import { applyTheme } from './apply';
import { contrast, hsl, hueSat, luminance, mix } from './color';
import { DEFAULT_VARS, MIN_CONTRAST, ringShades, themeVars } from './derive';
import type { ThemeVar } from './derive';

const NAMES = Object.keys(DEFAULT_VARS) as ThemeVar[];

/** El valor efectivo de cada variable con ese tema: lo que sustituye, y tokens.css para lo demás. */
function palette(theme: ThemeColors | null): Record<ThemeVar, string> {
  return { ...DEFAULT_VARS, ...themeVars(theme) };
}

/** Los pares texto/fondo que tienen que leerse, sea cual sea el tema. */
const READABLE: readonly [text: ThemeVar | string, bg: ThemeVar | string][] = [
  ['--on-accent', '--accent'],
  ['--on-accent', '--accent-hover'],
  ['--accent-text', '#fffefa'],
  ['--accent-text', '#f6f5f0'],
  ['--bar-text', '--bar'],
  ['--bar-text', '--bar-input'],
  ['--text-light', '--bar'],
  ['--banner-ok', '--bar'],
  ['--banner-over', '--bar'],
  ['--page-text', '--page'],
  ['--page-text-soft', '--page'],
  ['--page-text-muted', '--page'],
  ['--tabs-text', '--tabs-bg'],
];

function expectReadable(theme: ThemeColors, name: string): void {
  const vars = palette(theme);
  const color = (v: string) => (v.startsWith('--') ? vars[v as ThemeVar] : v);
  for (const [text, bg] of READABLE) {
    expect(contrast(color(text), color(bg)), `${name}: ${text} sobre ${bg}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
  }
}

describe('aritmética de color', () => {
  it('luminancia y contraste WCAG', () => {
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#ffffff')).toBeCloseTo(1, 10);
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 10);
    expect(contrast('#2f7d52', '#2f7d52')).toBe(1);
    // Valor de referencia: #767676 es el gris más claro que pasa AA sobre blanco.
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrast('#ffffff', '#2f7d52')).toBe(contrast('#2f7d52', '#ffffff'));
  });

  it('mezcla, tono y saturación', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(hueSat('#ff0000')).toEqual({ h: 0, s: 1 });
    expect(hueSat('#808080')).toEqual({ h: 0, s: 0 });
    expect(hueSat('#2f7d52').h).toBeCloseTo(147, 0);
    expect(hsl(0, 1, 0.5)).toBe('#ff0000');
    expect(hsl(120, 1, 0.25)).toBe('#008000');
    expect(hsl(210, 0, 0.5)).toBe('#808080');
  });
});

describe('themeVars', () => {
  it('sin tema, o con el original, no sustituye nada', () => {
    expect(themeVars(null)).toEqual({});
    expect(themeVars(DEFAULT_THEME)).toEqual({});
    expect(themeVars(THEME_PRESETS[0]!.colors)).toEqual({});
    // Mayúsculas o forma corta del mismo color: sigue siendo el original.
    expect(themeVars({ accent: '#2F7D52', header: '#1D1F1C', background: '#EFEEE8' })).toEqual({});
  });

  it('los valores por defecto son los de tokens.css', () => {
    const css = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
    for (const name of NAMES) {
      const declared = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(css)?.[1];
      expect(declared, name).toBeDefined();
      expect(normalizeHex(declared), name).toBe(DEFAULT_VARS[name]);
    }
  });

  it('un tema no válido se ignora entero', () => {
    for (const bad of [
      undefined,
      'ocean',
      42,
      {},
      { accent: '#2a6f97' },
      { accent: 'red', header: '#16202a', background: '#eef1f4' },
      { accent: '#2a6f97', header: '#16202', background: '#eef1f4' },
      { accent: '#2a6f97', header: '#16202a', background: 'url(javascript:alert(1))' },
      { accent: '#2a6f97', header: '#16202a', background: null },
    ]) {
      expect(themeVars(bad), JSON.stringify(bad)).toEqual({});
    }
  });

  it('cada color solo cambia lo suyo', () => {
    const accentOnly = themeVars({ ...DEFAULT_THEME, accent: '#2a6f97' });
    expect(Object.keys(accentOnly).sort()).toEqual(
      ['--accent', '--accent-hover', '--accent-text', '--banner-ok', '--donut-fixed', '--donut-pending', '--on-accent'].sort(),
    );
    expect(accentOnly['--accent']).toBe('#2a6f97');

    const headerOnly = themeVars({ ...DEFAULT_THEME, header: '#16202a' });
    expect(Object.keys(headerOnly).sort()).toEqual(
      ['--banner-ok', '--banner-over', '--bar', '--bar-border', '--bar-border-strong', '--bar-input', '--bar-text', '--text-light'].sort(),
    );
    expect(headerOnly['--bar']).toBe('#16202a');

    const backgroundOnly = themeVars({ ...DEFAULT_THEME, background: '#eef1f4' });
    expect(Object.keys(backgroundOnly).sort()).toEqual(
      ['--page', '--page-border', '--page-text', '--page-text-muted', '--page-text-soft', '--tabs-bg', '--tabs-border', '--tabs-text'].sort(),
    );
    expect(backgroundOnly['--page']).toBe('#eef1f4');
  });

  it('nunca toca superficies, colores de tabla ni el rojo de error', () => {
    for (const preset of THEME_PRESETS) {
      for (const name of Object.keys(themeVars(preset.colors))) expect(NAMES, name).toContain(name);
    }
    expect(NAMES).not.toContain('--surface');
    expect(NAMES).not.toContain('--error');
    expect(NAMES).not.toContain('--border');
    expect(NAMES).not.toContain('--th-bg');
  });

  it('todo lo que devuelve es un color #rrggbb', () => {
    for (const preset of THEME_PRESETS) {
      for (const [name, value] of Object.entries(themeVars(preset.colors))) expect(value, `${preset.id} ${name}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('la paleta original ya cumple en los pares que importan', () => {
    const vars = palette(null);
    expect(contrast(vars['--on-accent'], vars['--accent'])).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(contrast(vars['--bar-text'], vars['--bar'])).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(contrast(vars['--text-light'], vars['--bar'])).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(contrast(vars['--accent-text'], '#f6f5f0')).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(contrast(vars['--page-text-muted'], vars['--page'])).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it('cada tema listo da texto legible sobre el acento, sobre la barra y sobre la página', () => {
    for (const preset of THEME_PRESETS.slice(1)) {
      const vars = palette(preset.colors);
      expect(contrast(vars['--on-accent'], preset.colors.accent), `${preset.id}: texto sobre acento`).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(contrast(vars['--bar-text'], preset.colors.header), `${preset.id}: texto sobre barra`).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expectReadable(preset.colors, preset.id);
    }
  });

  it('elige texto claro u oscuro según el fondo', () => {
    // Acento oscuro → texto claro; acento claro → texto oscuro. Lo mismo la barra.
    expect(luminance(palette({ ...DEFAULT_THEME, accent: '#14324a' })['--on-accent'])).toBeGreaterThan(0.8);
    expect(luminance(palette({ ...DEFAULT_THEME, accent: '#f2c94c' })['--on-accent'])).toBeLessThan(0.1);
    expect(luminance(palette({ ...DEFAULT_THEME, header: '#101418' })['--bar-text'])).toBeGreaterThan(0.8);
    expect(luminance(palette({ ...DEFAULT_THEME, header: '#f4f1e8' })['--bar-text'])).toBeLessThan(0.1);
    expect(luminance(palette({ ...DEFAULT_THEME, background: '#15171a' })['--page-text'])).toBeGreaterThan(0.8);
  });

  it('con cualquier combinación de colores el texto se sigue leyendo', () => {
    const levels = ['00', '3c', '7f', 'b4', 'ff'];
    const colors: string[] = [];
    for (const r of levels) for (const g of levels) for (const b of levels) colors.push(`#${r}${g}${b}`);
    // Cada color en los tres papeles, combinado con dos colores muy distintos en los otros dos.
    colors.forEach((c, i) => {
      const other = colors[(i * 7 + 31) % colors.length]!;
      const third = colors[(i * 13 + 59) % colors.length]!;
      expectReadable({ accent: c, header: other, background: third }, `${c}/${other}/${third}`);
      expectReadable({ accent: third, header: c, background: other }, `${third}/${c}/${other}`);
    });
  });

  it('los segmentos de la dona se distinguen del acento', () => {
    for (const accent of ['#2a6f97', '#0b1220', '#101010', '#f2c94c', '#f5f0e6', '#808080', ...THEME_PRESETS.map((p) => p.colors.accent)]) {
      const vars = palette({ ...DEFAULT_THEME, accent });
      expect(contrast(vars['--donut-fixed'], accent), `${accent}: fijos pagados`).toBeGreaterThanOrEqual(1.5);
      expect(contrast(vars['--donut-pending'], accent), `${accent}: fijos pendientes`).toBeGreaterThanOrEqual(1.25);
      expect(contrast(vars['--donut-fixed'], vars['--donut-pending']), `${accent}: entre sí`).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('el hover se aleja del color del texto: nunca pierde contraste', () => {
    for (const accent of ['#2a6f97', '#f2c94c', '#a8741a', '#7a4b8c']) {
      const vars = palette({ ...DEFAULT_THEME, accent });
      expect(vars['--accent-hover']).not.toBe(accent);
      expect(contrast(vars['--on-accent'], vars['--accent-hover'])).toBeGreaterThan(contrast(vars['--on-accent'], accent));
    }
  });
});

describe('ringShades: los tonos de la dona del dinero por cuenta', () => {
  it('tantos tonos como segmentos, todos #rrggbb; con uno solo, el acento', () => {
    expect(ringShades(null, 0)).toEqual([]);
    expect(ringShades(null, -3)).toEqual([]);
    expect(ringShades(null, 1)).toEqual(['#2f7d52']);
    for (const n of [2, 3, 5, 8]) {
      const shades = ringShades(null, n);
      expect(shades).toHaveLength(n);
      for (const shade of shades) expect(shade).toMatch(/^#[0-9a-f]{6}$/);
      expect(new Set(shades).size, String(n)).toBe(n);
    }
  });

  it('van del tono oscuro de la dona al acento y de ahí al claro', () => {
    // Con la paleta original: de #2b3a33 (fijos pagados) a #2f7d52 (acento) y a #c9d3c9 (pendientes).
    const five = ringShades(null, 5);
    expect(five[2]).toBe(DEFAULT_VARS['--accent']);
    for (let i = 1; i < five.length; i++) expect(luminance(five[i]!)).toBeGreaterThan(luminance(five[i - 1]!));
    expect(luminance(five[0]!)).toBeGreaterThanOrEqual(luminance(DEFAULT_VARS['--donut-fixed']));
    expect(luminance(five[4]!)).toBeLessThanOrEqual(luminance(DEFAULT_VARS['--donut-pending']));
    // Con dos, uno a cada lado del acento.
    expect(ringShades(null, 2)).toEqual([mix('#2b3a33', '#2f7d52', 0.5), mix('#2f7d52', '#c9d3c9', 0.5)]);
  });

  it('siguen los colores del usuario: salen de las mismas variables que su dona de presupuesto', () => {
    for (const preset of THEME_PRESETS.slice(1)) {
      const vars = palette(preset.colors);
      const three = ringShades(preset.colors, 3);
      expect(three[1], preset.id).toBe(preset.colors.accent);
      expect(three, preset.id).toEqual([
        mix(vars['--donut-fixed'], vars['--accent'], 1 / 3),
        vars['--accent'],
        mix(vars['--accent'], vars['--donut-pending'], 2 / 3),
      ]);
      expect(three, preset.id).not.toEqual(ringShades(null, 3));
    }
    // Un tema no válido cuenta como la paleta original.
    expect(ringShades({ accent: 'red' }, 3)).toEqual(ringShades(null, 3));
  });

  it('con hasta ocho cuentas, dos segmentos vecinos se siguen distinguiendo, sea cual sea el tema', () => {
    for (const preset of THEME_PRESETS) {
      for (const n of [2, 3, 4, 6, 8]) {
        const shades = ringShades(preset.colors, n);
        for (let i = 1; i < n; i++) expect(contrast(shades[i]!, shades[i - 1]!), `${preset.id} ${n}: ${i}`).toBeGreaterThanOrEqual(1.15);
      }
    }
  });
});

describe('applyTheme', () => {
  function page() {
    const props = new Map<string, string>();
    const meta = { content: '#1d1f1c' };
    return {
      props,
      meta,
      target: {
        root: { style: { setProperty: (n: string, v: string) => void props.set(n, v), removeProperty: (n: string) => props.delete(n) } },
        meta: { setAttribute: (_name: string, value: string) => void (meta.content = value) },
      },
    };
  }

  it('pone las variables del tema y el color de la barra del navegador', () => {
    const p = page();
    const ocean = THEME_PRESETS.find((t) => t.id === 'ocean')!.colors;
    applyTheme(ocean, p.target);
    expect(Object.fromEntries(p.props)).toEqual(themeVars(ocean));
    expect(p.props.get('--bar')).toBe('#16202a');
    expect(p.meta.content).toBe('#16202a');
  });

  it('con null no deja nada puesto: manda tokens.css', () => {
    const p = page();
    applyTheme(THEME_PRESETS[1]!.colors, p.target);
    applyTheme(null, p.target);
    expect(p.props.size).toBe(0);
    expect(p.meta.content).toBe('#1d1f1c');
  });

  it('al cambiar de tema quita lo que el nuevo no sustituye', () => {
    const p = page();
    applyTheme({ accent: '#2a6f97', header: '#16202a', background: '#eef1f4' }, p.target);
    applyTheme({ ...DEFAULT_THEME, accent: '#7a4b8c' }, p.target);
    expect(p.props.has('--bar')).toBe(false);
    expect(p.props.has('--page')).toBe(false);
    expect(p.props.get('--accent')).toBe('#7a4b8c');
    expect(p.meta.content).toBe('#1d1f1c');
  });

  it('funciona sin <meta name="theme-color">', () => {
    const p = page();
    expect(() => applyTheme(THEME_PRESETS[2]!.colors, { root: p.target.root, meta: null })).not.toThrow();
    expect(p.props.get('--accent')).toBe('#7a4b8c');
  });
});
