/** Joins class names, skipping falsy values. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Text colors used by the prototype's cells. Without a tone, the cell inherits the ink color. */
export type Tone = 'soft' | 'muted' | 'faint' | 'ok' | 'error';
