import { useStrings } from '../../i18n';
import { Td } from '../../ui';
import type { Tone } from '../../ui';
import styles from './AhorrosScreen.module.css';
import type { RateNote } from './model';
import { AHORROS } from './strings';

export interface ConvertedProps {
  /** The figure, already formatted. */
  value: string;
  /** The rate it was converted with (./model rateNote). */
  note: RateNote;
  tone?: Tone;
  last?: boolean;
}

/**
 * Cell for a converted figure. If the rate is not the one typed for its month, where it came from goes in the title; if it is
 * the fixed default value, the figure is also shown in red with an asterisk, which <FallbackNote> explains below the table.
 */
export function Converted({ value, note, tone, last }: ConvertedProps) {
  return (
    <Td kind="num" nowrap tone={note.fallback ? 'error' : tone} last={last} title={note.hint || undefined}>
      {value}
      {note.fallback && '*'}
    </Td>
  );
}

/** The footer that explains the asterisk. It is only rendered if some figure in the table carries one. */
export function FallbackNote({ show }: { show: boolean }) {
  const s = useStrings(AHORROS);
  return show ? <div className={styles.fallbackNote}>{s('fallbackNote')}</div> : null;
}
