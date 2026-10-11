import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

/** When the cell reports the new value: on every keystroke, or on leaving it (and on Enter). */
export type CommitOn = 'change' | 'blur';

interface DraftOptions<T> {
  value: T;
  format: (value: T) => string;
  /** undefined = the text is not a valid value yet: not committed. Gets the input in case its validity must be checked. */
  parse: (text: string, input: HTMLInputElement | null) => T | undefined;
  onCommit?: (value: T) => void;
  commitOn?: CommitOn;
}

/**
 * Local draft of a cell. While it has the focus, the input shows what the user types ("12.", empty…)
 * and not what is in the cache, which only holds the already parsed value (12, 0). On leaving, it shows the cache again.
 * Without this, every optimistic update would rewrite the input mid-edit.
 */
export function useDraft<T>({ value, format, parse, onCommit, commitOn = 'change' }: DraftOptions<T>) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  /** Last value committed during this edit, so the same thing is not reported twice ("12" and "12."). */
  const last = useRef(value);

  const commit = (text: string) => {
    const next = parse(text, ref.current);
    if (next === undefined || Object.is(next, last.current)) return;
    last.current = next;
    onCommit?.(next);
  };

  const finish = () => {
    if (draft === null) return;
    if (commitOn === 'blur') commit(draft);
    setDraft(null);
  };

  // If the row moves within the table, the browser takes the focus away from the input without firing blur.
  // The draft must not survive that: it would stay there, covering the real value.
  useEffect(() => {
    if (draft !== null && document.activeElement !== ref.current) finish();
  });

  return {
    ref,
    value: draft ?? format(value),
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      const text = e.target.value;
      if (draft === null) last.current = value;
      setDraft(text);
      if (commitOn === 'change') commit(text);
    },
    onBlur: finish,
    /** Commits what was typed without leaving the cell (Enter). */
    commitNow: () => {
      if (draft !== null) commit(draft);
    },
  };
}
