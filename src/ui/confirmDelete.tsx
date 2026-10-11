// "Are you sure?" before any delete. DeleteButton wraps its action with this; dialogs that have their own Delete
// button (goal, credit card, hidden account) use the hook and <ConfirmDeleteDialog> directly.
//
//   const confirm = useConfirmDelete(() => actions.removeGoal(goal.id) && onClose());
//   <DialogButton onClick={() => confirm.request(goal.name)}>…</DialogButton>
//   {confirm.dialog('kindGoal')}

import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { Dialog, DialogButton, DialogText } from './Dialog';

/** What is being deleted, as a key of the shared strings ("Delete {kind}?"). */
export type DeleteKind =
  | 'kindExpense'
  | 'kindTransaction'
  | 'kindTransfer'
  | 'kindIncome'
  | 'kindRate'
  | 'kindBudgetEntry'
  | 'kindContribution'
  | 'kindGoal'
  | 'kindAccount'
  | 'kindCreditCard'
  | 'kindPayment'
  | 'kindOutsideExpense';

/** The item waiting for an answer, or null when no question is open. */
export type ConfirmState = { name: string } | null;
export type ConfirmEvent = { type: 'request'; name: string } | { type: 'cancel' } | { type: 'confirm' };

/** Pure state machine: `confirmed` is set only by 'confirm' on an open question, so the action runs once. */
export function confirmDeleteStep(state: ConfirmState, event: ConfirmEvent): { state: ConfirmState; confirmed: boolean } {
  if (event.type === 'request') return { state: { name: event.name }, confirmed: false };
  if (event.type === 'cancel') return { state: null, confirmed: false };
  return { state: null, confirmed: state !== null };
}

export interface ConfirmDelete {
  /** Opens the question for an item (its short description, already formatted). */
  request: (name: string) => void;
  /** The open dialog for that kind, or null. Render it anywhere: it goes to document.body. */
  dialog: (kind: DeleteKind) => ReactNode;
}

export function useConfirmDelete(onConfirm: () => void): ConfirmDelete {
  const [state, setState] = useState<ConfirmState>(null);
  const apply = (event: ConfirmEvent) => {
    const next = confirmDeleteStep(state, event);
    setState(next.state);
    if (next.confirmed) onConfirm();
  };
  return {
    request: (name) => apply({ type: 'request', name }),
    dialog: (kind) =>
      state && <ConfirmDeleteDialog kind={kind} name={state.name} onCancel={() => apply({ type: 'cancel' })} onConfirm={() => apply({ type: 'confirm' })} />,
  };
}

export interface ConfirmDeleteDialogProps {
  kind: DeleteKind;
  /** "Netflix · 1,137.00 DOP". */
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Cancel has the focus: Esc and Cancel keep the item; only Delete removes it. */
export function ConfirmDeleteDialog({ kind, name, onCancel, onConfirm }: ConfirmDeleteDialogProps) {
  const { t } = useI18n();
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // A portal: the button lives in table cells and inside other dialogs, and the backdrop must cover the whole page.
  return createPortal(
    <Dialog
      title={t('confirmDeleteTitle', { kind: t(kind) })}
      onCancel={onCancel}
      describedBy={`${id}-body`}
      initialFocus={cancelRef}
      maxWidth={400}
      footer={
        <>
          <DialogButton ref={cancelRef} variant="quiet" onClick={onCancel}>
            {t('cancel')}
          </DialogButton>
          <DialogButton variant="destructive" onClick={onConfirm}>
            {t('delete')}
          </DialogButton>
        </>
      }
    >
      <DialogText id={`${id}-body`}>
        {name && <strong>{name}</strong>}
        {name && <br />}
        {t('cantUndo')}
      </DialogText>
    </Dialog>,
    document.body,
  );
}
