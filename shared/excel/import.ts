import type { ImportPayload } from '../api';

/** El archivo no es un .xlsx legible o no tiene el formato de la app (p. ej. sin hojas de mes). */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

/**
 * Lee un .xlsx con el formato de la app y localiza las tablas por sus encabezados
 * ("Concepto", "Fecha"+"Vía", "Fecha"+"Descripción"). Equivale a `importExcel()` del prototipo.
 */
export function parseFinanzasXlsx(_bytes: Uint8Array): ImportPayload {
  throw new ImportError('parseFinanzasXlsx: pendiente de implementar');
}
