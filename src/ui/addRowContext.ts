import { createContext } from 'react';
import type { RefObject } from 'react';

export interface AddRowApi {
  /** Runs the row's "add". If something was added, the focus goes back to the first field, ready for the next one. */
  submit: () => void;
}

/** Provided by <AddRow>. The cells and the "Add" button use it to know they are in an add row. */
export const AddRowContext = createContext<AddRowApi | null>(null);

/**
 * An add row that opens on demand (useAddRow): closed, it is not rendered. Shared by the "+ Add …" button
 * in the header (<AddRowButton>) and the row (<AddRow control>).
 */
export interface AddRowControl {
  open: boolean;
  show: () => void;
  /** Closes the row and discards its draft. */
  hide: () => void;
  /** The button that opens it: when it is closed with Esc the focus goes back to it. */
  buttonRef: RefObject<HTMLButtonElement | null>;
}

/**
 * true: add rows start open. In the app nobody provides it (they start closed); the tests use it, since they
 * render to HTML and cannot press the button.
 */
export const AddRowsOpenContext = createContext(false);

/** What a key does inside an add row. */
export type AddRowKeyAction = 'submit' | 'cancel' | null;

/**
 * Enter in a text, number or date field adds the row (selects and buttons already have their own Enter;
 * in the middle of an IME composition it does not count). Esc, from any control of a row that can be closed,
 * closes it and discards the draft.
 */
export function addRowKeyAction(e: { key: string; isComposing: boolean; inInput: boolean; closable: boolean }): AddRowKeyAction {
  if (e.isComposing) return null;
  if (e.key === 'Escape') return e.closable ? 'cancel' : null;
  return e.key === 'Enter' && e.inInput ? 'submit' : null;
}
