import { useStrings } from '../../i18n';
import { Td } from '../../ui';
import type { Tone } from '../../ui';
import styles from './AhorrosScreen.module.css';
import type { RateNote } from './model';
import { AHORROS } from './strings';

export interface ConvertedProps {
  /** La cifra, ya con formato. */
  value: string;
  /** La tasa con la que se convirtió (./model rateNote). */
  note: RateNote;
  tone?: Tone;
  last?: boolean;
}

/**
 * Celda de una cifra convertida. Si la tasa no es la escrita para su mes, de dónde salió va en el title; si es el
 * valor fijo de respaldo, la cifra va además en rojo y con un asterisco, que explica <FallbackNote> al pie de la tabla.
 */
export function Converted({ value, note, tone, last }: ConvertedProps) {
  return (
    <Td kind="num" nowrap tone={note.fallback ? 'error' : tone} last={last} title={note.hint || undefined}>
      {value}
      {note.fallback && '*'}
    </Td>
  );
}

/** El pie que explica el asterisco. Solo se pinta si alguna cifra de la tabla lo lleva. */
export function FallbackNote({ show }: { show: boolean }) {
  const s = useStrings(AHORROS);
  return show ? <div className={styles.fallbackNote}>{s('fallbackNote')}</div> : null;
}
