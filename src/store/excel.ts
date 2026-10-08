// El Excel se genera y se lee en el navegador, como en el prototipo. El generador y el lector son las mismas
// funciones puras que usa la API (shared/excel), pero aquí no gastan el tiempo de CPU de un Worker
// (10 ms por petición en el plan gratuito: un libro con muchos meses no cabe).

import type { ImportPayload } from '../../shared/api';
import { buildExportData } from '../../shared/excel/data';
import { buildFinanzasXlsx, excelLocale, XLSX_MIME, xlsxFilename } from '../../shared/excel/export';
import { parseFinanzasXlsx } from '../../shared/excel/import';
import type { AppState, AppUser } from '../../shared/types';

/** El libro completo (una hoja por mes, ahorros y configuración) listo para descargar, en el idioma del usuario. */
export function excelBlob(state: AppState): Blob {
  return new Blob([buildFinanzasXlsx(buildExportData(state), { locale: excelLocale(state.language) })], { type: XLSX_MIME });
}

/** Nombre del archivo que descarga ese usuario. */
export function excelFilename(user: AppUser): string {
  return xlsxFilename(user.name);
}

/** Lee un .xlsx con el formato de la app. Lanza ImportError si no se puede leer. */
export async function readExcel(file: Blob): Promise<ImportPayload> {
  return parseFinanzasXlsx(new Uint8Array(await file.arrayBuffer()));
}
