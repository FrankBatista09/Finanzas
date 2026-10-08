// Diálogo modal: fondo, panel, título, cuerpo y pie con botones. Lo usan el cierre de mes, el borrado de mes y el
// formulario de metas.
//
//   <Dialog title={t('closeMonth', { month })} onCancel={cancel} busy={busy} describedBy={bodyId} initialFocus={cancelRef}
//     footer={<>
//       <DialogButton ref={cancelRef} variant="quiet" onClick={cancel} disabled={busy}>{t('cancel')}</DialogButton>
//       <DialogButton variant="primary" onClick={confirm} disabled={busy}>…</DialogButton>
//     </>}>
//     <DialogText id={bodyId}>…</DialogText>
//   </Dialog>
//
// Con onSubmit el contenido va dentro de un <form>: Enter en un campo, o un <DialogButton type="submit">, lo envían.
// El cuerpo de un formulario es <DialogFields> con <Field>, <Input>, <MonthPicker>… (form.tsx).

import { useEffect, useId, useRef } from 'react';
import type { ComponentProps, FormEvent, HTMLAttributes, MouseEvent, ReactNode, RefObject } from 'react';
import { cx } from './cx';
import styles from './Dialog.module.css';

const FOCUSABLE = 'button:enabled, input:enabled:not([type="hidden"]), select:enabled, textarea:enabled, a[href]';

export interface DialogProps {
  /** Título del diálogo (le da su nombre accesible). */
  title: ReactNode;
  /** El cuerpo: <DialogText> o <DialogFields>. */
  children: ReactNode;
  /** Los botones del pie (<DialogButton>), de izquierda a derecha. */
  footer: ReactNode;
  /** Escape o un clic en el fondo. No se llama mientras `busy`. */
  onCancel: () => void;
  /** Convierte el contenido en un formulario y se llama al enviarlo (salvo mientras `busy`). */
  onSubmit?: () => void;
  /** Hay una operación en curso: se anuncia (aria-busy) y el diálogo no se puede cancelar. Los botones los deshabilita quien los pinta. */
  busy?: boolean;
  /** Qué recibe el foco al abrir (y al dejar de estar `busy`); por defecto, el primer control del diálogo. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** id del elemento del cuerpo que describe el diálogo. */
  describedBy?: string;
  /** Ancho máximo en px; 440 por defecto. */
  maxWidth?: number;
}

/** Se monta para abrirlo y se desmonta para cerrarlo; al cerrar, el foco vuelve a donde estaba. */
export function Dialog({ title, children, footer, onCancel, onSubmit, busy = false, initialFocus, describedBy, maxWidth }: DialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const pressedOutside = useRef(false);

  // Al cerrar, el foco vuelve a donde estaba (el botón que abrió el diálogo, si sigue en pantalla).
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // El foco entra al abrir. Mientras `busy` los botones suelen quedar deshabilitados y lo pierden: al terminar, vuelve a entrar.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (busy || !dialog || dialog.contains(document.activeElement)) return;
    (initialFocus?.current ?? dialog.querySelector<HTMLElement>(FOCUSABLE))?.focus();
  }, [busy, initialFocus]);

  // En el documento y no en el diálogo: tiene que funcionar aunque el foco se haya quedado fuera.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!busy) onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      // Tab no sale del diálogo: da la vuelta entre sus controles.
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

  // Solo cuenta el clic que empieza y termina en el fondo (no el arrastre de una selección de texto).
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
      {children}
      <div className={styles.footer}>{footer}</div>
    </>
  );

  return (
    <div className={styles.backdrop} onMouseDown={onMouseDown} onClick={onClick}>
      <div
        ref={dialogRef}
        className={styles.dialog}
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

/** Cuerpo de texto de un diálogo. Con `id`, sirve de descripción (Dialog describedBy). */
export function DialogText({ className, children, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p {...rest} className={cx(styles.text, className)}>
      {children}
    </p>
  );
}

/** Cuerpo de formulario de un diálogo: una columna de campos. */
export function DialogFields({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx(styles.fields, className)}>
      {children}
    </div>
  );
}

export interface DialogButtonProps extends ComponentProps<'button'> {
  /**
   * primary      verde: la acción principal
   * secondary    con borde (por defecto)
   * quiet        solo texto: Cancelar
   * danger       solo texto, rojo al pasar el cursor: eliminar (una opción más del pie)
   * destructive  rojo: la acción principal de un diálogo que confirma un borrado sin vuelta atrás
   */
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger' | 'destructive';
  /** Lo deja al principio del pie, separado de los demás (un "Delete goal" a la izquierda). */
  start?: boolean;
}

/** Botón del pie de un diálogo. type="button" salvo que se pida "submit". */
export function DialogButton({ variant = 'secondary', start, type = 'button', className, children, ...rest }: DialogButtonProps) {
  return (
    <button {...rest} type={type} className={cx(styles.button, styles[variant], start && styles.start, className)}>
      {children}
    </button>
  );
}
