import { useCallback, useEffect, useRef, useState } from 'react';
import type { Notice } from './context';

/** Tiempo que un aviso permanece en pantalla. */
export const NOTICE_MS = 7000;

/** Avisos no bloqueantes que se quitan solos. Repetir un texto que ya está visible solo le renueva el tiempo. */
export function useNotices(): { notices: Notice[]; notify: (text: string) => void; dismiss: (id: number) => void } {
  const [notices, setNotices] = useState<Notice[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const visible = useRef<Notice[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    visible.current = visible.current.filter((n) => n.id !== id);
    setNotices(visible.current);
  }, []);

  const notify = useCallback(
    (text: string) => {
      let notice = visible.current.find((n) => n.text === text);
      if (!notice) {
        notice = { id: nextId.current++, text };
        visible.current = [...visible.current, notice];
        setNotices(visible.current);
      }
      const { id } = notice;
      clearTimeout(timers.current.get(id));
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), NOTICE_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  return { notices, notify, dismiss };
}
