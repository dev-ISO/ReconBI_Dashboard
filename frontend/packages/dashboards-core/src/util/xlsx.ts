/**
 * Minimal ZERO-DEPENDENCY .xlsx writer (tiny-dependency-budget doctrine).
 *
 * An .xlsx file is an OPC package: a plain ZIP whose entries are XML parts.
 * This writer emits the smallest valid package —
 *   [Content_Types].xml, _rels/.rels, xl/workbook.xml,
 *   xl/_rels/workbook.xml.rels, xl/styles.xml, xl/worksheets/sheet1.xml —
 * with every entry STORED (method 0, no compression) so the zip layer needs
 * only CRC-32 + the local/central header bookkeeping. Strings are written as
 * INLINE strings (no shared-string table), finite numbers as native numeric
 * cells, booleans as boolean cells, Dates as ISO-8601 text; null/undefined
 * cells are skipped. The header row uses the one non-default style (bold).
 */

export interface XlsxSheetInput {
  /** Tab name; sanitized to Excel's rules (31 chars, no []:*?/\). Default "Data". */
  sheetName?: string;
  /** Header row, one entry per column. */
  columns: { name: string }[];
  /** Row-major cell values; rows longer than `columns` are truncated. */
  rows: unknown[][];
}

/** Hard sheet-format bounds (xlsx limit is 1,048,576 rows / 16,384 columns). */
const MAX_ROWS = 1_048_575; // data rows; +1 header row = the format limit
const MAX_COLUMNS = 16_384;

// ---------------------------------------------------------------- zip layer

/** Standard CRC-32 (IEEE 802.3), table-driven. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** Fixed DOS timestamp (2026-01-01 00:00): deterministic output, stable diffs. */
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** STORE-method zip: local headers + entries, then central directory + EOCD. */
const buildZip = (entries: ZipEntry[]): Uint8Array => {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  const u16 = (view: DataView, at: number, value: number) => view.setUint16(at, value, true);
  const u32 = (view: DataView, at: number, value: number) => view.setUint32(at, value, true);

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + name.length + entry.data.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50); // local file header signature
    u16(lv, 4, 20); // version needed
    u16(lv, 6, 0x0800); // general purpose: UTF-8 names
    u16(lv, 8, 0); // method: STORE
    u16(lv, 10, DOS_TIME);
    u16(lv, 12, DOS_DATE);
    u32(lv, 14, crc);
    u32(lv, 18, entry.data.length); // compressed size (= raw when stored)
    u32(lv, 22, entry.data.length); // uncompressed size
    u16(lv, 26, name.length);
    u16(lv, 28, 0); // extra length
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    u32(cv, 0, 0x02014b50); // central directory header signature
    u16(cv, 4, 20); // version made by
    u16(cv, 6, 20); // version needed
    u16(cv, 8, 0x0800);
    u16(cv, 10, 0); // method
    u16(cv, 12, DOS_TIME);
    u16(cv, 14, DOS_DATE);
    u32(cv, 16, crc);
    u32(cv, 20, entry.data.length);
    u32(cv, 24, entry.data.length);
    u16(cv, 28, name.length);
    // comment/disk/attributes stay 0
    u32(cv, 42, offset); // local header offset
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  u32(ev, 0, 0x06054b50); // end of central directory signature
  u16(ev, 8, entries.length);
  u16(ev, 10, entries.length);
  u32(ev, 12, centralSize);
  u32(ev, 16, offset); // central directory offset
  // comment length stays 0

  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

// ---------------------------------------------------------------- xml layer

/** Escapes text for XML content/attributes, dropping XML-invalid controls. */
const xmlEscape = (text: string): string =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 0 -> "A", 25 -> "Z", 26 -> "AA" ... (spreadsheet column letters). */
const columnLetter = (index: number): string => {
  let letters = '';
  let n = index;
  while (n >= 0) {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  }
  return letters;
};

/** Excel sheet-name rules: strip []:*?/\ and quotes at the ends, cap at 31. */
const sanitizeSheetName = (name: string | undefined): string => {
  const cleaned = (name ?? '').replace(/[[\]:*?/\\]/g, '').replace(/^'+|'+$/g, '').trim().slice(0, 31);
  return cleaned === '' ? 'Data' : cleaned;
};

/** One cell; s="1" is the bold header style. Returns '' for empty cells. */
const cellXml = (ref: string, value: unknown, style: 0 | 1): string => {
  const s = style === 1 ? ' s="1"' : '';
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${s}><v>${String(value)}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  const text =
    value instanceof Date
      ? Number.isNaN(value.getTime())
        ? ''
        : value.toISOString()
      : String(value);
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
};

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const CONTENT_TYPES =
  XML_DECL +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

const ROOT_RELS =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const WORKBOOK_RELS =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

/** Two fonts (regular / bold header) and the conventional two base fills. */
const STYLES =
  XML_DECL +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '</styleSheet>';

// ------------------------------------------------------------------- public

/** Builds a complete single-sheet .xlsx file. */
export const buildXlsx = ({ sheetName, columns, rows }: XlsxSheetInput): Uint8Array => {
  if (columns.length === 0) throw new Error('xlsx: at least one column is required.');
  if (columns.length > MAX_COLUMNS) throw new Error(`xlsx: at most ${MAX_COLUMNS} columns.`);
  if (rows.length > MAX_ROWS) throw new Error(`xlsx: at most ${MAX_ROWS} rows.`);

  const workbook =
    XML_DECL +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${xmlEscape(sanitizeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>';

  const parts: string[] = [];
  parts.push(
    XML_DECL +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
  );
  const headerCells = columns
    .map((column, i) => cellXml(`${columnLetter(i)}1`, column.name, 1))
    .join('');
  parts.push(`<row r="1">${headerCells}</row>`);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const cells: string[] = [];
    for (let c = 0; c < columns.length && c < row.length; c++) {
      const xml = cellXml(`${columnLetter(c)}${r + 2}`, row[c], 0);
      if (xml !== '') cells.push(xml);
    }
    parts.push(`<row r="${r + 2}">${cells.join('')}</row>`);
  }
  parts.push('</sheetData></worksheet>');

  const encoder = new TextEncoder();
  return buildZip([
    { name: '[Content_Types].xml', data: encoder.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: encoder.encode(ROOT_RELS) },
    { name: 'xl/workbook.xml', data: encoder.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(WORKBOOK_RELS) },
    { name: 'xl/styles.xml', data: encoder.encode(STYLES) },
    { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(parts.join('')) },
  ]);
};

/** Browser download helper; appends ".xlsx" when the name doesn't carry it. */
export const downloadXlsx = (fileName: string, input: XlsxSheetInput): void => {
  const bytes = buildXlsx(input);
  // Uint8Array<ArrayBuffer> satisfies BlobPart; the copy keeps TS happy across lib versions.
  const blob = new Blob([bytes.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName.toLowerCase().endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  anchor.click();
  URL.revokeObjectURL(url);
};
