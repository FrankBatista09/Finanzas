import { useEffect, useState } from 'react';
import { todayISO } from '../../shared/month';
import type { ISODate } from '../../shared/types';

/** Hoy en la zona horaria del usuario. Se revisa cada minuto y al volver a la pestaña, por si pasó la medianoche. */
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
