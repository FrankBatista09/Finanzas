import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** The max-height for the left card: the right column's height, only while the columns sit side by side. */
export function capHeight(sideBySide: boolean, sideHeight: number): number | null {
  return sideBySide && sideHeight > 0 ? Math.round(sideHeight) : null;
}

/** CSS variable on the columns wrapper that the left card reads as its max-height. */
export const CAP_VAR = '--fixed-max-h';

/**
 * Keeps CAP_VAR in sync with the height of the `side` column. Only `side` is observed, and the variable is written
 * straight to the DOM (no re-render), so the capped card can never feed back into the height being measured: `side`
 * is sized by its own content. When the columns wrap, `side` starts lower than the first column, so the cap is removed.
 */
export function useColumnCap(): { columns: RefObject<HTMLDivElement | null>; side: RefObject<HTMLDivElement | null> } {
  const columns = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = columns.current;
    const right = side.current;
    const left = host?.firstElementChild;
    if (!host || !right || !(left instanceof HTMLElement) || typeof ResizeObserver === 'undefined') return;
    const sync = () => {
      const cap = capHeight(right.offsetTop === left.offsetTop, right.offsetHeight);
      if (cap === null) host.style.removeProperty(CAP_VAR);
      else host.style.setProperty(CAP_VAR, `${cap}px`);
    };
    sync();
    // Width changes (viewport resize, wrapping) also fire here because the column flexes with the row.
    const observer = new ResizeObserver(sync);
    observer.observe(right);
    return () => observer.disconnect();
  }, []);
  return { columns, side };
}
