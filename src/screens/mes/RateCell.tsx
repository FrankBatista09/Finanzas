import { parseAmount } from '../../../shared/format';
import { cx } from '../../ui';
import cells from '../../ui/cells.module.css';
import { useDraft } from '../../ui/useDraft';
import { rateText } from './rows';

interface RateCellProps {
  value: number;
  onCommit: (value: number) => void;
  /** Nombre accesible (aria-label). */
  label: string;
  /** Ancho mínimo en px. */
  minWidth?: number;
  /** Mes cerrado, o una tasa que no se escribe (1 entre cuentas de la misma moneda): se puede enfocar y copiar, no editar. */
  readOnly?: boolean;
  /** Vacío cuando el valor es 0 (la fila de agregar una tasa: así se ve el placeholder). */
  blankZero?: boolean;
  placeholder?: string;
}

/**
 * La tasa de un envío o de un par del mes. Es el CellNumber estrecho de src/ui con otro formato: fuera de edición enseña la tasa
 * con sus dos decimales (58.70 y no 58.7, que es lo que da un número pasado a texto).
 * CellNumber no deja elegir el formato; por eso esta celda repite su input con el borrador y los estilos de src/ui.
 * El día que CellNumber acepte un formato, sobra.
 */
export function RateCell({ value, onCommit, label, minWidth, readOnly, blankZero, placeholder }: RateCellProps) {
  const draft = useDraft({
    value,
    format: (rate: number) => (blankZero && !rate ? '' : rateText(rate)),
    // Igual que NumberField: algo a medio escribir que aún no es un número no se confirma.
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
