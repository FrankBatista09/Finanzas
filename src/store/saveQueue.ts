// Save queue with a delay. Each cell edit restarts the timer of its (row, field); when any of a row's timers
// expires the whole row is sent, with everything it had pending, in a single payload.
// That way, continuing to type in one field does not postpone another field's save indefinitely, and a row never
// produces two requests at once.
//
// It knows nothing about HTTP or React: it only gathers, waits and delivers.

type Timer = ReturnType<typeof setTimeout>;

export interface SaveQueueOptions<P> {
  /** Milliseconds to wait per (row, field). */
  delay: number;
  /** Merges what a row has pending with a later edit. */
  merge: (prev: P, next: P) => P;
  /** Receives a row's payload when it is time to send it. */
  send: (key: string, payload: P) => void;
}

interface Row<P> {
  payload: P;
  timers: Map<string, Timer>;
}

export class SaveQueue<P> {
  private readonly rows = new Map<string, Row<P>>();
  private readonly opts: SaveQueueOptions<P>;

  constructor(opts: SaveQueueOptions<P>) {
    this.opts = opts;
  }

  /**
   * Queues an edit of row `key` that touches the fields `fields`.
   * With `immediate` it does not wait: it goes out at once, together with whatever the row had pending.
   */
  push(key: string, fields: readonly string[], payload: P, immediate = false): void {
    const row = this.rows.get(key);
    const merged = row ? this.opts.merge(row.payload, payload) : payload;

    if (immediate) {
      this.take(key);
      this.opts.send(key, merged);
      return;
    }

    const timers = row?.timers ?? new Map<string, Timer>();
    for (const field of fields) {
      const prev = timers.get(field);
      if (prev !== undefined) clearTimeout(prev);
      timers.set(
        field,
        setTimeout(() => this.flush(key), this.opts.delay),
      );
    }
    this.rows.set(key, { payload: merged, timers });
  }

  /** Sends right away what one row has pending, or what all of them have (in the order they started waiting). */
  flush(key?: string): void {
    const keys = key === undefined ? [...this.rows.keys()] : [key];
    for (const k of keys) {
      const row = this.take(k);
      if (row) this.opts.send(k, row.payload);
    }
  }

  /** Discards what a row has pending without sending it (the row was deleted). Returns true if there was anything. */
  drop(key: string): boolean {
    return this.take(key) !== undefined;
  }

  /** Payloads still waiting, without sending them. */
  pending(): P[] {
    return [...this.rows.values()].map((r) => r.payload);
  }

  get size(): number {
    return this.rows.size;
  }

  private take(key: string): Row<P> | undefined {
    const row = this.rows.get(key);
    if (!row) return undefined;
    for (const t of row.timers.values()) clearTimeout(t);
    this.rows.delete(key);
    return row;
  }
}
