import type { QueryColumn, CellValue } from '../types/query';
import type { AxisValueFormat, DateFormatPreset } from '../types/chart';

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const currencyFormat = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const percentFormat = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 1,
});

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
const yearFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric' });

// UTC twins for values parsed as calendar parts (see parseDateValue): the
// parts live at UTC midnight, so rendering them with local-zone formatters
// would shift the date a whole day west of UTC.
const dateFormatUtc = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
const monthFormatUtc = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const yearFormatUtc = new Intl.DateTimeFormat(undefined, { year: 'numeric', timeZone: 'UTC' });

/**
 * ISO date-only ("2026-08-04") and NAIVE timestamps ("2026-08-04T13:00:00",
 * no zone suffix) denote CALENDAR PARTS, not instants — `new Date(iso)` parses
 * the first as UTC midnight and the second in the local zone, so mixing either
 * with the other zone's getters shifts the value (bug findings 2/3).
 */
const NAIVE_ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

/** A parsed date cell plus which getter family renders it faithfully. */
interface ParsedDateValue {
  date: Date;
  /** True = calendar-parts value stored at UTC midnight; render with getUTC*. */
  utc: boolean;
}

/**
 * Parses a date-ish string. Date-only / naive-timestamp shapes become their
 * literal calendar parts (held at UTC, rendered via UTC getters); anything
 * else (zoned timestamps, epoch-ish strings) keeps `new Date` instant
 * semantics with local rendering. Null when unparseable.
 */
const parseDateValue = (value: string): ParsedDateValue | null => {
  const match = NAIVE_ISO.exec(value.trim());
  if (match) {
    const date = new Date(
      Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4] ?? '0'),
        Number(match[5] ?? '0'),
        Number(match[6] ?? '0'),
      ),
    );
    // Date.UTC maps years 0-99 to 1900+y — force the literal year.
    date.setUTCFullYear(Number(match[1]));
    return Number.isNaN(date.getTime()) ? null : { date, utc: true };
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : { date: parsed, utc: false };
};

// ---------------------------------------------------------------------------
// Excel-style format patterns (AxisValueFormat kind 'custom', pattern-shaped
// ChartFormat.valueFormat strings, ChartFormat.dateFormatPattern). Pure and
// defensive: a malformed pattern falls back to the default formatting instead
// of throwing — a bad string typed into the format panel must never take a
// chart down.
// ---------------------------------------------------------------------------

/** One piece of a parsed number section: literal text, the digit mask, or %. */
type NumberToken = { t: 'lit'; text: string } | { t: 'num' } | { t: 'pct' };

interface NumberSection {
  /** Render order: literals / the formatted number / '%' in pattern position. */
  tokens: NumberToken[];
  /** '%' present anywhere: value is multiplied by 100 (Excel semantics). */
  percent: boolean;
  /** 1000^trailingCommas — `0.0,,` renders millions. */
  scale: number;
  /** ',' inside the integer mask enables thousands grouping. */
  grouping: boolean;
  /** '0' count in the integer mask (zero-padded minimum). */
  minInt: number;
  /** '0' count in the decimal mask (always-shown decimals). */
  minFrac: number;
  /** Total placeholders in the decimal mask ('#' = optional digits). */
  maxFrac: number;
  /** False when the section is literals only (e.g. a "-" zero section). */
  hasNumber: boolean;
}

/** Splits `pos;neg;zero` on ';' — separators inside "quoted" literals don't count. */
const splitPatternSections = (pattern: string): string[] => {
  const sections: string[] = [];
  let current = '';
  let inQuote = false;
  for (const ch of pattern) {
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
      continue;
    }
    if (ch === ';' && !inQuote) {
      sections.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  sections.push(current);
  return sections;
};

/**
 * Parses one section into tokens + digit-mask facts. Only the FIRST contiguous
 * run of `#0.,` is the number; every other character (currency signs, parens,
 * spaces, stray digits after the mask) passes through as a literal. Null =
 * unparseable (unbalanced quote) — the caller falls back to default formatting.
 */
const parseNumberSection = (section: string): NumberSection | null => {
  const tokens: NumberToken[] = [];
  let percent = false;
  let mask = '';
  let sawNumber = false;
  let i = 0;
  while (i < section.length) {
    const ch = section[i]!;
    if (ch === '"') {
      const close = section.indexOf('"', i + 1);
      if (close === -1) return null;
      tokens.push({ t: 'lit', text: section.slice(i + 1, close) });
      i = close + 1;
      continue;
    }
    if (!sawNumber && (ch === '#' || ch === '0' || ch === ',' || ch === '.')) {
      let j = i;
      while (j < section.length && /[#0.,]/.test(section[j]!)) j++;
      mask = section.slice(i, j);
      tokens.push({ t: 'num' });
      sawNumber = true;
      i = j;
      continue;
    }
    if (ch === '%') {
      percent = true;
      tokens.push({ t: 'pct' });
      i++;
      continue;
    }
    tokens.push({ t: 'lit', text: ch });
    i++;
  }
  // Trailing commas AFTER the digits scale by a thousand each (0.0,, -> millions).
  let scale = 1;
  while (mask.endsWith(',')) {
    scale *= 1000;
    mask = mask.slice(0, -1);
  }
  const dot = mask.indexOf('.');
  const intMaskRaw = dot === -1 ? mask : mask.slice(0, dot);
  const fracMask = dot === -1 ? '' : mask.slice(dot + 1).replace(/[^#0]/g, '');
  const grouping = intMaskRaw.includes(',');
  const intMask = intMaskRaw.replace(/,/g, '');
  return {
    tokens,
    percent,
    scale,
    grouping,
    minInt: (intMask.match(/0/g) ?? []).length,
    minFrac: (fracMask.match(/0/g) ?? []).length,
    maxFrac: fracMask.length,
    hasNumber: sawNumber,
  };
};

/**
 * Renders one section. `absolute` strips the sign — the negative section
 * carries its own sign handling (parens, a leading "-" literal, a color name…),
 * so the digits must come out unsigned.
 */
const renderNumberSection = (value: number, section: NumberSection, absolute: boolean): string => {
  let v = absolute ? Math.abs(value) : value;
  if (section.percent) v *= 100;
  v /= section.scale;
  const digits = section.hasNumber
    ? new Intl.NumberFormat(undefined, {
        useGrouping: section.grouping,
        // Intl bounds: minimumIntegerDigits 1..21, fraction digits 0..20.
        minimumIntegerDigits: Math.min(Math.max(section.minInt, 1), 21),
        minimumFractionDigits: Math.min(section.minFrac, 20),
        maximumFractionDigits: Math.min(Math.max(section.maxFrac, section.minFrac), 20),
      }).format(v)
    : '';
  return section.tokens
    .map((token) => (token.t === 'lit' ? token.text : token.t === 'pct' ? '%' : digits))
    .join('');
};

/**
 * Excel-style number formatting: `pos;neg;zero` sections (missing sections
 * fall back to the positive one; a present negative section supplies its own
 * sign treatment), `0`/`#` digit placeholders, ',' grouping, decimals, '%'
 * multiplies by 100, `"quoted"` literals, loose literal chars ($ € etc.) pass
 * through, trailing commas scale by 1000 each. Never throws — a bad pattern or
 * non-finite value falls back to the default number format.
 */
export const formatNumberPattern = (value: number, pattern: string): string => {
  try {
    if (typeof value !== 'number' || !Number.isFinite(value) || pattern.trim() === '') {
      return numberFormat.format(value);
    }
    const sections = splitPatternSections(pattern).map(parseNumberSection);
    if (sections.length === 0 || sections.some((s) => s === null)) {
      return numberFormat.format(value);
    }
    const [positive, negative, zero] = sections as NumberSection[];
    // A default section with no digit placeholder would swallow the value
    // entirely ("garbage" -> "garbage") — treat it as a bad pattern. The
    // NEGATIVE/ZERO sections may stay literal-only (the Excel "-" idiom).
    if (!positive!.hasNumber) return numberFormat.format(value);
    if (value === 0 && zero) return renderNumberSection(value, zero, false);
    if (value < 0 && negative) return renderNumberSection(value, negative, true);
    // No negative section: the default minus sign from Intl carries the sign.
    return renderNumberSection(value, positive!, false);
  } catch {
    return numberFormat.format(value);
  }
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Getter/formatter family the mask renderers read through (local vs UTC). */
interface DateReaders {
  year(d: Date): number;
  month(d: Date): number; // 0-based, Date getter semantics
  day(d: Date): number;
  hours(d: Date): number;
  minutes(d: Date): number;
  monthLong: Intl.DateTimeFormat;
  monthShort: Intl.DateTimeFormat;
  weekdayLong: Intl.DateTimeFormat;
  weekdayShort: Intl.DateTimeFormat;
}

const LOCAL_READERS: DateReaders = {
  year: (d) => d.getFullYear(),
  month: (d) => d.getMonth(),
  day: (d) => d.getDate(),
  hours: (d) => d.getHours(),
  minutes: (d) => d.getMinutes(),
  monthLong: new Intl.DateTimeFormat(undefined, { month: 'long' }),
  monthShort: new Intl.DateTimeFormat(undefined, { month: 'short' }),
  weekdayLong: new Intl.DateTimeFormat(undefined, { weekday: 'long' }),
  weekdayShort: new Intl.DateTimeFormat(undefined, { weekday: 'short' }),
};

const UTC_READERS: DateReaders = {
  year: (d) => d.getUTCFullYear(),
  month: (d) => d.getUTCMonth(),
  day: (d) => d.getUTCDate(),
  hours: (d) => d.getUTCHours(),
  minutes: (d) => d.getUTCMinutes(),
  monthLong: new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' }),
  monthShort: new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }),
  weekdayLong: new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' }),
  weekdayShort: new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }),
};

/**
 * Date-mask tokens, LONGEST FIRST so the tokenizer never mis-splits (yyyy
 * before yy, MMMM before MMM before MM before M, EEEE before EEE, dd before d).
 * Case matters: MM = month, mm = minutes. Qq yields the quarter number (1-4).
 */
const DATE_MASK_TOKENS: readonly [token: string, render: (d: Date, r: DateReaders) => string][] = [
  ['yyyy', (d, r) => String(r.year(d))],
  ['MMMM', (d, r) => r.monthLong.format(d)],
  ['EEEE', (d, r) => r.weekdayLong.format(d)],
  ['MMM', (d, r) => r.monthShort.format(d)],
  ['EEE', (d, r) => r.weekdayShort.format(d)],
  ['yy', (d, r) => pad2(r.year(d) % 100)],
  ['MM', (d, r) => pad2(r.month(d) + 1)],
  ['dd', (d, r) => pad2(r.day(d))],
  ['HH', (d, r) => pad2(r.hours(d))],
  ['mm', (d, r) => pad2(r.minutes(d))],
  ['Qq', (d, r) => String(Math.floor(r.month(d) / 3) + 1)],
  ['M', (d, r) => String(r.month(d) + 1)],
  ['d', (d, r) => String(r.day(d))],
];

/**
 * Formats a date by mask: yyyy yy MMMM MMM MM M dd d EEEE EEE Qq (quarter
 * number) HH mm; "double" or 'single' quoted runs are literals; any other
 * character passes through unchanged (so `dd/MM/yyyy` or `"Q"Qq yyyy` just
 * work). Invalid dates render '' and nothing ever throws.
 *
 * `utc: true` renders through the getUTC* getter family — for dates that hold
 * calendar parts at UTC midnight (naive engine values, UTC-gridded axes like
 * the Gantt time axis) rather than local instants.
 */
export const formatDatePattern = (
  date: Date,
  mask: string,
  opts?: { utc?: boolean },
): string => {
  const readers = opts?.utc ? UTC_READERS : LOCAL_READERS;
  try {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    let out = '';
    let i = 0;
    outer: while (i < mask.length) {
      const ch = mask[i]!;
      if (ch === '"' || ch === "'") {
        const close = mask.indexOf(ch, i + 1);
        if (close === -1) {
          // Unterminated quote: take the rest as literal instead of failing.
          out += mask.slice(i + 1);
          break;
        }
        out += mask.slice(i + 1, close);
        i = close + 1;
        continue;
      }
      for (const [token, render] of DATE_MASK_TOKENS) {
        if (mask.startsWith(token, i)) {
          out += render(date, readers);
          i += token.length;
          continue outer;
        }
      }
      out += ch;
      i++;
    }
    return out;
  } catch {
    return (opts?.utc ? dateFormatUtc : dateFormat).format(date);
  }
};

/**
 * Is the string a full Excel-style number pattern (digit placeholders or
 * sections) rather than a legacy loose hint ("$", "%", "currency", "percent")?
 * Any '#', '0' or ';' routes through formatNumberPattern; bare hints keep the
 * legacy sniff so existing models render byte-identically.
 */
const isNumberPattern = (s: string): boolean => /[#0;]/.test(s);

/**
 * Human label for one cell, driven by the column's type/bucket/format
 * metadata. Precedence for numbers: formatString (Excel pattern from the
 * model measure) > pattern-shaped formatHint > legacy $/% hint sniff >
 * default thousands format.
 */
export const formatCellValue = (value: CellValue, column: QueryColumn): string => {
  if (value === null) return '(Blank)';

  if (typeof value === 'number') {
    const pattern = column.formatString ?? '';
    if (pattern && isNumberPattern(pattern)) return formatNumberPattern(value, pattern);
    const hint = pattern || (column.formatHint ?? '');
    if (isNumberPattern(hint)) return formatNumberPattern(value, hint);
    if (hint.includes('$') || hint === 'currency') return currencyFormat.format(value);
    if (hint.includes('%') || hint === 'percent') return percentFormat.format(value);
    return numberFormat.format(value);
  }

  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  if ((column.type === 'date' || column.type === 'timestamp') && typeof value === 'string') {
    // Calendar-parts values (date-only / naive) format from their parts via
    // the UTC twins; only genuinely zoned instants render in the local zone.
    const parsed = parseDateValue(value);
    if (parsed !== null) {
      const { date, utc } = parsed;
      const readers = utc ? UTC_READERS : LOCAL_READERS;
      switch (column.dateBucket) {
        case 'year':
          return (utc ? yearFormatUtc : yearFormat).format(date);
        case 'quarter':
          return `Q${Math.floor(readers.month(date) / 3) + 1} ${readers.year(date)}`;
        case 'month':
          return (utc ? monthFormatUtc : monthFormat).format(date);
        default:
          return (utc ? dateFormatUtc : dateFormat).format(date);
      }
    }
  }

  return String(value);
};

/** Numeric axis tick formatting per AxisValueFormat. */
export const formatAxisValue = (value: number, format?: AxisValueFormat): string => {
  const decimals = format?.decimals;
  switch (format?.kind ?? 'auto') {
    case 'custom':
      // No pattern yet (user just switched the kind): default formatting.
      return format?.pattern ? formatNumberPattern(value, format.pattern) : numberFormat.format(value);
    case 'currency':
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: decimals ?? 0,
      }).format(value);
    case 'percent':
      return new Intl.NumberFormat(undefined, {
        style: 'percent',
        maximumFractionDigits: decimals ?? 1,
      }).format(value);
    case 'compact':
      return new Intl.NumberFormat(undefined, {
        notation: 'compact',
        maximumFractionDigits: decimals ?? 1,
      }).format(value);
    case 'number':
      return new Intl.NumberFormat(undefined, {
        maximumFractionDigits: decimals ?? 0,
        minimumFractionDigits: decimals !== undefined ? decimals : undefined,
      }).format(value);
    default:
      return numberFormat.format(value);
  }
};

/**
 * Date axis label per preset; falls back to the bucket-aware default. A custom
 * `mask` (ChartFormat.dateFormatPattern -> formatDatePattern) wins over the
 * preset when the value parses as a date. Optional LAST param so every
 * existing caller keeps compiling unchanged.
 */
export const formatDateLabel = (
  value: CellValue,
  column: QueryColumn,
  preset?: DateFormatPreset,
  mask?: string | null,
): string => {
  if (value === null) return '(Blank)';
  const parsed = typeof value === 'string' ? parseDateValue(value) : null;
  if (parsed && mask) {
    const custom = formatDatePattern(parsed.date, mask, { utc: parsed.utc });
    if (custom !== '') return custom;
  }
  if (!parsed || !preset || preset === 'auto') {
    return formatCellValue(value, column);
  }
  // Calendar-parts values (date-only / naive) render from their parts — the
  // UTC reader family; zoned instants keep local rendering.
  const { date, utc } = parsed;
  const readers = utc ? UTC_READERS : LOCAL_READERS;
  switch (preset) {
    case 'monthShort':
      return readers.monthShort.format(date);
    case 'monthLong':
      return readers.monthLong.format(date);
    case 'monthNum':
      return String(readers.month(date) + 1);
    case 'monthYear':
      return (utc ? monthFormatUtc : monthFormat).format(date);
    case 'dayShort':
      return readers.weekdayShort.format(date);
    case 'dayLong':
      return readers.weekdayLong.format(date);
    case 'dayOfMonth':
      return String(readers.day(date));
    case 'quarter':
      return `Q${Math.floor(readers.month(date) / 3) + 1} ${readers.year(date)}`;
    case 'year':
      return String(readers.year(date));
    case 'isoDate':
      // From parts — never a local-zone round-trip through toISOString.
      return `${String(readers.year(date)).padStart(4, '0')}-${pad2(readers.month(date) + 1)}-${pad2(readers.day(date))}`;
    default:
      return formatCellValue(value, column);
  }
};
