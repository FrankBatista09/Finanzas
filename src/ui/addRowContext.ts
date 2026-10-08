import { createContext } from 'react';

export interface AddRowApi {
  /** Ejecuta el "agregar" de la fila. `fromKeyboard` lleva después el foco al primer campo, listo para la siguiente. */
  submit: (fromKeyboard: boolean) => void;
}

/** Lo provee <AddRow>. Las celdas y el botón "Agregar" lo usan para saber que están en una fila de agregar. */
export const AddRowContext = createContext<AddRowApi | null>(null);
