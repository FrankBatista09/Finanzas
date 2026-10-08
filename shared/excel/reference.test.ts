// Ancla de las pruebas "golden": comprueba que el exportador original del prototipo, con los datos de
// ejemplo de shared/seed.ts, reproduce byte a byte los libros de design_handoff/referencia/.
// El port (export.test.ts) se compara contra ese mismo exportador.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildWithReference } from '../../tests/reference-export';
import { seedState } from '../seed';
import { buildExportData } from './data';

const ref = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../design_handoff/referencia/${name}`, import.meta.url)));

describe('exportador de referencia (excel-export.js)', () => {
  it('datos de ejemplo → Finanzas Personales v3.xlsx', async () => {
    const out = await buildWithReference(buildExportData(seedState()));
    expect(Buffer.from(out).equals(Buffer.from(ref('Finanzas Personales v3.xlsx')))).toBe(true);
  });

  it('sin meses → Plantilla vacia.xlsx (mes actual: octubre 2026)', async () => {
    const out = await buildWithReference(
      { months: [], contribs: [], turkey: {}, defaultRate: 58.76 },
      { now: new Date(2026, 9, 7) },
    );
    expect(Buffer.from(out).equals(Buffer.from(ref('Plantilla vacia.xlsx')))).toBe(true);
  });
});
