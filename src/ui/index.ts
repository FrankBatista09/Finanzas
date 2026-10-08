// Primitivas de UI compartidas por el panel resumen y las dos pantallas.
// Ninguna trae textos propios salvo los comunes ("Add", "Delete", "Actions"), que salen en el idioma actual;
// las etiquetas (label, placeholder) se les pasan ya traducidas: `t` es el de useI18n() y `s` el de useStrings().
//
// Fila editable (cada celda avisa con onCommit; la capa de datos agrupa y retrasa el guardado):
//
//   <Tr unpaid={!f.paid}>
//     <Td kind="center"><CellCheckbox checked={f.paid} onCommit={(paid) => actions.patchFixed(f.id, { paid })} disabled={readOnly} label={s('paidNamed', { name: f.name })} /></Td>
//     <Td kind="edit"><CellText value={f.name} onCommit={(name) => actions.patchFixed(f.id, { name })} readOnly={readOnly} minWidth={120} label={s('item')} /></Td>
//     <Td kind="edit"><CellNumber value={f.amount} onCommit={(amount) => actions.patchFixed(f.id, { amount })} readOnly={readOnly} label={t('amount')} /></Td>
//     <Td kind="edit"><CellSelect value={f.cur} options={CURRENCIES} onCommit={(cur) => actions.patchFixed(f.id, { cur })} disabled={readOnly} mono label={t('currency')} /></Td>
//     <Td kind="num" nowrap>{f2(dop)}</Td>
//     <Td kind="action">{!readOnly && <DeleteButton onClick={() => actions.removeFixed(f.id)} label={t('deleteNamed', { name: f.name })} />}</Td>
//   </Tr>
//
// Fila de agregar (el borrador vive en el estado de la pantalla; 0 = monto vacío; Enter o el botón llaman a onAdd).
// No está a la vista: la abre el "+ Add …" de la cabecera (addRow.tsx) y Esc o ese mismo botón la cierran.
//
//   const adding = useAddRow(() => setDraft(EMPTY));
//   <CardHeader title={…} action={<AddRowButton control={adding}>{s('addFixed')}</AddRowButton>} />
//   <AddRow control={adding} onAdd={() => { if (!actions.addFixed(draft)) return false; setDraft(EMPTY); }}>
//     <Td kind="center" tone="faint">+</Td>
//     <Td kind="edit"><CellText value={draft.name} onCommit={(name) => setDraft((d) => ({ ...d, name }))} placeholder={s('newExpense')} label={s('newExpense')} /></Td>
//     <Td kind="edit"><CellNumber value={draft.amount} onCommit={(amount) => setDraft((d) => ({ ...d, amount }))} blankZero placeholder="0.00" label={t('amount')} /></Td>
//     <Td kind="add" colSpan={3}><AddButton /></Td>
//   </AddRow>
//
// Diálogos y formularios: Dialog.tsx y form.tsx (cada uno con su ejemplo).

export { AddRowButton, useAddRow } from './addRow';
export type { AddRowButtonProps } from './addRow';
export { addRowKeyAction, AddRowsOpenContext } from './addRowContext';
export type { AddRowControl } from './addRowContext';
export { AddButton, DeleteButton } from './buttons';
export type { AddButtonProps, DeleteButtonProps } from './buttons';
export { Card, CardHeader, CardNote, Stack } from './Card';
export type { CardHeaderProps, CardProps } from './Card';
export { CellCheckbox, CellDate, CellNumber, CellSelect, CellText, NumberField } from './cells';
export type {
  CellCheckboxProps,
  CellDateProps,
  CellNumberProps,
  CellSelectProps,
  CellTextProps,
  NumberFieldProps,
  SelectOption,
} from './cells';
export { cx } from './cx';
export type { Tone } from './cx';
export { Dialog, DialogButton, DialogFields, DialogText } from './Dialog';
export type { DialogButtonProps, DialogProps } from './Dialog';
export { CheckField, Field, Input, MonthPicker, Select } from './form';
export type { CheckFieldProps, FieldProps, InputProps, MonthPickerProps, SelectProps } from './form';
export { Num } from './Num';
export type { NumProps } from './Num';
export { AddRow, SheetTable, Td, Th, Tr } from './table';
export type { AddRowProps, SheetTableProps, TdKind, TdProps, ThProps, TrProps } from './table';
export type { CommitOn } from './useDraft';
