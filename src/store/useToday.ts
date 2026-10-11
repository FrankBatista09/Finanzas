import { useEffect, useState } from 'react';
import { todayISO } from '../../shared/month';
import type { ISODate } from '../../shared/types';

/** Today in the user's time zone. Checked every minute and on returning to the tab, in case midnight has passed. */
export function useToday(): ISODate {
  const [today, setToday] = useState(() => todayISO());

  useEffect(() => {
    const check = () => setToday(todayISO());
    const timer = setInterval(check, 60_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  return today;
}
