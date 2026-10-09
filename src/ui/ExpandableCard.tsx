import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Card } from './Card';
import { Dialog, DialogButton } from './Dialog';
import { ExpandedContext, ExpandOpenContext } from './expandContext';

export interface ExpandableCardProps {
  /** Plain-text title: it names the expanded dialog (the card's own header shows it in the card). */
  title: string;
  className?: string;
  /** The card body, a CardHeader included. It is rendered once in the card and once in the dialog, so its state must live above. */
  children: ReactNode;
  /** Dialogs the card opens (pay, details): rendered once, next to the card, so they work from both copies. */
  outside?: ReactNode;
}

/**
 * A table card with an expand button in its header. Expanding shows the same body full size in a large dialog;
 * the body's state (drafts, open add row) lives in the screen component, so both copies stay in sync. Any dialog
 * the card opens goes in `outside`, or it would be mounted twice.
 */
export function ExpandableCard({ title, className, children, outside }: ExpandableCardProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // The button that opened it. Safari does not focus a button on click, so the dialog cannot rely on remembering it.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) opener.current?.focus();
  }, [open]);
  const close = () => setOpen(false);
  return (
    <>
      {/* While expanded the card behind the dialog is inert: one live copy of every control at a time. */}
      <Card className={className} inert={open}>
        <ExpandOpenContext
          value={(button) => {
            opener.current = button;
            setOpen(true);
          }}
        >{children}</ExpandOpenContext>
      </Card>
      {open && (
        <Dialog
          size="large"
          title={title}
          onCancel={close}
          footer={
            <DialogButton variant="secondary" onClick={close}>
              {t('close')}
            </DialogButton>
          }
        >
          <ExpandedContext value>
            {/* The wrapper takes the card's class so its container queries and sizing rules still find a host. */}
            <div className={className}>{children}</div>
          </ExpandedContext>
        </Dialog>
      )}
      {outside}
    </>
  );
}
