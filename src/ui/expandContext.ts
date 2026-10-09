import { createContext, useContext } from 'react';

/** true inside the expanded (dialog) copy of a table card: cells drop their width limits and ellipsis. */
export const ExpandedContext = createContext(false);

/** Opens the expanded view, told which button asked so focus can go back to it. Only the card itself provides it, so the copy inside the dialog has no expand button. */
export const ExpandOpenContext = createContext<((opener: HTMLElement) => void) | null>(null);

export const useExpanded = () => useContext(ExpandedContext);
