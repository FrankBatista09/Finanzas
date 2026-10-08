// Conecta la capa de datos con React: la sesión (usuarios), el usuario, el mes y la hoja de la URL, la consulta
// con los datos de ese usuario, su idioma y sus colores, los flujos (cerrar y borrar mes, Excel, utilidades de
// desarrollo) y los avisos. Las pantallas solo ven useFinanzas() y, para los textos, useI18n().

import { skipToken, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CloseRequest } from '../../shared/api';
import { APP_NAME } from '../../shared/constants';
import { DEFAULT_LANGUAGE } from '../../shared/i18n';
import type { AppUser, Language, MonthKey } from '../../shared/types';
import type { ApiClient } from '../api/client';
import { createI18n, I18nProvider } from '../i18n';
import type { CoreKey } from '../i18n';
import { applyTheme } from '../theme';
import { createActions } from './actions';
import { FinanzasContext, ShellContext } from './context';
import type { ExcelStatus, Finanzas, Shell } from './context';
import { excelBlob, excelFilename, readExcel } from './excel';
import { putMonths } from './reducers';
import { deviceMemory, resolveUser } from './session';
import { SESSION_KEY, stateKey } from './store';
import type { FinanzasStores } from './store';
import { resolveMonth } from './url';
import type { UrlState } from './url';
import { useNotices } from './useNotices';
import { useToday } from './useToday';
import { useUrlState } from './useUrlState';
import { describeError, saveBlob } from './util';
import { buildFinanzas } from './view';

export interface FinanzasProviderProps {
  stores: FinanzasStores;
  api: ApiClient;
  children: ReactNode;
}

const NO_USERS: readonly AppUser[] = [];

export function FinanzasProvider({ stores, api, children }: FinanzasProviderProps) {
  const device = useMemo(() => deviceMemory(), []);
  const [url, navigate] = useUrlState();
  const today = useToday();
  const { notices, notify, dismiss } = useNotices();
  const [closeFor, setCloseFor] = useState<MonthKey | null>(null);
  const [closing, setClosing] = useState(false);
  const [deleteFor, setDeleteFor] = useState<MonthKey | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [excelStatus, setExcelStatus] = useState<ExcelStatus | null>(null);

  // ── Sesión y usuario ───────────────────────────────────────────────────────
  const session = useQuery({
    queryKey: SESSION_KEY,
    queryFn: ({ signal }) => api.getSession({ signal }),
    retry: 1,
    // La lista de usuarios solo cambia con un despliegue.
    staleTime: Infinity,
  });
  const users = session.data?.users ?? NO_USERS;
  const user = useMemo(() => resolveUser(users, url.user, device.user()), [users, url.user, device]);
  const userId = user?.id ?? null;
  // Cada usuario tiene su capa de datos; al cambiar de usuario cambia la store, no lo que cada una tiene pendiente.
  const store = userId ? stores.for(userId) : null;

  const query = useQuery({
    queryKey: stateKey(userId ?? ''),
    queryFn: store ? store.queryFn : skipToken,
    // Un reintento basta: si el servidor no está, mejor enseñar pronto el botón de reintentar.
    retry: 1,
    // Volver a la pestaña refresca (Claude pudo registrar algo desde el chat), pero no en cada cambio de foco seguido.
    staleTime: 5000,
  });

  const state = query.data?.state ?? null;
  const monthKey = state ? resolveMonth(url.mes, state) : null;
  const sheet = url.hoja;

  // ── Idioma y colores ───────────────────────────────────────────────────────
  // Antes de tener los datos del usuario (carga, error, cambio de usuario) manda el último idioma usado aquí.
  const [deviceLanguage, setDeviceLanguage] = useState<Language>(() => device.language() ?? DEFAULT_LANGUAGE);
  const userLanguage = state?.language;
  const language = userLanguage ?? deviceLanguage;
  const theme = state?.theme ?? null;
  const i18n = createI18n(language);
  const { t } = i18n;

  useEffect(() => {
    if (!userLanguage) return;
    device.rememberLanguage(userLanguage);
    setDeviceLanguage(userLanguage);
  }, [device, userLanguage]);

  useEffect(() => {
    if (userId) device.rememberUser(userId);
  }, [device, userId]);

  const title = monthKey ? `${sheet === 'ahorros' ? t('savings') : i18n.label(monthKey)} · ${APP_NAME}` : APP_NAME;
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = title;
  }, [language, title]);

  // Antes de pintar: al cambiar de usuario no llega a verse un fotograma con los colores del anterior.
  useLayoutEffect(() => applyTheme(theme), [theme]);

  // ── Cuándo se manda lo pendiente ───────────────────────────────────────────
  useEffect(() => {
    let unloading = false;
    // Al salir de cualquier celda.
    const onFocusOut = () => stores.flush({ unload: unloading });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stores.flush();
    };
    const onPageHide = () => {
      unloading = true;
      try {
        // El blur hace que la celda activa confirme lo que tuviera a medias (las fechas confirman al salir);
        // su focusout pasa por onFocusOut, que en este momento ya manda con keepalive.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        stores.flush({ unload: true });
      } finally {
        unloading = false;
      }
    };
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [stores]);

  // Al cambiar de usuario, de mes o de hoja (también con el botón atrás): se guarda lo pendiente —cada escritura
  // con el usuario para el que se hizo— y se cierran los modales.
  useEffect(() => {
    stores.flush();
    setCloseFor(null);
    setDeleteFor(null);
  }, [stores, userId, monthKey, sheet]);

  // El estado de la carga de Excel es del usuario que la hizo.
  useEffect(() => setExcelStatus(null), [userId]);

  useEffect(
    () =>
      stores.onError((failure) => {
        const text = `${t('saveFailed')} ${describeError(failure.error, t)}`;
        // Puede ser una escritura que quedó en cola de otro usuario: se dice de quién.
        const owner = failure.userId === userId ? null : users.find((u) => u.id === failure.userId);
        notify(owner ? `${owner.name}: ${text}` : text);
      }),
    [stores, notify, t, userId, users],
  );

  // ── Navegación ─────────────────────────────────────────────────────────────
  const go = useCallback(
    (change: Partial<UrlState>) => {
      stores.flush();
      navigate(change);
    },
    [stores, navigate],
  );

  const goToUser = useCallback(
    (id: string) => {
      if (!users.some((u) => u.id === id)) return;
      device.rememberUser(id);
      // El mes se conserva en la URL; si el otro usuario no lo tiene, resolveMonth cae en su mes en curso.
      go({ user: id });
    },
    [users, device, go],
  );

  // ── Flujos ─────────────────────────────────────────────────────────────────
  // Son asíncronos y trabajan con la store del usuario para el que empezaron. Si entretanto se cambió de usuario,
  // terminan lo suyo con esos datos, pero ya no tocan la navegación ni el estado de la pantalla.
  const shown = useRef(store);
  useEffect(() => {
    shown.current = store;
  }, [store]);

  const fail = useCallback((key: CoreKey, e: unknown) => notify(`${t(key)} ${describeError(e, t)}`), [notify, t]);

  const downloadExcel = useCallback(async (months?: readonly MonthKey[]) => {
    if (!store) return;
    try {
      await store.settle();
      // El libro sale de lo que tiene el servidor en este momento (incluye lo que Claude haya registrado
      // desde el chat), no de la caché; se arma aquí, en el navegador, en el idioma del usuario.
      const fresh = await store.api.getState();
      saveBlob(excelBlob(fresh.state, months), excelFilename(fresh.user));
    } catch (e) {
      fail('downloadFailed', e);
    }
  }, [store, fail]);

  const importExcel = useCallback(
    async (file: File) => {
      if (!store) return;
      const here = () => shown.current === store;
      setExcelStatus({ kind: 'reading' });
      try {
        await store.settle();
        // El archivo se lee en el navegador y al servidor solo va su contenido, ya como JSON.
        const res = await store.api.importPayload(await readExcel(file));
        await store.refetch();
        if (!here()) return;
        const last = [...res.months].sort().pop() ?? null;
        go({ mes: last });
        setExcelStatus({ kind: 'loaded', file: file.name });
      } catch (e) {
        if (here()) setExcelStatus({ kind: 'failed' });
        fail('importFailed', e);
      }
    },
    [store, go, fail],
  );

  const devRun = useCallback(
    async (call: 'devSeed' | 'devReset', failed: CoreKey) => {
      if (!store) return;
      try {
        await store.settle();
        await store.api[call]();
        await store.refetch();
        if (shown.current !== store) return;
        setExcelStatus(null);
        go({ mes: null });
      } catch (e) {
        fail(failed, e);
      }
    },
    [store, go, fail],
  );
  const devSeed = useCallback(() => devRun('devSeed', 'devSeedFailed'), [devRun]);
  const devReset = useCallback(() => devRun('devReset', 'devResetFailed'), [devRun]);

  const requestCloseMonth = useCallback(() => {
    const current = monthKey ? store?.state?.months[monthKey] : undefined;
    if (current && !current.closed) setCloseFor(current.key);
  }, [store, monthKey]);

  const confirmClose = useCallback(
    async (withExcel: boolean, request?: CloseRequest) => {
      if (!store || !closeFor || closing) return;
      setClosing(true);
      try {
        await store.settle();
        const res = await store.api.closeMonth(closeFor, request);
        store.applyServer((s) => putMonths(s, res.closed, res.next));
        if (shown.current === store) {
          setCloseFor(null);
          go({ mes: res.next.key, hoja: 'mes' });
        }
        await store.refetch();
        if (withExcel) await downloadExcel();
      } catch (e) {
        fail('closeFailed', e);
      } finally {
        setClosing(false);
      }
    },
    [store, closeFor, closing, go, fail, downloadExcel],
  );

  const cancelClose = useCallback(() => {
    if (!closing) setCloseFor(null);
  }, [closing]);

  const requestDeleteMonth = useCallback(
    (key?: MonthKey) => {
      // Si llega otra cosa (el evento de un onClick directo), cuenta como "el mes seleccionado".
      const target = typeof key === 'string' ? key : monthKey;
      if (target && store?.state?.months[target]) setDeleteFor(target);
    },
    [store, monthKey],
  );

  const confirmDelete = useCallback(async () => {
    if (!store || !deleteFor || deleting) return;
    setDeleting(true);
    try {
      await store.deleteMonth(deleteFor);
      if (shown.current === store) {
        setDeleteFor(null);
        // Sin mes en la URL se sigue el mes en curso del usuario (resolveMonth).
        go({ mes: null });
      }
      await store.refetch();
    } catch (e) {
      fail('deleteMonthFailed', e);
    } finally {
      setDeleting(false);
    }
  }, [store, deleteFor, deleting, go, fail]);

  const cancelDelete = useCallback(() => {
    if (!deleting) setDeleteFor(null);
  }, [deleting]);

  // ── Valores de contexto ────────────────────────────────────────────────────
  const actions = useMemo(
    () =>
      store ? createActions(store, monthKey, { requestCloseMonth, requestDeleteMonth, importExcel, downloadExcel, devSeed, devReset }) : null,
    [store, monthKey, requestCloseMonth, requestDeleteMonth, importExcel, downloadExcel, devSeed, devReset],
  );

  const finanzas = useMemo<Finanzas | null>(
    () => (user && state && monthKey && actions ? buildFinanzas({ user, state, monthKey, today, actions }) : null),
    [user, state, monthKey, today, actions],
  );

  const { refetch: refetchSession } = session;
  const { refetch: refetchState } = query;
  const shell: Shell = {
    // Un estado sin ningún mes no debería llegar (GET /api/state crea el mes actual), ni una sesión sin usuarios:
    // se tratan como error de carga.
    status: finanzas ? 'ready' : session.isPending || (user !== null && query.isPending) ? 'loading' : 'error',
    retry: () => void (store ? refetchState() : refetchSession()),
    retrying: session.isFetching || query.isFetching,
    users,
    user,
    goToUser,
    language,
    sheet,
    goToSheet: (hoja) => go({ hoja }),
    goToMonth: (mes) => go({ mes }),
    devTools: session.data?.devTools ?? false,
    excelStatus,
    closeDialog: closeFor && closeFor === monthKey ? { key: closeFor, busy: closing } : null,
    confirmClose: (withExcel, request) => void confirmClose(withExcel, request),
    cancelClose,
    deleteDialog: deleteFor && state?.months[deleteFor] ? { key: deleteFor, busy: deleting } : null,
    confirmDelete: () => void confirmDelete(),
    cancelDelete,
    notices,
    dismissNotice: dismiss,
  };

  return (
    <I18nProvider lang={language}>
      <ShellContext value={shell}>
        <FinanzasContext value={finanzas}>{children}</FinanzasContext>
      </ShellContext>
    </I18nProvider>
  );
}
