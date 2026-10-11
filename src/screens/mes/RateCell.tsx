import { parseAmount } from '../../../shared/format';
import { cx } from '../../ui';
import cells from '../../ui/cells.module.css';
import { useDraft } from '../../ui/useDraft';
import { rateText } from './rows';

interface RateCellProps {
  value: number;
  onCommit: (value: number) => void;
  /** Accessible name (aria-label). */
  label: string;
  /** Minimum width in px. */
  minWidth?: number;
  /** Closed month, or a rate that is not typed (1 between accounts of the same currency): it can be focused and copied, not edited. */
  readOnly?: boolean;
  /** Empty when the value is 0 (the add row for a rate: that way the placeholder shows). */
  blankZero?: boolean;
  placeholder?: string;
  /** How the rate looks when not being edited; by default, rateText. A computed (not typed) rate carries extra decimals: pass showRate. */
  format?: (rate: number) => string;
}

/**
 * The rate of a transfer or of a pair of the month. It is the narrow CellNumber from src/ui with another format: when not being edited it
 * shows the rate with its two decimals (58.70 and not 58.7, which is what a number converted to text gives).
 * CellNumber does not let you choose the format; that is why this cell repeats its input with the draft and the styles from src/ui.
 * The day CellNumber accepts a format, this cell is no longer needed.
 */
export function RateCell({ value, onCommit, label, minWidth, readOnly, blankZero, placeholder, format = rateText }: RateCellProps) {
  const draft = useDraft({
    value,
    format: (rate: number) => (blankZero && !rate ? '' : format(rate)),
    // Same as NumberField: something half-typed that is not a number yet is not committed.
    parse: (text, input) => (input?.validity.badInput ? undefined : parseAmount(text)),
    onCommit,
  });
  return (
    <input
      ref={draft.ref}
      type="number"
      step="any"
      inputMode="decimal"
      className={cx(cells.input, cells.number, cells.dense)}
      style={minWidth ? { minWidth } : undefined}
      value={draft.value}
      onChange={draft.onChange}
      onBlur={draft.onBlur}
      readOnly={readOnly}
      placeholder={placeholder}
      autoComplete="off"
      aria-label={label}
    />
  );
}
