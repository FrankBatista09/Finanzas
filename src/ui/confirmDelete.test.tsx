import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { confirmDeleteStep } from './confirmDelete';
import type { ConfirmState } from './confirmDelete';
import { DeleteButton } from './buttons';

describe('confirmDeleteStep: ask before deleting', () => {
  it('request opens the question without confirming anything', () => {
    const r = confirmDeleteStep(null, { type: 'request', name: 'Netflix · 1,137.00 DOP' });
    expect(r).toEqual({ state: { name: 'Netflix · 1,137.00 DOP' }, confirmed: false });
  });

  it('cancel closes the question and never confirms', () => {
    const open: ConfirmState = { name: 'Netflix' };
    expect(confirmDeleteStep(open, { type: 'cancel' })).toEqual({ state: null, confirmed: false });
  });

  it('confirm on an open question confirms once; a second confirm does nothing', () => {
    const first = confirmDeleteStep({ name: 'Netflix' }, { type: 'confirm' });
    expect(first).toEqual({ state: null, confirmed: true });
    expect(confirmDeleteStep(first.state, { type: 'confirm' }).confirmed).toBe(false);
  });
});

describe('DeleteButton', () => {
  it('starts closed: renders only the × and no dialog', () => {
    const html = renderToStaticMarkup(<DeleteButton kind="kindExpense" item="Netflix" onConfirm={() => {}} label="Delete Netflix" />);
    expect(html).toContain('aria-label="Delete Netflix"');
    expect(html).not.toContain('role="dialog"');
  });
});
