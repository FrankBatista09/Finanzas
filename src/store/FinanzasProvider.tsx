// Connects the data layer to React: the session (users), the user, the month and the sheet from the URL, the query
// with that user's data, their language and colors, the flows (close and delete a month, Excel, development
// utilities) and the notices. The screens only see useFinanzas() and, for the texts, useI18n().

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

  // ── Session and user ───────────────────────────────────────────────────────
  const session = useQuery({
    queryKey: SESSION_KEY,
    queryFn: ({ signal }) => api.getSession({ signal }),
    retry: 1,
    // The user list only changes with a deploy.
    staleTime: Infinity,
  });
  const users = session.data?.users ?? NO_USERS;
  const user = useMemo(() => resolveUser(users, url.user, device.user()), [users, url.user, device]);
  const userId = user?.id ?? null;
  // Each user has their own data layer; switching users changes the store, not what each one has pending.
  const store = userId ? stores.for(userId) : null;

  const query = useQuery({
    queryKey: stateKey(userId ?? ''),
    queryFn: store ? store.queryFn : skipToken,
    // One retry is enough: if the server is down, better to show the retry button soon.
    retry: 1,
    // Returning to the tab refreshes (Claude may have recorded something from the chat), but not on every rapid focus change.
    staleTime: 5000,
  });

  const state = query.data?.state ?? null;
  const monthKey = state ? resolveMonth(url.mes, state) : null;
  const sheet = url.hoja;

  // ── Language and colors ────────────────────────────────────────────────────
  // Before the user's data is available (loading, error, switching users) the last language used here wins.
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

  // Before painting: when switching users, no frame with the previous user's colors gets shown.
  useLayoutEffect(() => applyTheme(theme), [theme]);

  // ── When pending writes are sent ───────────────────────────────────────────
  useEffect(() => {
    let unloading = false;
    // On leaving any cell.
    const onFocusOut = () => stores.flush({ unload: unloading });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stores.flush();
    };
    const onPageHide = () => {
      unloading = true;
      try {
        // The blur makes the active cell commit whatever it had half-typed (dates commit on leaving);
        // its focusout goes through onFocusOut, which at this point already sends with keepalive.
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

  // On switching users, months or sheets (also with the back button): what is pending is saved—each write
  // with the user it was made for—and the dialogs are closed.
  useEffect(() => {
    stores.flush();
    setCloseFor(null);
    setDeleteFor(null);
  }, [stores, userId, monthKey, sheet]);

  // The Excel import status belongs to the user who ran it.
  useEffect(() => setExcelStatus(null), [userId]);

  useEffect(
    () =>
      stores.onError((failure) => {
        const text = `${t('saveFailed')} ${describeError(failure.error, t)}`;
        // It may be a write left in another user's queue: the notice says whose it is.
        const owner = failure.userId === userId ? null : users.find((u) => u.id === failure.userId);
        notify(owner ? `${owner.name}: ${text}` : text);
      }),
    [stores, notify, t, userId, users],
  );

  // ── Navigation ─────────────────────────────────────────────────────────────
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
      // The month stays in the URL; if the other user does not have it, resolveMonth falls back to their current month.
      go({ user: id });
    },
    [users, device, go],
  );

  // ── Flows ──────────────────────────────────────────────────────────────────
  // They are asynchronous and work with the store of the user they started for. If the user was switched meanwhile,
  // they finish their work with that data, but no longer touch the navigation or the screen state.
  const shown = useRef(store);
  useEffect(() => {
    shown.current = store;
  }, [store]);

  const fail = useCallback((key: CoreKey, e: unknown) => notify(`${t(key)} ${describeError(e, t)}`), [notify, t]);

  const downloadExcel = useCallback(async (months?: readonly MonthKey[]) => {
    if (!store) return;
    try {
      await store.settle();
      // The workbook comes from what the server holds right now (including whatever Claude has recorded
      // from the chat), not from the cache; it is built here, in the browser, in the user's language.
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
        // The file is read in the browser and only its content goes to the server, already as JSON.
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
      // If anything else arrives (the event of a direct onClick), it counts as "the selected month".
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
        // With no month in the URL, the user's current month is followed (resolveMonth).
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

  // ── Context values ─────────────────────────────────────────────────────────
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
    // A state with no months should not arrive (GET /api/state creates the current month), nor a session with no users:
    // they are treated as a load error.
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
