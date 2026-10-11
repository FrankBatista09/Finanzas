import { useCallback, useEffect, useState } from 'react';
import { buildSearch, parseUrl } from './url';
import type { UrlState } from './url';

const sameUrl = (a: UrlState, b: UrlState) => a.user === b.user && a.mes === b.mes && a.hoja === b.hoja;

/**
 * User, month and sheet in the URL. `navigate` calls pushState (the user's navigation goes into the history)
 * and the browser's back button arrives through popstate.
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
