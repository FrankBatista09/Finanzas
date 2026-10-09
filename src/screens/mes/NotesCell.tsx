import { useState } from 'react';
import { useStrings } from '../../i18n';
import { CellText, Dialog, DialogButton, Td } from '../../ui';
import { MAX_LEN } from './rows';
import { MES } from './strings';

interface NotesCellProps {
  value: string;
  onCommit: (text: string) => void;
  readOnly: boolean;
  /** El nombre de la fila, para las etiquetas accesibles ("Description of Coffee") y el título del diálogo. */
  name: string;
}

/**
 * La celda de descripción de una fila del historial: el texto en una línea y, al lado, "⋯", que abre la
 * descripción entera en un diálogo para leerla o editarla con espacio. La comparten las transacciones y los gastos
 * fuera de presupuesto.
 */
export function NotesCell({ value, onCommit, readOnly, name }: NotesCellProps) {
  const s = useStrings(MES);
  const named = { name };
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  // Al cerrar se guarda lo editado; al abrir se parte de lo que haya guardado.
  const close = () => {
    setOpen(false);
    if (!readOnly && text !== value) onCommit(text);
  };
  if (!open && text !== value) setText(value);
  return (
    <Td kind="edit">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <CellText value={value} onCommit={onCommit} readOnly={readOnly} small tone="muted" maxLength={MAX_LEN.notes} label={s('notesOf', named)} />
        {/* La celda es estrecha: una descripción larga se abre aparte para leerla o editarla con espacio. */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={s('openNotes', named)}
          title={s('openNotes', named)}
          style={{ border: 0, background: 'transparent', color: 'var(--text-faint)', cursor: 'pointer', padding: '0 8px', font: 'inherit' }}
        >
          ⋯
        </button>
      </div>
      {open && (
        <Dialog
          title={name}
          onCancel={close}
          maxWidth={560}
          footer={
            <DialogButton variant="primary" onClick={close}>
              {s('closeNotes')}
            </DialogButton>
          }
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            readOnly={readOnly}
            maxLength={MAX_LEN.notes}
            rows={10}
            aria-label={s('notesOf', named)}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '8px 10px',
              font: 'var(--fs-body)/1.5 var(--font-ui)',
              color: 'var(--ink)',
              background: 'var(--focus-bg)',
              resize: 'vertical',
            }}
          />
        </Dialog>
      )}
    </Td>
  );
}
