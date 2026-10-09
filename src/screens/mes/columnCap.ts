import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** Both columns start at the same offset only while they sit side by side (otherwise the right one wrapped below). */
export function sideBySide(leftTop: number, rightTop: number): boolean {
  return leftTop === rightTop;
}

/** The max-height for the left card: the right column's height, only while the columns sit side by side. */
export function capHeight(sideBySide: boolean, sideHeight: number): number | null {
  // Round first so a sub-pixel height never yields a 0px cap.
  const height = Math.round(sideHeight);
  return sideBySide && height > 0 ? height : null;
}

/** CSS variable on the columns wrapper that the left card reads as its max-height. */
export const CAP_VAR = '--fixed-max-h';

/**
 * Keeps CAP_VAR in sync with the height of the `side` column. Only `side` is observed, and the variable is written
 * straight to the DOM (no re-render), so the capped card can never feed back into the height being measured: `side`
 * is sized by its own content. When the columns wrap, `side` starts lower than `left`, so the cap is removed.
 */
export function useColumnCap(): {
  columns: RefObject<HTMLDivElement | null>;
  left: RefObject<HTMLDivElement | null>;
  side: RefObject<HTMLDivElement | null>;
} {
  const columns = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);
  // Layout effect: the cap is applied before the first paint, so the card does not flash at full height.
  useLayoutEffect(() => {
    const host = columns.current;
    const leftEl = left.current;
    const right = side.current;
    if (!host || !leftEl || !right || typeof ResizeObserver === 'undefined') return;
    const sync = () => {
      const cap = capHeight(sideBySide(leftEl.offsetTop, right.offsetTop), right.offsetHeight);
      if (cap === null) host.style.removeProperty(CAP_VAR);
      else host.style.setProperty(CAP_VAR, `${cap}px`);
    };
    sync();
    // Width changes (viewport resize, wrapping) also fire here because the column flexes with the row.
    const observer = new ResizeObserver(sync);
    observer.observe(right);
    return () => observer.disconnect();
  }, []);
  return { columns, left, side };
}
