// La carcasa antes de tener datos: cargando y error de conexión, en el último idioma usado en el dispositivo.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Language } from '../shared/types';
import { App } from './App';
import { I18nProvider } from './i18n';
import { FinanzasContext, ShellContext } from './store';
import type { Shell } from './store';

const shell = (over: Partial<Shell>): Shell => ({
  status: 'loading',
  retry: () => {},
  retrying: false,
  users: [],
  user: null,
  goToUser: () => {},
  language: 'en',
  sheet: 'mes',
  goToSheet: () => {},
  goToMonth: () => {},
  devTools: false,
  excelStatus: null,
  closeDialog: null,
  confirmClose: () => {},
  cancelClose: () => {},
  deleteDialog: null,
  confirmDelete: () => {},
  cancelDelete: () => {},
  notices: [],
  dismissNotice: () => {},
  ...over,
});

function render(lang: Language, over: Partial<Shell>): string {
  return renderToStaticMarkup(
    <I18nProvider lang={lang}>
      <ShellContext value={shell(over)}>
        <FinanzasContext value={null}>
          <App />
        </FinanzasContext>
      </ShellContext>
    </I18nProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('App sin datos', () => {
  it('cargando: la marca y "Loading…"', () => {
    const html = render('en', { status: 'loading' });
    expect(text(html)).toBe('FE Finance Loading…');
    expect(html).toContain('role="status"');
    expect(text(render('es', { status: 'loading' }))).toBe('FE Finance Cargando…');
    expect(text(render('tr', { status: 'loading' }))).toBe('FE Finance Yükleniyor…');
  });

  it('sin conexión: explicación y botón para reintentar', () => {
    const html = render('en', { status: 'error' });
    expect(html).toContain('role="alert"');
    expect(text(html)).toBe(
      'FE Finance Could not reach the server Check your connection and try again. If your session expired, reload the page. Retry',
    );
    expect(html).not.toContain('disabled');
    expect(text(render('es', { status: 'error' }))).toBe(
      'FE Finance No se pudo conectar con el servidor Revisa tu conexión y vuelve a intentarlo. Si la sesión expiró, recarga la página. Reintentar',
    );
    expect(text(render('tr', { status: 'error' }))).toContain('Sunucuya ulaşılamadı');
  });

  it('mientras reintenta, el botón lo dice y queda deshabilitado', () => {
    const html = render('en', { status: 'error', retrying: true });
    expect(text(html)).toContain('Retrying…');
    expect(html).toContain('disabled');
    expect(text(render('es', { status: 'error', retrying: true }))).toContain('Reintentando…');
  });
});
