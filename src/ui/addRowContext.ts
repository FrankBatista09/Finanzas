import { createContext } from 'react';
import type { RefObject } from 'react';

export interface AddRowApi {
  /** Ejecuta el "agregar" de la fila. Si se agregó, el foco vuelve al primer campo, listo para la siguiente. */
  submit: () => void;
}

/** Lo provee <AddRow>. Las celdas y el botón "Agregar" lo usan para saber que están en una fila de agregar. */
export const AddRowContext = createContext<AddRowApi | null>(null);

/**
 * Una fila de agregar que se abre a petición (useAddRow): cerrada no se pinta. La comparten el botón "+ Add …"
 * de la cabecera (<AddRowButton>) y la fila (<AddRow control>).
 */
export interface AddRowControl {
  open: boolean;
  show: () => void;
  /** Cierra la fila y descarta su borrador. */
  hide: () => void;
  /** El botón que la abre: al cerrarla con Esc el foco vuelve a él. */
  buttonRef: RefObject<HTMLButtonElement | null>;
}

/**
 * true: las filas de agregar nacen abiertas. En la app nadie lo provee (nacen cerradas); lo usan las pruebas, que
 * pintan a HTML sin poder pulsar el botón.
 */
export const AddRowsOpenContext = createContext(false);

/** Lo que hace una tecla dentro de una fila de agregar. */
export type AddRowKeyAction = 'submit' | 'cancel' | null;

/**
 * Enter en un campo de texto, número o fecha agrega la fila (los select y los botones ya tienen su propio Enter;
 * a media composición de un IME no cuenta). Esc, desde cualquier control de una fila que se puede cerrar, la
 * cierra y descarta el borrador.
 */
export function addRowKeyAction(e: { key: string; isComposing: boolean; inInput: boolean; closable: boolean }): AddRowKeyAction {
  if (e.isComposing) return null;
  if (e.key === 'Escape') return e.closable ? 'cancel' : null;
  return e.key === 'Enter' && e.inInput ? 'submit' : null;
}
