import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveQueue } from './saveQueue';

type Patch = Record<string, unknown>;

function setup(delay = 400) {
  const sent: [key: string, patch: Patch][] = [];
  const queue = new SaveQueue<Patch>({
    delay,
    merge: (a, b) => ({ ...a, ...b }),
    send: (key, patch) => sent.push([key, patch]),
  });
  return { queue, sent };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SaveQueue · delay', () => {
  it('waits for the delay before sending', () => {
    const { queue, sent } = setup();
    queue.push('tx:1', ['desc'], { desc: 'U' });
    vi.advanceTimersByTime(399);
    expect(sent).toEqual([]);
    expect(queue.size).toBe(1);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([['tx:1', { desc: 'U' }]]);
    expect(queue.size).toBe(0);
  });

  it('each keystroke in the same field restarts the wait and only the last value goes out', () => {
    const { queue, sent } = setup();
    for (const desc of ['U', 'Ub', 'Ube', 'Uber']) {
      queue.push('tx:1', ['desc'], { desc });
      vi.advanceTimersByTime(300);
    }
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([['tx:1', { desc: 'Uber' }]]);
  });

  it('the delay is per field: typing in another field does not postpone the first one', () => {
    const { queue, sent } = setup();
    queue.push('tx:1', ['desc'], { desc: 'Uber' });
    vi.advanceTimersByTime(300);
    queue.push('tx:1', ['amount'], { amount: 850 });
    vi.advanceTimersByTime(100);
    // "desc" expires (400 ms): the whole row goes out, "amount" included, in a single send.
    expect(sent).toEqual([['tx:1', { desc: 'Uber', amount: 850 }]]);
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
  });

  it('different rows are sent separately', () => {
    const { queue, sent } = setup();
    queue.push('tx:1', ['desc'], { desc: 'A' });
    vi.advanceTimersByTime(200);
    queue.push('tx:2', ['desc'], { desc: 'B' });
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([['tx:1', { desc: 'A' }]]);
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([
      ['tx:1', { desc: 'A' }],
      ['tx:2', { desc: 'B' }],
    ]);
  });

  it('what is edited after a send starts a new wait', () => {
    const { queue, sent } = setup();
    queue.push('tx:1', ['desc'], { desc: 'A' });
    vi.advanceTimersByTime(400);
    queue.push('tx:1', ['notes'], { notes: 'n' });
    vi.advanceTimersByTime(400);
    expect(sent).toEqual([
      ['tx:1', { desc: 'A' }],
      ['tx:1', { notes: 'n' }],
    ]);
  });
});

describe('SaveQueue · flush, immediate and drop', () => {
  it('flush() sends everything pending right away, once per row, and cancels the timers', () => {
    const { queue, sent } = setup();
    queue.push('tx:1', ['desc'], { desc: 'A' });
    queue.push('fixed:9', ['amount'], { amount: 5 });
    queue.push('tx:1', ['amount'], { amount: 2 });
    queue.flush();
    expect(sent).toEqual([
      ['tx:1', { desc: 'A', amount: 2 }],
      ['fixed:9', { amount: 5 }],
    ]);
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flush(key) sends only that row', () => {
    const { queue, sent } = setup();
    queue.push('tx:1', ['desc'], { desc: 'A' });
    queue.push('tx:2', ['desc'], { desc: 'B' });
    queue.flush('tx:2');
    expect(sent).toEqual([['tx:2', { desc: 'B' }]]);
    expect(queue.pending()).toEqual([{ desc: 'A' }]);
  });

  it('immediate goes out at once and takes along whatever the row had pending', () => {
    const { queue, sent } = setup();
    queue.push('fixed:1', ['amount'], { amount: 100 });
    queue.push('fixed:1', ['paid'], { paid: true }, true);
    expect(sent).toEqual([['fixed:1', { amount: 100, paid: true }]]);
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
  });

  it('immediate with nothing pending sends only its own payload', () => {
    const { queue, sent } = setup();
    queue.push('fixed:1', ['paid'], { paid: true }, true);
    expect(sent).toEqual([['fixed:1', { paid: true }]]);
    expect(queue.size).toBe(0);
  });

  it('drop() discards what is pending without sending it', () => {
    const { queue, sent } = setup();
    queue.push('tx:1', ['desc'], { desc: 'A' });
    expect(queue.drop('tx:1')).toBe(true);
    expect(queue.drop('tx:1')).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pending() shows what is waiting without sending it', () => {
    const { queue, sent } = setup();
    queue.push('tx:1', ['desc'], { desc: 'A' });
    queue.push('tx:1', ['desc'], { desc: 'AB' });
    expect(queue.pending()).toEqual([{ desc: 'AB' }]);
    expect(sent).toEqual([]);
  });
});
