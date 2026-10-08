import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

/** Cuándo avisa la celda del nuevo valor: en cada pulsación, o al salir de ella (y con Enter). */
export type CommitOn = 'change' | 'blur';

interface DraftOptions<T> {
  value: T;
  format: (value: T) => string;
  /** undefined = el texto todavía no es un valor válido: no se confirma. Recibe el input por si hay que mirar su validez. */
  parse: (text: string, input: HTMLInputElement | null) => T | undefined;
  onCommit?: (value: T) => void;
  commitOn?: CommitOn;
}

/**
 * Borrador local de una celda. Mientras tiene el foco, el input muestra lo que el usuario escribe ("12.", vacío…)
 * y no lo que hay en la caché, que solo guarda el valor ya interpretado (12, 0). Al salir vuelve a mostrar la caché.
 * Sin esto, cada actualización optimista reescribiría el input a media edición.
 */
export function useDraft<T>({ value, format, parse, onCommit, commitOn = 'change' }: DraftOptions<T>) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  /** Último valor confirmado durante esta edición, para no avisar dos veces de lo mismo ("12" y "12."). */
  const last = useRef(value);

  const commit = (text: string) => {
    const next = parse(text, ref.current);
    if (next === undefined || Object.is(next, last.current)) return;
    last.current = next;
    onCommit?.(next);
  };

  const finish = () => {
    if (draft === null) return;
    if (commitOn === 'blur') commit(draft);
    setDraft(null);
  };

  // Si la fila cambia de sitio en la tabla, el navegador le quita el foco al input sin lanzar blur.
  // El borrador no debe sobrevivir a eso: se quedaría tapando el valor real.
  useEffect(() => {
    if (draft !== null && document.activeElement !== ref.current) finish();
  });

  return {
    ref,
    value: draft ?? format(value),
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      const text = e.target.value;
      if (draft === null) last.current = value;
      setDraft(text);
      if (commitOn === 'change') commit(text);
    },
    onBlur: finish,
    /** Confirma lo escrito sin salir de la celda (Enter). */
    commitNow: () => {
      if (draft !== null) commit(draft);
    },
  };
}
