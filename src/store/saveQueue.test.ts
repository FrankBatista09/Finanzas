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

describe('SaveQueue · retraso', () => {
  it('espera el retraso antes de enviar', () => {
    const { queue, sent } = setup();
    queue.push('tx:1', ['desc'], { desc: 'U' });
    vi.advanceTimersByTime(399);
    expect(sent).toEqual([]);
    expect(queue.size).toBe(1);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([['tx:1', { desc: 'U' }]]);
    expect(queue.size).toBe(0);
  });

  it('cada pulsación en el mismo campo reinicia la espera y solo sale el último valor', () => {
    const { queue, sent } = setup();
    for (const desc of ['U', 'Ub', 'Ube', 'Uber']) {
      queue.push('tx:1', ['desc'], { desc });
      vi.advanceTimersByTime(300);
    }
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([['tx:1', { desc: 'Uber' }]]);
  });

  it('el retraso es por campo: escribir en otro campo no aplaza el primero', () => {
    const { queue, sent } = setup();
    queue.push('tx:1', ['desc'], { desc: 'Uber' });
    vi.advanceTimersByTime(300);
    queue.push('tx:1', ['amount'], { amount: 850 });
    vi.advanceTimersByTime(100);
    // Vence "desc" (400 ms): se va la fila entera, con "amount" incluido, en un solo envío.
    expect(sent).toEqual([['tx:1', { desc: 'Uber', amount: 850 }]]);
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
  });

  it('filas distintas se envían por separado', () => {
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

  it('lo que se edita después de un envío empieza una espera nueva', () => {
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

describe('SaveQueue · flush, immediate y drop', () => {
  it('flush() envía ya todo lo pendiente, una vez por fila, y cancela los temporizadores', () => {
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

  it('flush(key) envía solo esa fila', () => {
    const { queue, sent } = setup();
    queue.push('tx:1', ['desc'], { desc: 'A' });
    queue.push('tx:2', ['desc'], { desc: 'B' });
    queue.flush('tx:2');
    expect(sent).toEqual([['tx:2', { desc: 'B' }]]);
    expect(queue.pending()).toEqual([{ desc: 'A' }]);
  });

  it('immediate sale en el acto y se lleva lo que la fila tuviera pendiente', () => {
    const { queue, sent } = setup();
    queue.push('fixed:1', ['amount'], { amount: 100 });
    queue.push('fixed:1', ['paid'], { paid: true }, true);
    expect(sent).toEqual([['fixed:1', { amount: 100, paid: true }]]);
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
  });

  it('immediate sin nada pendiente envía solo lo suyo', () => {
    const { queue, sent } = setup();
    queue.push('fixed:1', ['paid'], { paid: true }, true);
    expect(sent).toEqual([['fixed:1', { paid: true }]]);
    expect(queue.size).toBe(0);
  });

  it('drop() descarta lo pendiente sin enviarlo', () => {
    const { queue, sent } = setup();
    queue.push('tx:1', ['desc'], { desc: 'A' });
    expect(queue.drop('tx:1')).toBe(true);
    expect(queue.drop('tx:1')).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pending() enseña lo que espera sin enviarlo', () => {
    const { queue, sent } = setup();
    queue.push('tx:1', ['desc'], { desc: 'A' });
    queue.push('tx:1', ['desc'], { desc: 'AB' });
    expect(queue.pending()).toEqual([{ desc: 'AB' }]);
    expect(sent).toEqual([]);
  });
});
