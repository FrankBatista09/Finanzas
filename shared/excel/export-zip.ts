// Uncompressed zip ("stored" method), the minimum an .xlsx needs.
// Port of `zip()` in design_handoff/referencia/excel-export.js. It writes no dates or attributes:
// the same files always give the same bytes.

const CONTENT_TYPES = '[Content_Types].xml';
const ROOT_RELS = '_rels/.rels';

/** CRC-32 table (reflected polynomial 0xEDB88320). */
function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(table: Uint32Array, bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Packs `files` (path → text content, encoded as UTF-8) into a zip.
 * Entries go in insertion order, except [Content_Types].xml and _rels/.rels, which go first.
 */
export function zipStored(files: ReadonlyMap<string, string>): Uint8Array<ArrayBuffer> {
  const table = crcTable();
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = 0;
  const order = [
    CONTENT_TYPES,
    ROOT_RELS,
    ...[...files.keys()].filter((k) => k !== CONTENT_TYPES && k !== ROOT_RELS),
  ];

  for (const name of order) {
    const data = enc.encode(files.get(name) ?? '');
    const nb = enc.encode(name);
    const c = crc32(table, data);

    // Local header. The fields that are not written (compression, time, date, extra) stay at 0.
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true); // version needed to extract: 2.0
    h.setUint16(6, 0x0800, true); // bit 11: names in UTF-8
    h.setUint32(14, c, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(h.buffer), nb, data);

    // Central directory entry.
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, c, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nb.length, true);
    cd.setUint32(42, off, true);
    central.push(new Uint8Array(cd.buffer), nb);

    off += 30 + nb.length + data.length;
  }

  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, order.length, true);
  end.setUint16(10, order.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, off, true);

  // The original returned a Blob with these parts; here they are concatenated so as not to depend on it.
  const out = new Uint8Array(off + cdSize + 22);
  let pos = 0;
  for (const chunk of [...parts, ...central, new Uint8Array(end.buffer)]) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}
