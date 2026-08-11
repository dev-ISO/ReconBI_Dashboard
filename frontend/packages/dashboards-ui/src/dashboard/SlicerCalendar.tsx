import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
  stableStringify,
  type CellValue,
  type DateRangeOptions,
  type FilterClause,
} from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdSpinner } from '../primitives';

/* ============================================================== date helpers
 * Everything here is DATE-ONLY ('yyyy-MM-dd'). Dates are never round-tripped
 * through a local-timezone Date: arithmetic uses Date.UTC and formatting pins
 * timeZone:'UTC', so a day never slips either side of midnight.
 */

const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 'yyyy-MM-dd' for a UTC-based Date. */
const isoOf = (date: Date): string =>
  `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;

/** Today in the VIEWER's timezone (a calendar's "today" is a local notion). */
export function todayDateOnly(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * Normalizes a distinct-value cell to 'yyyy-MM-dd'. Strings already carrying a
 * date prefix ('2026-08-01', '2026-08-01T13:22:00Z') are sliced, never parsed
 * (parsing would shift the day in negative-offset zones); anything else falls
 * back to a UTC parse. Non-dates return null and are simply ignored.
 */
export function toDateOnly(value: CellValue): string | null {
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : isoOf(date);
  }
  const text = value.trim();
  const prefix = DATE_PREFIX.exec(text);
  if (prefix) return `${prefix[1]}-${prefix[2]}-${prefix[3]}`;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : isoOf(new Date(parsed));
}

/** 'yyyy-MM' bucket of a date-only string. */
export const monthOf = (dateOnly: string): string => dateOnly.slice(0, 7);

const monthParts = (monthKey: string): { year: number; month: number } => ({
  year: Number(monthKey.slice(0, 4)),
  month: Number(monthKey.slice(5, 7)),
});

const monthKeyOf = (year: number, month: number): string => `${year}-${pad2(month)}`;

const shiftMonth = (monthKey: string, delta: number): string => {
  const { year, month } = monthParts(monthKey);
  const zero = year * 12 + (month - 1) + delta;
  return monthKeyOf(Math.floor(zero / 12), (zero % 12) + 1);
};

const dayParts = (dateOnly: string): { year: number; month: number; day: number } => ({
  year: Number(dateOnly.slice(0, 4)),
  month: Number(dateOnly.slice(5, 7)),
  day: Number(dateOnly.slice(8, 10)),
});

const addDays = (dateOnly: string, delta: number): string => {
  const { year, month, day } = dayParts(dateOnly);
  return isoOf(new Date(Date.UTC(year, month - 1, day + delta)));
};

const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Weekday index (0 = Sunday) of the 1st of the month. */
const firstWeekday = (year: number, month: number): number =>
  new Date(Date.UTC(year, month - 1, 1)).getUTCDay();

const utcDate = (dateOnly: string): Date => {
  const { year, month, day } = dayParts(dateOnly);
  return new Date(Date.UTC(year, month - 1, day));
};

/** 'Aug 1, 2026' in the viewer's locale (UTC-pinned so the day never shifts). */
export const formatDateOnly = (dateOnly: string): string =>
  utcDate(dateOnly).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

const formatFullDate = (dateOnly: string): string =>
  utcDate(dateOnly).toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

const monthTitle = (monthKey: string): string =>
  utcDate(`${monthKey}-01`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const shortMonthNames = (): string[] =>
  Array.from({ length: 12 }, (_, index) =>
    new Date(Date.UTC(2020, index, 1)).toLocaleDateString(undefined, {
      month: 'short',
      timeZone: 'UTC',
    }),
  );

/** Sunday-first initials, localized (deduped keys come from the index). */
const weekdayInitials = (): string[] =>
  Array.from({ length: 7 }, (_, index) =>
    new Date(Date.UTC(2023, 0, 1 + index)).toLocaleDateString(undefined, {
      weekday: 'narrow',
      timeZone: 'UTC',
    }),
  );

/* =========================================================== availability */

/** Server caps distinct values (RcdLimits.MaxDistinctValues = 1000). */
const AVAILABILITY_LIMIT = 1000;

export interface DateAvailability {
  status: 'idle' | 'loading' | 'ok' | 'error';
  /** 'yyyy-MM-dd' values that actually occur in the column. */
  days: ReadonlySet<string>;
  /** 'yyyy-MM' buckets that contain at least one row. */
  months: ReadonlySet<string>;
  min: string | null;
  max: string | null;
  /**
   * The distinct query hit the server cap: absence from `days`/`months` proves
   * nothing, so the UI marks presence but never dims absence.
   */
  partial: boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();
const IDLE: DateAvailability = {
  status: 'idle',
  days: EMPTY_SET,
  months: EMPTY_SET,
  min: null,
  max: null,
  partial: false,
};
const LOADING: DateAvailability = { ...IDLE, status: 'loading' };
const FAILED: DateAvailability = { ...IDLE, status: 'error' };

/** Per-column memo of the BUCKETED result (the query cache already dedupes the
 *  fetch itself; this avoids re-bucketing 1k values on every popover open). */
const availabilityCache = new Map<string, DateAvailability>();

/** Shared empty clause set (a fresh [] default would rebuild the memo key). */
const NO_FILTERS: FilterClause[] = [];

function deriveAvailability(values: CellValue[], hasMore: boolean): DateAvailability {
  const days = new Set<string>();
  const months = new Set<string>();
  let min: string | null = null;
  let max: string | null = null;
  for (const value of values) {
    const day = toDateOnly(value);
    if (day === null) continue;
    days.add(day);
    months.add(monthOf(day));
    if (min === null || day < min) min = day;
    if (max === null || day > max) max = day;
  }
  return { status: 'ok', days, months, min, max, partial: hasMore };
}

/**
 * Distinct values of a date column, bucketed into day/month availability sets.
 * Same endpoint the checklist variant uses (`runtime.queries.distinct`, whose
 * 5-minute cache dedupes repeat opens); fetched lazily — `enabled` flips true
 * the first time a calendar opens — and memoized per column PLUS the cascade
 * clause set (a cascading slicer marks only the days that survive the other
 * filters, so the memo key must carry them or two scopes would collide).
 */
export function useDateAvailability(
  modelId: number,
  table: string,
  column: string,
  enabled: boolean,
  filters: FilterClause[] = NO_FILTERS,
): DateAvailability {
  const runtime = useRuntime();
  const filtersKey = stableStringify(filters);
  const cacheKey = `${modelId}|${table}|${column}|${filtersKey}`;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const [result, setResult] = useState<DateAvailability>(
    () => availabilityCache.get(cacheKey) ?? IDLE,
  );

  useEffect(() => {
    if (!enabled) return;
    const cached = availabilityCache.get(cacheKey);
    if (cached) {
      setResult(cached);
      return;
    }
    let cancelled = false;
    setResult(LOADING);
    runtime.queries
      .distinct({
        modelId,
        table,
        column,
        search: null,
        filters: [...filtersRef.current],
        limit: AVAILABILITY_LIMIT,
      })
      .then((response) => {
        const derived = deriveAvailability(response.values, response.hasMore);
        availabilityCache.set(cacheKey, derived);
        if (!cancelled) setResult(derived);
      })
      .catch(() => {
        // Availability is decoration: a failure downgrades to a plain calendar.
        if (!cancelled) setResult(FAILED);
      });
    return () => {
      cancelled = true;
    };
  }, [runtime, cacheKey, enabled, modelId, table, column]);

  return enabled ? result : IDLE;
}

/** Month the calendar opens on when nothing is selected yet. */
function resolveInitialMonth(
  option: DateRangeOptions['initialMonth'],
  availability: DateAvailability,
): string {
  if (option === 'dataStart' && availability.min !== null) return monthOf(availability.min);
  if (option === 'dataEnd' && availability.max !== null) return monthOf(availability.max);
  if (typeof option === 'string' && MONTH_KEY.test(option)) return option;
  return monthOf(todayDateOnly());
}

/** initialMonth settings that cannot resolve until availability has landed. */
const needsAvailability = (option: DateRangeOptions['initialMonth']): boolean =>
  option === 'dataStart' || option === 'dataEnd';

/* ============================================================ calendar UI */

type Endpoint = 'from' | 'to';

export interface SlicerCalendarFieldsProps {
  modelId: number;
  table: string;
  column: string;
  label: string;
  compact: boolean;
  options: DateRangeOptions;
  /** '' when that endpoint is unset. */
  from: string;
  to: string;
  /** Both '' clears the slicer value (never an empty-string range). */
  onChange: (from: string, to: string) => void;
  /** Honors spec.showClear; hides the inline Clear affordances when false. */
  showClear: boolean;
  /**
   * CASCADE clauses (SlicerTileSpec.cascade): scope the data-availability
   * marks to the days that survive the dashboard's other filters. Empty = the
   * whole column. Must be referentially stable.
   */
  filters?: FilterClause[];
}

/**
 * The dateRange variant's 'calendar' picker: two read-only endpoint triggers
 * that both feed one popover calendar. Picking a From auto-advances to To, so
 * a full range is two clicks.
 */
export function SlicerCalendarFields({
  modelId,
  table,
  column,
  label,
  compact,
  options,
  from,
  to,
  onChange,
  showClear,
  filters = NO_FILTERS,
}: SlicerCalendarFieldsProps) {
  const [editing, setEditing] = useState<Endpoint | null>(null);
  /** Availability is fetched lazily: the first open arms it for good. */
  const [armed, setArmed] = useState(false);
  const fromRef = useRef<HTMLButtonElement>(null);
  const toRef = useRef<HTMLButtonElement>(null);

  const wantsAvailability =
    options.showAvailability !== false || needsAvailability(options.initialMonth);
  const availability = useDateAvailability(
    modelId,
    table,
    column,
    armed && wantsAvailability,
    filters,
  );

  const open = (endpoint: Endpoint) => {
    setArmed(true);
    setEditing(endpoint);
  };

  const close = useCallback(() => {
    const endpoint = editing;
    setEditing(null);
    (endpoint === 'to' ? toRef : fromRef).current?.focus();
  }, [editing]);

  /** Keeps the range ordered: an out-of-order pick drops the other endpoint. */
  const pick = (day: string) => {
    if (editing === 'to') {
      onChange(from !== '' && day < from ? '' : from, day);
      close();
    } else {
      onChange(day, to !== '' && day > to ? '' : to);
      // Two-click range: setting From hands the calendar to To.
      setEditing('to');
    }
  };

  const triggerClasses = (endpoint: Endpoint, filled: boolean): string =>
    `flex w-full items-center justify-between gap-1.5 rounded-lg border bg-rcd-surface text-left text-rcd-text shadow-[var(--rcd-shadow-1)] transition-colors hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rcd-accent-interactive)] dark:hover:bg-white/10 ${
      compact ? 'h-7 px-2 text-xs' : 'h-9 px-3 text-sm'
    } ${
      editing === endpoint || filled
        ? 'border-[var(--rcd-accent-interactive)]'
        : 'border-rcd-border'
    }`;

  const labelClasses = compact
    ? 'flex w-full max-w-[18rem] flex-col gap-0.5 text-[11px] text-rcd-text-2'
    : 'flex w-full max-w-[18rem] flex-col gap-1 text-xs text-rcd-text-2';

  return (
    <div className={compact ? 'flex flex-col gap-1 p-0.5' : 'flex flex-col gap-2 p-0.5'}>
      <div className={compact ? 'flex flex-wrap gap-1' : 'flex flex-wrap gap-2'}>
        <div className={labelClasses}>
          From
          <button
            ref={fromRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={editing === 'from'}
            onClick={() => (editing === 'from' ? close() : open('from'))}
            className={triggerClasses('from', from !== '')}
          >
            <span className={`min-w-0 truncate ${from === '' ? 'text-rcd-muted' : ''}`}>
              {from === '' ? 'Any date' : formatDateOnly(from)}
            </span>
            <CalendarDays size={13} className="shrink-0 text-rcd-muted" />
          </button>
        </div>
        <div className={labelClasses}>
          To
          <button
            ref={toRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={editing === 'to'}
            onClick={() => (editing === 'to' ? close() : open('to'))}
            className={triggerClasses('to', to !== '')}
          >
            <span className={`min-w-0 truncate ${to === '' ? 'text-rcd-muted' : ''}`}>
              {to === '' ? 'Any date' : formatDateOnly(to)}
            </span>
            <CalendarDays size={13} className="shrink-0 text-rcd-muted" />
          </button>
        </div>
      </div>

      {showClear && (from !== '' || to !== '') && (
        <div className="flex">
          <RcdButton
            variant="ghost"
            size="sm"
            className={compact ? '!h-6 !px-1.5 !text-[11px]' : '!px-2'}
            title="Clear the date range (back to all dates)"
            onClick={() => onChange('', '')}
          >
            <X size={12} />
            Clear dates
          </RcdButton>
        </div>
      )}

      {editing !== null &&
        // Portal past the transformed grid item. The wrapper MUST carry
        // rcd-root (theme tokens) — and bg-transparent, or the fixed wrapper
        // paints --rcd-bg over the whole page.
        createPortal(
          <div className="rcd-root bg-transparent">
            <CalendarPopover
              anchor={editing === 'to' ? toRef : fromRef}
              label={label}
              endpoint={editing}
              from={from}
              to={to}
              options={options}
              availability={availability}
              showClear={showClear}
              onPick={pick}
              onClear={() => {
                onChange('', '');
                close();
              }}
              onClose={close}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * The popover calendar itself: month grid with availability dots, a
 * month/year fast-jump, and full keyboard support (arrows/Home/End/PageUp/
 * PageDown move a roving focus; Enter/Space pick; Escape closes). Fixed
 * position, anchored under the trigger and clamped to the viewport.
 */
function CalendarPopover({
  anchor,
  label,
  endpoint,
  from,
  to,
  options,
  availability,
  showClear,
  onPick,
  onClear,
  onClose,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  label: string;
  endpoint: Endpoint;
  from: string;
  to: string;
  options: DateRangeOptions;
  availability: DateAvailability;
  showClear: boolean;
  onPick: (day: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);

  const today = useMemo(todayDateOnly, []);
  const selectedEnd = endpoint === 'to' ? to : from;

  /** Month to show while nothing steers it: the edited endpoint, the other
   *  endpoint, then the configured initialMonth. */
  const preferredMonth = useMemo(() => {
    if (selectedEnd !== '') return monthOf(selectedEnd);
    const other = endpoint === 'to' ? from : to;
    if (other !== '') return monthOf(other);
    return resolveInitialMonth(options.initialMonth, availability);
  }, [selectedEnd, endpoint, from, to, options.initialMonth, availability]);

  const [month, setMonth] = useState(preferredMonth);
  const [jumpYear, setJumpYear] = useState(() => monthParts(preferredMonth).year);
  /** Once the user drives the view, availability must not yank it back. */
  const steeredRef = useRef(false);
  useEffect(() => {
    if (steeredRef.current) return;
    setMonth(preferredMonth);
    setJumpYear(monthParts(preferredMonth).year);
  }, [preferredMonth]);

  const [focusDay, setFocusDay] = useState(() =>
    selectedEnd !== '' ? selectedEnd : `${preferredMonth}-01`,
  );

  // Roving focus: move the DOM focus onto whichever day is focus-owner. Days
  // outside the displayed month resolve to nothing, so month navigation with
  // the arrow buttons never steals focus from them.
  useEffect(() => {
    if (jumpOpen) return;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)?.focus();
  }, [focusDay, month, jumpOpen]);

  // Anchor under the trigger, clamp to the viewport, flip above when needed.
  useLayoutEffect(() => {
    const trigger = anchor.current;
    const card = cardRef.current;
    if (!trigger || !card) return;
    const a = trigger.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    const x = Math.max(8, Math.min(a.left, window.innerWidth - rect.width - 8));
    let y = a.bottom + 4;
    if (y + rect.height > window.innerHeight - 8) {
      const above = a.top - rect.height - 4;
      y = above >= 8 ? above : Math.max(8, window.innerHeight - rect.height - 8);
    }
    setPos({ x, y });
  }, [anchor, jumpOpen, availability.status]);

  useEffect(() => {
    const isInside = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      ((cardRef.current?.contains(target) ?? false) || (anchor.current?.contains(target) ?? false));
    const onPointerDown = (event: MouseEvent) => {
      if (!isInside(event.target)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    // Anchored to a fixed point: scrolling anything outside detaches it.
    const onScroll = (event: Event) => {
      if (!isInside(event.target)) onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  const steer = (nextMonth: string) => {
    steeredRef.current = true;
    setMonth(nextMonth);
  };

  const moveFocus = (nextDay: string) => {
    steeredRef.current = true;
    setFocusDay(nextDay);
    if (monthOf(nextDay) !== month) setMonth(monthOf(nextDay));
  };

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, () => string> = {
      ArrowLeft: () => addDays(focusDay, -1),
      ArrowRight: () => addDays(focusDay, 1),
      ArrowUp: () => addDays(focusDay, -7),
      ArrowDown: () => addDays(focusDay, 7),
      Home: () => addDays(focusDay, -utcDate(focusDay).getUTCDay()),
      End: () => addDays(focusDay, 6 - utcDate(focusDay).getUTCDay()),
      PageUp: () => clampToMonth(focusDay, shiftMonth(monthOf(focusDay), -1)),
      PageDown: () => clampToMonth(focusDay, shiftMonth(monthOf(focusDay), 1)),
    };
    const next = keys[event.key];
    if (!next) return;
    event.preventDefault();
    moveFocus(next());
  };

  const { year, month: monthNumber } = monthParts(month);
  const leading = firstWeekday(year, monthNumber);
  const dayCount = daysInMonth(year, monthNumber);
  const days = useMemo(
    () =>
      Array.from({ length: dayCount }, (_, index) => monthKeyOf(year, monthNumber) + `-${pad2(index + 1)}`),
    [dayCount, year, monthNumber],
  );

  const markAvailability = options.showAvailability !== false && availability.status === 'ok';
  /** Only a COMPLETE scan may dim a month: a capped one proves no absence. */
  const canDim = markAvailability && !availability.partial;
  const awaitingMonth =
    needsAvailability(options.initialMonth) &&
    selectedEnd === '' &&
    from === '' &&
    to === '' &&
    (availability.status === 'loading' || availability.status === 'idle');

  const rangeLow = from !== '' && to !== '' ? from : null;
  const rangeHigh = from !== '' && to !== '' ? to : null;

  const weekdays = useMemo(weekdayInitials, []);
  const months = useMemo(shortMonthNames, []);

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`${label}: choose ${endpoint === 'to' ? 'end' : 'start'} date`}
      style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? undefined : 'hidden' }}
      className="fixed z-50 w-[17.5rem] max-w-[92vw] rounded-xl border border-rcd-border bg-rcd-surface p-2 shadow-[var(--rcd-shadow-2)]"
    >
      <div className="flex items-center justify-between gap-1 pb-1">
        <button
          type="button"
          aria-label="Previous month"
          title="Previous month"
          onClick={() => steer(shiftMonth(month, -1))}
          className="rounded-md p-1 text-rcd-text-2 transition-colors hover:bg-black/5 hover:text-rcd-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rcd-accent-interactive)] dark:hover:bg-white/10"
        >
          <ChevronLeft size={15} />
        </button>
        <button
          type="button"
          aria-haspopup="true"
          aria-expanded={jumpOpen}
          title="Jump to a month"
          onClick={() => {
            setJumpYear(monthParts(month).year);
            setJumpOpen((value) => !value);
          }}
          className="flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-rcd-text transition-colors hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rcd-accent-interactive)] dark:hover:bg-white/10"
        >
          <span className="truncate">{monthTitle(month)}</span>
          <ChevronRight
            size={13}
            className={`shrink-0 text-rcd-muted transition-transform ${jumpOpen ? 'rotate-90' : 'rotate-0'}`}
          />
        </button>
        <button
          type="button"
          aria-label="Next month"
          title="Next month"
          onClick={() => steer(shiftMonth(month, 1))}
          className="rounded-md p-1 text-rcd-text-2 transition-colors hover:bg-black/5 hover:text-rcd-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rcd-accent-interactive)] dark:hover:bg-white/10"
        >
          <ChevronRight size={15} />
        </button>
      </div>

      {jumpOpen ? (
        <div className="pb-1">
          <div className="flex items-center justify-between gap-1 pb-1">
            <button
              type="button"
              aria-label="Previous year"
              onClick={() => setJumpYear((value) => value - 1)}
              className="rounded-md p-1 text-rcd-text-2 transition-colors hover:bg-black/5 hover:text-rcd-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rcd-accent-interactive)] dark:hover:bg-white/10"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-sm font-medium text-rcd-text">{jumpYear}</span>
            <button
              type="button"
              aria-label="Next year"
              onClick={() => setJumpYear((value) => value + 1)}
              className="rounded-md p-1 text-rcd-text-2 transition-colors hover:bg-black/5 hover:text-rcd-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rcd-accent-interactive)] dark:hover:bg-white/10"
            >
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {months.map((name, index) => {
              const key = monthKeyOf(jumpYear, index + 1);
              const empty = canDim && !availability.months.has(key);
              const isCurrent = key === month;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    steer(key);
                    setJumpOpen(false);
                    setFocusDay(`${key}-01`);
                  }}
                  title={empty ? `${name} ${jumpYear} — no data` : `${name} ${jumpYear}`}
                  className={`rounded-md px-1 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rcd-accent-interactive)] ${
                    isCurrent
                      ? 'bg-rcd-accent font-medium text-white'
                      : 'text-rcd-text hover:bg-black/5 dark:hover:bg-white/10'
                  } ${empty && !isCurrent ? 'opacity-35' : ''}`}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      ) : awaitingMonth ? (
        <div className="flex h-[13.5rem] items-center justify-center">
          <RcdSpinner label="Loading dates…" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-7 gap-0.5 pb-0.5">
            {weekdays.map((initial, index) => (
              <span
                key={index}
                aria-hidden
                className="flex h-5 items-center justify-center text-[10px] font-medium uppercase text-rcd-muted"
              >
                {initial}
              </span>
            ))}
          </div>
          <div
            ref={gridRef}
            role="group"
            aria-label={monthTitle(month)}
            onKeyDown={onGridKeyDown}
            className="grid grid-cols-7 gap-0.5"
          >
            {Array.from({ length: leading }, (_, index) => (
              <span key={`pad-${index}`} aria-hidden />
            ))}
            {days.map((day) => {
              const isEnd = day === from || day === to;
              const inRange =
                rangeLow !== null && rangeHigh !== null && day > rangeLow && day < rangeHigh;
              const hasData = markAvailability && availability.days.has(day);
              const isFocusOwner = day === focusDay;
              return (
                <button
                  key={day}
                  type="button"
                  data-day={day}
                  tabIndex={isFocusOwner ? 0 : -1}
                  aria-label={`${formatFullDate(day)}${hasData ? ' — has data' : ''}`}
                  aria-pressed={isEnd}
                  aria-current={day === today ? 'date' : undefined}
                  onFocus={() => setFocusDay(day)}
                  onClick={() => onPick(day)}
                  className={`relative flex h-8 w-full items-center justify-center rounded-md text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rcd-accent-interactive)] ${
                    isEnd
                      ? 'bg-rcd-accent font-semibold text-white'
                      : inRange
                        ? 'bg-[color-mix(in_srgb,var(--rcd-accent-interactive)_14%,transparent)] text-rcd-text hover:bg-[color-mix(in_srgb,var(--rcd-accent-interactive)_24%,transparent)]'
                        : 'text-rcd-text hover:bg-black/5 dark:hover:bg-white/10'
                  } ${day === today && !isEnd ? 'ring-1 ring-inset ring-rcd-border' : ''}`}
                >
                  {Number(day.slice(8, 10))}
                  {hasData && (
                    <span
                      aria-hidden
                      className={`absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full ${
                        isEnd ? 'bg-white' : 'bg-[var(--rcd-accent-interactive)]'
                      }`}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-rcd-border pt-1.5">
        <span className="min-w-0 truncate text-[10px] text-rcd-muted">
          {endpoint === 'to' ? 'Picking end date' : 'Picking start date'}
          {markAvailability && availability.partial ? ' · partial data marks' : ''}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {showClear && (from !== '' || to !== '') && (
            <RcdButton
              variant="ghost"
              size="sm"
              className="!h-6 !px-2 !text-[11px]"
              title="Clear the date range"
              onClick={onClear}
            >
              Clear
            </RcdButton>
          )}
          <RcdButton
            variant="ghost"
            size="sm"
            className="!h-6 !px-2 !text-[11px]"
            title="Jump to today"
            onClick={() => {
              steer(monthOf(today));
              setJumpOpen(false);
              setFocusDay(today);
            }}
          >
            Today
          </RcdButton>
        </div>
      </div>
    </div>
  );
}

/** Same day-of-month in another month, clamped to that month's length. */
function clampToMonth(dateOnly: string, targetMonth: string): string {
  const { year, month } = monthParts(targetMonth);
  const day = Math.min(Number(dateOnly.slice(8, 10)), daysInMonth(year, month));
  return `${targetMonth}-${pad2(day)}`;
}
