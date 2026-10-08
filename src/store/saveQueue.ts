// Cola de guardado con retraso. Cada edición de celda reinicia el temporizador de su (fila, campo); cuando vence
// cualquiera de los de una fila se envía la fila entera, con todo lo que tuviera pendiente, en un solo payload.
// Así seguir escribiendo en un campo no aplaza indefinidamente el guardado de otro, y una fila nunca
// genera dos peticiones a la vez.
//
// No sabe nada de HTTP ni de React: solo junta, espera y entrega.

type Timer = ReturnType<typeof setTimeout>;

export interface SaveQueueOptions<P> {
  /** Milisegundos de espera por (fila, campo). */
  delay: number;
  /** Funde lo pendiente de una fila con una edición posterior. */
  merge: (prev: P, next: P) => P;
  /** Recibe el payload de una fila cuando toca enviarlo. */
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
   * Encola una edición de la fila `key` que toca los campos `fields`.
   * Con `immediate` no espera: sale en el acto, junto con lo que la fila tuviera pendiente.
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

  /** Envía ya lo pendiente de una fila, o de todas (en el orden en que empezaron a esperar). */
  flush(key?: string): void {
    const keys = key === undefined ? [...this.rows.keys()] : [key];
    for (const k of keys) {
      const row = this.take(k);
      if (row) this.opts.send(k, row.payload);
    }
  }

  /** Descarta lo pendiente de una fila sin enviarlo (la fila se eliminó). Devuelve true si había algo. */
  drop(key: string): boolean {
    return this.take(key) !== undefined;
  }

  /** Payloads que siguen esperando, sin enviarlos. */
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
