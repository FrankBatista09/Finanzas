import { useId, useRef } from 'react';
import { nextKey } from '../../shared/month';
import type { MonthKey } from '../../shared/types';
import { useI18n } from '../i18n';
import { useShell } from '../store';
import { Dialog, DialogButton, DialogText } from '../ui';

/** Modal de cierre de mes. Lo abre actions.requestCloseMonth(); Escape y un clic fuera equivalen a Cancelar. */
export function CloseMonthModal() {
  const { closeDialog } = useShell();
  if (!closeDialog) return null;
  return <CloseDialog monthKey={closeDialog.key} busy={closeDialog.busy} />;
}

function CloseDialog({ monthKey, busy }: { monthKey: MonthKey; busy: boolean }) {
  const { confirmClose, cancelClose } = useShell();
  const { t, label } = useI18n();
  const bodyId = useId();
  // El foco entra en Cancelar: la opción que no cambia nada.
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      title={t('closeMonth', { month: label(monthKey) })}
      onCancel={cancelClose}
      busy={busy}
      describedBy={bodyId}
      initialFocus={cancelRef}
      footer={
        <>
          <DialogButton ref={cancelRef} variant="quiet" onClick={cancelClose} disabled={busy}>
            {t('cancel')}
          </DialogButton>
          <DialogButton onClick={() => confirmClose(false)} disabled={busy}>
            {t('closeOnlyPage')}
          </DialogButton>
          <DialogButton variant="primary" onClick={() => confirmClose(true)} disabled={busy}>
            {t('closeWithExcel')}
          </DialogButton>
        </>
      }
    >
      <DialogText id={bodyId}>{t('closeDialogBody', { next: label(nextKey(monthKey)) })}</DialogText>
    </Dialog>
  );
}
