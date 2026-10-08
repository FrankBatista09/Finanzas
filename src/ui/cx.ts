/** Une nombres de clase, saltándose los valores falsos. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Colores de texto que usan las celdas del prototipo. Sin tono, la celda hereda la tinta. */
export type Tone = 'soft' | 'muted' | 'faint' | 'ok' | 'error';
