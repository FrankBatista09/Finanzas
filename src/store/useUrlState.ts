import { useCallback, useEffect, useState } from 'react';
import { buildSearch, parseUrl } from './url';
import type { UrlState } from './url';

const sameUrl = (a: UrlState, b: UrlState) => a.user === b.user && a.mes === b.mes && a.hoja === b.hoja;

/**
 * Usuario, mes y hoja en la URL. `navigate` hace pushState (la navegación del usuario entra en el historial)
 * y el botón atrás del navegador llega por popstate.
 */
export function useUrlState(): [UrlState, (next: Partial<UrlState>) => void] {
  const [url, setUrl] = useState(() => parseUrl(window.location.search));

  useEffect(() => {
    const onPop = () => {
      const next = parseUrl(window.location.search);
      setUrl((prev) => (sameUrl(prev, next) ? prev : next));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((change: Partial<UrlState>) => {
    const { location, history } = window;
    const current = parseUrl(location.search);
    const next = { ...current, ...change };
    if (sameUrl(current, next)) return;
    history.pushState(null, '', location.pathname + buildSearch(next, location.search) + location.hash);
    setUrl(next);
  }, []);

  return [url, navigate];
}
