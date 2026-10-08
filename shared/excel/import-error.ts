/**
 * Por qué no se pudo importar el archivo. Es estable: la web puede traducir el error por este código en vez
 * de mostrar `message`, que siempre va en inglés (como los mensajes de la API).
 *   not_xlsx        → no es un .xlsx (ni siquiera un zip, o un zip que no es un libro de Excel)
 *   old_format      → .xls antiguo o .xlsx protegido con contraseña
 *   too_large       → el contenido descomprimido pasa del tope
 *   damaged         → al libro le falta la parte de una hoja
 *   no_month_sheets → es un libro, pero no tiene el formato de la app (ninguna hoja de mes)
 *   unreadable      → cualquier otro fallo al leerlo
 */
export type ImportErrorCode = 'not_xlsx' | 'old_format' | 'too_large' | 'damaged' | 'no_month_sheets' | 'unreadable';

export interface ImportErrorOptions extends ErrorOptions {
  /** Por defecto, 'unreadable'. */
  code?: ImportErrorCode;
}

/** El archivo no es un .xlsx legible o no tiene el formato de la app (p. ej. sin hojas de mes). */
export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(message: string, options?: ImportErrorOptions) {
    super(message, options);
    this.name = 'ImportError';
    this.code = options?.code ?? 'unreadable';
  }
}
