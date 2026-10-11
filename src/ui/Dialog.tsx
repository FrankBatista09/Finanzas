// Modal dialog: backdrop, panel, title, body and a footer with buttons. Used by the month close, the month deletion and
// the goal form.
//
//   <Dialog title={t('closeMonth', { month })} onCancel={cancel} busy={busy} describedBy={bodyId} initialFocus={cancelRef}
//     footer={<>
//       <DialogButton ref={cancelRef} variant="quiet" onClick={cancel} disabled={busy}>{t('cancel')}</DialogButton>
//       <DialogButton variant="primary" onClick={confirm} disabled={busy}>…</DialogButton>
//     </>}>
//     <DialogText id={bodyId}>…</DialogText>
//   </Dialog>
//
// With onSubmit the content goes inside a <form>: Enter in a field, or a <DialogButton type="submit">, submits it.
// The body of a form is <DialogFields> with <Field>, <Input>, <MonthPicker>… (form.tsx).

import { useEffect, useId, useRef } from 'react';
import type { ComponentProps, FormEvent, HTMLAttributes, MouseEvent, ReactNode, RefObject } from 'react';
import { cx } from './cx';
import styles from './Dialog.module.css';

const FOCUSABLE = 'button:enabled, input:enabled:not([type="hidden"]), select:enabled, textarea:enabled, a[href]';

export interface DialogProps {
  /** Title of the dialog (it gives it its accessible name). */
  title: ReactNode;
  /** The body: <DialogText> or <DialogFields>. */
  children: ReactNode;
  /** The footer buttons (<DialogButton>), from left to right. */
  footer: ReactNode;
  /** Escape or a click on the backdrop. Not called while `busy`. */
  onCancel: () => void;
  /** Turns the content into a form and is called when it is submitted (except while `busy`). */
  onSubmit?: () => void;
  /** An operation is in progress: it is announced (aria-busy) and the dialog cannot be canceled. The buttons are disabled by whoever renders them. */
  busy?: boolean;
  /** What gets the focus on open (and when it stops being `busy`); by default, the first control of the dialog. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** id of the body element that describes the dialog. */
  describedBy?: string;
  /** Maximum width in px; 440 by default. */
  maxWidth?: number;
  /** 'large': about 92vw by 88vh, the body scrolls inside (the expanded view of a table card). */
  size?: 'large';
}

// Open dialogs, oldest first: a dialog opened from another one (pay a credit card from an expanded table) gets Escape
// and Tab alone, the one underneath waits.
const openDialogs: symbol[] = [];

/** Mount it to open it and unmount it to close it; on close, the focus goes back to where it was. */
export function Dialog({ title, children, footer, onCancel, onSubmit, busy = false, initialFocus, describedBy, maxWidth, size }: DialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const pressedOutside = useRef(false);
  const self = useRef(Symbol('dialog'));

  useEffect(() => {
    const me = self.current;
    openDialogs.push(me);
    return () => {
      openDialogs.splice(openDialogs.indexOf(me), 1);
    };
  }, []);

  // On close, the focus goes back to where it was (the button that opened the dialog, if it is still on screen).
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // The focus moves in on open. While `busy` the buttons are usually disabled and lose it: when it ends, it moves in again.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (busy || !dialog || dialog.contains(document.activeElement)) return;
    (initialFocus?.current ?? dialog.querySelector<HTMLElement>(FOCUSABLE))?.focus();
  }, [busy, initialFocus]);

  // On the document and not on the dialog: it has to work even if the focus was left outside.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== self.current) return;
      if (e.key === 'Escape') {
        // Something inside already used the key (the add row of an expanded table closes itself): the dialog stays.
        if (e.defaultPrevented) return;
        e.preventDefault();
        if (!busy) onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      // Tab does not leave the dialog: it cycles through its controls.
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        e.preventDefault();
      } else if (!dialogRef.current?.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  // Only a click that starts and ends on the backdrop counts (not the drag of a text selection).
  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    pressedOutside.current = e.target === e.currentTarget;
  };
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (pressedOutside.current && e.target === e.currentTarget && !busy) onCancel();
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!busy) onSubmit?.();
  };

  const content = (
    <>
      <h2 id={titleId} className={styles.title}>
        {title}
      </h2>
      {size === 'large' ? <div className={styles.body}>{children}</div> : children}
      <div className={styles.footer}>{footer}</div>
    </>
  );

  return (
    <div className={styles.backdrop} onMouseDown={onMouseDown} onClick={onClick}>
      <div
        ref={dialogRef}
        className={cx(styles.dialog, size === 'large' && styles.large)}
        style={maxWidth ? { maxWidth } : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        aria-busy={busy}
      >
        {onSubmit ? (
          <form className={styles.form} onSubmit={submit} noValidate>
            {content}
          </form>
        ) : (
          content
        )}
      </div>
    </div>
  );
}

/** Text body of a dialog. With `id`, it serves as the description (Dialog describedBy). */
export function DialogText({ className, children, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p {...rest} className={cx(styles.text, className)}>
      {children}
    </p>
  );
}

/** Form body of a dialog: a column of fields. */
export function DialogFields({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx(styles.fields, className)}>
      {children}
    </div>
  );
}

export interface DialogButtonProps extends ComponentProps<'button'> {
  /**
   * primary      green: the main action
   * secondary    with a border (the default)
   * quiet        text only: Cancel
   * danger       text only, red on hover: delete (one more option in the footer)
   * destructive  red: the main action of a dialog that confirms a deletion with no way back
   */
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger' | 'destructive';
  /** Puts it at the start of the footer, apart from the others (a "Delete goal" on the left). */
  start?: boolean;
}

/** Footer button of a dialog. type="button" unless "submit" is asked for. */
export function DialogButton({ variant = 'secondary', start, type = 'button', className, children, ...rest }: DialogButtonProps) {
  return (
    <button {...rest} type={type} className={cx(styles.button, styles[variant], start && styles.start, className)}>
      {children}
    </button>
  );
}
