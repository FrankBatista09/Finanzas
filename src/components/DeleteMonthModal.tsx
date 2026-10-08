import { useId, useRef } from 'react';
import type { MonthKey } from '../../shared/types';
import { useI18n } from '../i18n';
import { useFinanzas, useShell } from '../store';
import { Dialog, DialogButton, DialogText } from '../ui';

/** Diálogo para borrar un mes. Lo abre actions.requestDeleteMonth(); Escape y un clic fuera equivalen a Cancelar. */
export function DeleteMonthModal() {
  const { deleteDialog } = useShell();
  if (!deleteDialog) return null;
  return <DeleteDialog monthKey={deleteDialog.key} busy={deleteDialog.busy} />;
}

function DeleteDialog({ monthKey, busy }: { monthKey: MonthKey; busy: boolean }) {
  const { confirmDelete, cancelDelete } = useShell();
  const { state } = useFinanzas();
  const { t, label } = useI18n();
  const bodyId = useId();
  // El foco entra en Cancelar: borrar no tiene vuelta atrás.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const month = state.months[monthKey];

  return (
    <Dialog
      title={t('deleteMonthTitle', { month: label(monthKey) })}
      onCancel={cancelDelete}
      busy={busy}
      describedBy={bodyId}
      initialFocus={cancelRef}
      footer={
        <>
          <DialogButton ref={cancelRef} variant="quiet" onClick={cancelDelete} disabled={busy}>
            {t('cancel')}
          </DialogButton>
          <DialogButton variant="destructive" onClick={confirmDelete} disabled={busy}>
            {t('delete')}
          </DialogButton>
        </>
      }
    >
      <DialogText id={bodyId}>
        {t('deleteMonthBody', {
          fixed: t('countFixed', { count: month?.fixed.length ?? 0 }),
          transactions: t('countTransactions', { count: month?.tx.length ?? 0 }),
          transfers: t('countTransfers', { count: month?.transfers.length ?? 0 }),
        })}
      </DialogText>
    </Dialog>
  );
}
