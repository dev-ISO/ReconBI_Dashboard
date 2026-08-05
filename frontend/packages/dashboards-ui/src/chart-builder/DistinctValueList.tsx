import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw, Search } from 'lucide-react';
import type { CellValue, FilterValue } from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdInput, RcdSpinner } from '../primitives';

export interface DistinctValueListProps {
  modelId: number;
  table: string;
  column: string;
  selected: readonly FilterValue[];
  onToggle: (value: FilterValue) => void;
}

interface FetchState {
  status: 'loading' | 'ok' | 'error';
  values: CellValue[];
  hasMore: boolean;
  error: string | null;
}

const keyOf = (value: FilterValue): string => `${typeof value}:${String(value)}`;

/**
 * Searchable multi-select checklist over a column's distinct values, fed by the
 * shared query cache (`runtime.queries.distinct`, server-side search). Used by
 * the chart FilterEditor ('in' operator) and dashboard slicer popovers.
 */
export function DistinctValueList({ modelId, table, column, selected, onToggle }: DistinctValueListProps) {
  const runtime = useRuntime();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [retryToken, setRetryToken] = useState(0);
  const [state, setState] = useState<FetchState>({
    status: 'loading',
    values: [],
    hasMore: false,
    error: null,
  });

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setState((prev) => ({ ...prev, status: 'loading', error: null }));
    runtime.queries
      .distinct(
        { modelId, table, column, search: debounced.trim() || null, filters: [] },
        controller.signal,
      )
      .then((result) => {
        if (cancelled) return;
        setState({ status: 'ok', values: result.values, hasMore: result.hasMore, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        setState({
          status: 'error',
          values: [],
          hasMore: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runtime, modelId, table, column, debounced, retryToken]);

  // Keep already-selected values visible (and un-toggleable) even when the
  // current search response doesn't include them.
  const listed = useMemo<FilterValue[]>(() => {
    const fetched = state.values.filter((value): value is FilterValue => value !== null);
    const fetchedKeys = new Set(fetched.map(keyOf));
    const pinned = selected.filter((value) => !fetchedKeys.has(keyOf(value)));
    return [...pinned, ...fetched];
  }, [state.values, selected]);

  const selectedKeys = useMemo(() => new Set(selected.map(keyOf)), [selected]);

  return (
    <div className="flex flex-col gap-2">
      {/* max-w keeps the search box from stretching edge-to-edge in wide hosts. */}
      <div className="relative max-w-[18rem]">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-rcd-muted" />
        <RcdInput
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search values…"
          aria-label={`Search ${column} values`}
          className="w-full pl-7"
        />
      </div>

      <div className="max-h-56 min-h-[6rem] overflow-y-auto rounded-md border border-rcd-border">
        {state.status === 'error' ? (
          <div className="flex flex-col items-center gap-2 p-4 text-center">
            <AlertTriangle size={16} className="text-[var(--rcd-status-warn)]" />
            <p className="max-w-full break-words text-xs text-rcd-text-2">{state.error}</p>
            <RcdButton onClick={() => setRetryToken((t) => t + 1)}>
              <RefreshCw size={13} />
              Retry
            </RcdButton>
          </div>
        ) : state.status === 'loading' && listed.length === 0 ? (
          <div className="flex h-24 items-center justify-center">
            <RcdSpinner label="Loading values…" />
          </div>
        ) : listed.length === 0 ? (
          <p className="p-3 text-xs text-rcd-muted">No values match.</p>
        ) : (
          <div className={`flex flex-col p-1 ${state.status === 'loading' ? 'opacity-60' : ''}`}>
            {listed.map((value) => (
              <label
                key={keyOf(value)}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
              >
                <input
                  type="checkbox"
                  className="accent-[var(--rcd-accent)]"
                  checked={selectedKeys.has(keyOf(value))}
                  onChange={() => onToggle(value)}
                />
                <span className="min-w-0 truncate" title={String(value)}>
                  {String(value)}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        {state.hasMore ? (
          <p className="text-[11px] text-rcd-muted">More values exist — refine your search.</p>
        ) : (
          <span />
        )}
        {selected.length > 0 && (
          <p className="shrink-0 text-[11px] text-rcd-muted">{selected.length} selected</p>
        )}
      </div>
    </div>
  );
}
