// Lector mínimo de XML para las partes de un .xlsx. No es un parser general: recorre las etiquetas de
// izquierda a derecha, sin árbol ni validación, que es todo lo que piden workbook.xml, las relaciones,
// sharedStrings.xml y las hojas. Cada carácter se visita una sola vez (búsquedas con indexOf, sin regex
// con retroceso), así que el coste es lineal aunque la hoja tenga miles de filas.

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const ENTITY_RE = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g;
const X_ESCAPE_RE = /_x([0-9a-fA-F]{4})_/g;

/** Entidades predefinidas de XML y referencias numéricas (&#233; / &#xE9;). Lo que no reconoce queda igual. */
export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(ENTITY_RE, (whole, body: string) => {
    if (body.charCodeAt(0) !== 35 /* # */) return NAMED[body]!;
    const code = body.charCodeAt(1) === 120 /* x */ ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Escapes de OOXML para caracteres que XML no admite en texto: `_x000D_` es un retorno de carro.
 * Un guion bajo literal delante de algo con esa forma se escribe `_x005F_`, y como el reemplazo
 * avanza de izquierda a derecha, `_x005F_x000D_` da el texto "_x000D_" sin volver a decodificarlo.
 */
export function decodeOoxmlEscapes(s: string): string {
  if (s.indexOf('_x') < 0) return s;
  return s.replace(X_ESCAPE_RE, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Posición siguiente al terminador, o el final del documento si no aparece (XML truncado). */
function after(xml: string, terminator: string, from: number): number {
  const i = xml.indexOf(terminator, from);
  return i < 0 ? xml.length : i + terminator.length;
}

export type TagKind = 'open' | 'close' | 'empty';

export type XmlAttrs = Record<string, string | undefined>;

export class XmlScanner {
  /** Nombre local de la última etiqueta leída (sin prefijo de espacio de nombres: `x:row` → `row`). */
  name = '';
  /** 'empty' es una etiqueta que se cierra sola (`<c/>`). */
  kind: TagKind = 'open';

  private readonly xml: string;
  private pos = 0;
  private attrStart = 0;
  private attrEnd = 0;

  constructor(xml: string) {
    this.xml = xml;
  }

  /** Avanza a la siguiente etiqueta, saltando texto, comentarios, CDATA e instrucciones. false al terminar. */
  next(): boolean {
    const xml = this.xml;
    const n = xml.length;
    let i = this.pos;
    for (;;) {
      i = xml.indexOf('<', i);
      if (i < 0) {
        this.pos = n;
        return false;
      }
      const c = xml.charCodeAt(i + 1);
      if (c === 33 /* ! */) {
        if (xml.startsWith('<!--', i)) i = after(xml, '-->', i + 4);
        else if (xml.startsWith('<![CDATA[', i)) i = after(xml, ']]>', i + 9);
        else i = after(xml, '>', i + 2);
      } else if (c === 63 /* ? */) {
        i = after(xml, '?>', i + 2);
      } else {
        break;
      }
    }

    const close = xml.charCodeAt(i + 1) === 47; /* / */
    let j = close ? i + 2 : i + 1;
    const nameStart = j;
    for (; j < n; j++) {
      const ch = xml.charCodeAt(j);
      if (ch === 62 /* > */ || ch === 47 /* / */ || ch <= 32) break;
    }
    const qname = xml.slice(nameStart, j);
    const colon = qname.indexOf(':');
    this.name = colon < 0 ? qname : qname.slice(colon + 1);

    // El '>' que cierra la etiqueta es el primero fuera de comillas: un valor de atributo puede traer '>'.
    this.attrStart = j;
    for (; j < n; j++) {
      const ch = xml.charCodeAt(j);
      if (ch === 62) break;
      if (ch === 34 /* " */ || ch === 39 /* ' */) {
        const q = xml.indexOf(ch === 34 ? '"' : "'", j + 1);
        if (q < 0) {
          j = n;
          break;
        }
        j = q;
      }
    }
    const selfClosing = !close && j > this.attrStart && xml.charCodeAt(j - 1) === 47;
    this.attrEnd = selfClosing ? j - 1 : j;
    this.kind = close ? 'close' : selfClosing ? 'empty' : 'open';
    this.pos = j < n ? j + 1 : n;
    return true;
  }

  /** Atributos de la última etiqueta. Las claves conservan su prefijo ('r:id'); los valores van decodificados. */
  attrs(): XmlAttrs {
    const xml = this.xml;
    const end = this.attrEnd;
    const out: XmlAttrs = Object.create(null) as XmlAttrs;
    let i = this.attrStart;
    while (i < end) {
      while (i < end && xml.charCodeAt(i) <= 32) i++;
      const nameStart = i;
      while (i < end) {
        const ch = xml.charCodeAt(i);
        if (ch === 61 /* = */ || ch <= 32) break;
        i++;
      }
      const name = xml.slice(nameStart, i);
      while (i < end && xml.charCodeAt(i) <= 32) i++;
      if (i >= end || xml.charCodeAt(i) !== 61) continue;
      i++;
      while (i < end && xml.charCodeAt(i) <= 32) i++;
      const quote = xml.charCodeAt(i);
      if (quote !== 34 && quote !== 39) {
        // Valor sin comillas: no es XML válido; se descarta ese atributo.
        while (i < end && xml.charCodeAt(i) > 32) i++;
        continue;
      }
      const q = xml.indexOf(quote === 34 ? '"' : "'", i + 1);
      if (q < 0 || q > end) break;
      out[name] = decodeEntities(xml.slice(i + 1, q));
      i = q + 1;
    }
    return out;
  }

  /**
   * Texto que sigue a la última etiqueta, hasta la próxima (que no se consume). Decodifica entidades,
   * une secciones CDATA y normaliza los saltos de línea como haría un parser de XML (\r\n → \n).
   */
  text(): string {
    const xml = this.xml;
    let out = '';
    for (;;) {
      const lt = xml.indexOf('<', this.pos);
      const stop = lt < 0 ? xml.length : lt;
      if (stop > this.pos) {
        let raw = xml.slice(this.pos, stop);
        if (raw.indexOf('\r') >= 0) raw = raw.replace(/\r\n?/g, '\n');
        out += decodeEntities(raw);
      }
      this.pos = stop;
      if (lt < 0) return out;
      if (xml.startsWith('<![CDATA[', lt)) {
        const close = xml.indexOf(']]>', lt + 9);
        out += xml.slice(lt + 9, close < 0 ? xml.length : close);
        this.pos = close < 0 ? xml.length : close + 3;
      } else if (xml.startsWith('<!--', lt)) {
        this.pos = after(xml, '-->', lt + 4);
      } else {
        return out;
      }
    }
  }
}
