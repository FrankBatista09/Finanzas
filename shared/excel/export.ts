import type { MonthKey } from '../types';
import type { ExportData } from './types';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const XLSX_FILENAME = 'Finanzas Personales.xlsx';

export interface BuildOptions {
  /** Mes de la plantilla vacía cuando `data.months` viene sin meses. Por defecto, el mes actual. */
  currentKey?: MonthKey;
}

/**
 * Genera el .xlsx (una hoja por mes + Ahorros + Config) sin dependencias: OOXML + zip sin compresión.
 * Port de design_handoff/referencia/excel-export.js.
 */
export function buildFinanzasXlsx(_data: ExportData, _opts: BuildOptions = {}): Uint8Array {
  throw new Error('buildFinanzasXlsx: pendiente de implementar');
}
