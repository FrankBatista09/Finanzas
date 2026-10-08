// Solo para pruebas: ejecuta el exportador original del prototipo (design_handoff/referencia/excel-export.js)
// para comparar su salida con el port de shared/excel/export.ts.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { ExportData } from '../shared/excel/types';

const SRC = new URL('../design_handoff/referencia/excel-export.js', import.meta.url);

export interface ReferenceOptions {
  /** Fija "hoy" dentro del script (solo afecta a la plantilla vacía, que usa `new Date()`). */
  now?: Date;
}

/** Bytes del .xlsx que genera el exportador de referencia para `data`. */
export async function buildWithReference(data: ExportData, opts: ReferenceOptions = {}): Promise<Uint8Array> {
  const window: { buildFinanzasXlsx?: (d: unknown) => Blob } = {};
  const now = opts.now;
  // Date del contexto: igual que la nativa, pero `new Date()` sin argumentos devuelve `now` si se indicó.
  const FakeDate = now
    ? (new Proxy(Date, {
        construct: (target, args: unknown[]) =>
          args.length ? Reflect.construct(target, args) : new Date(now.getTime()),
      }) as DateConstructor)
    : Date;
  const ctx = vm.createContext({ window, Blob, TextEncoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, Date: FakeDate });
  vm.runInContext(readFileSync(SRC, 'utf8'), ctx, { filename: 'excel-export.js' });
  // Se clona para que el script no pueda mutar los datos de la prueba.
  const blob = window.buildFinanzasXlsx!(structuredClone(data));
  return new Uint8Array(await blob.arrayBuffer());
}
