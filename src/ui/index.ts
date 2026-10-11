// UI primitives shared by the summary panel and the two screens.
// None has text of its own except the common strings ("Add", "Delete", "Actions"), shown in the current language;
// labels (label, placeholder) are passed in already translated: `t` comes from useI18n() and `s` from useStrings().
//
// Editable row (each cell reports through onCommit; the data layer groups and delays the save):
//
//   <Tr unpaid={!f.paid}>
//     <Td kind="center"><CellCheckbox checked={f.paid} onCommit={(paid) => actions.patchFixed(f.id, { paid })} disabled={readOnly} label={s('paidNamed', { name: f.name })} /></Td>
//     <Td kind="edit"><CellText value={f.name} onCommit={(name) => actions.patchFixed(f.id, { name })} readOnly={readOnly} minWidth={120} label={s('item')} /></Td>
//     <Td kind="edit"><CellNumber value={f.amount} onCommit={(amount) => actions.patchFixed(f.id, { amount })} readOnly={readOnly} label={t('amount')} /></Td>
//     <Td kind="edit"><CellSelect value={f.cur} options={CURRENCIES} onCommit={(cur) => actions.patchFixed(f.id, { cur })} disabled={readOnly} mono label={t('currency')} /></Td>
//     <Td kind="num" nowrap>{f2(dop)}</Td>
//     <Td kind="action">{!readOnly && <DeleteButton kind="kindExpense" item={`${f.name} · ${f2(f.amount)} ${f.cur}`} onConfirm={() => actions.removeFixed(f.id)} label={t('deleteNamed', { name: f.name })} />}</Td>
//   </Tr>
//
// Add row (the draft lives in the screen's state; 0 = empty amount; Enter or the button call onAdd).
// It is not in view: the header's "+ Add …" (addRow.tsx) opens it, and Esc or that same button closes it.
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
// Dialogs and forms: Dialog.tsx and form.tsx (each with its own example).

export { AddRowButton, useAddRow } from './addRow';
export type { AddRowButtonProps } from './addRow';
export { addRowKeyAction, AddRowsOpenContext } from './addRowContext';
export type { AddRowControl } from './addRowContext';
export { AddButton, DeleteButton, ExpandButton } from './buttons';
export type { AddButtonProps, DeleteButtonProps } from './buttons';
export { ConfirmDeleteDialog, useConfirmDelete } from './confirmDelete';
export type { DeleteKind } from './confirmDelete';
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
export { ExpandableCard } from './ExpandableCard';
export type { ExpandableCardProps } from './ExpandableCard';
export { useExpanded } from './expandContext';
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
