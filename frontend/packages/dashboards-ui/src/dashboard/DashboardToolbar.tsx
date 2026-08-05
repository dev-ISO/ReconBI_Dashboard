import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BarChart3,
  ChevronDown,
  Filter,
  Image as ImageIcon,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Share2,
  SlidersHorizontal,
  Type,
} from 'lucide-react';
import { ConfirmDialog, RcdButton, RcdIconButton, RcdSelect } from '../primitives';

export interface DashboardToolbarProps {
  name: string;
  isShared: boolean;
  mode: 'view' | 'edit';
  dirty: boolean;
  saving: boolean;
  /** Last save error (shown inline when present). */
  error: string | null;
  readonly: boolean;
  onEnterEdit: () => void;
  onAddChart: () => void;
  onAddText: () => void;
  onAddImage: () => void;
  onAddSlicer: () => void;
  /** Disables the Add > Slicer item (no model attached). */
  addSlicerDisabled?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** View-mode auto-refresh interval (persisted with the layout); null = off. */
  refreshSeconds?: number | null;
  /** Edit-mode change of the auto-refresh interval. */
  onChangeRefreshSeconds?: (seconds: number | null) => void;
  /** Manual "refresh all tiles now" (both modes). */
  onRefresh?: () => void;
  /** Spins the refresh icon while a (manual or auto) refresh is in flight. */
  refreshing?: boolean;
  /** When the dashboard's data was last (re)loaded; null before first load. */
  lastRefreshAt?: Date | null;
  /** Opens the PDF-export (print) configurator (both modes). */
  onExport?: () => void;
  /** Toggles the Filters pane (both modes). */
  onToggleFilters?: () => void;
  /** Whether the Filters pane is open (button pressed state). */
  filtersOpen?: boolean;
  /** Enabled filter cards currently contributing clauses (badge count). */
  activeFilterCount?: number;
}

const REFRESH_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Auto refresh: off' },
  { value: '30', label: 'Every 30s' },
  { value: '60', label: 'Every 1m' },
  { value: '300', label: 'Every 5m' },
  { value: '900', label: 'Every 15m' },
];

/** Dashboard header: name + badges on the left, mode-dependent actions on the right. */
export function DashboardToolbar({
  name,
  isShared,
  mode,
  dirty,
  saving,
  error,
  readonly,
  onEnterEdit,
  onAddChart,
  onAddText,
  onAddImage,
  onAddSlicer,
  addSlicerDisabled,
  onSave,
  onDiscard,
  refreshSeconds = null,
  onChangeRefreshSeconds,
  onRefresh,
  refreshing = false,
  lastRefreshAt = null,
  onExport,
  onToggleFilters,
  filtersOpen = false,
  activeFilterCount = 0,
}: DashboardToolbarProps) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const handleDiscard = () => {
    if (dirty) setConfirmDiscard(true);
    else onDiscard();
  };

  return (
    <div className="flex items-center gap-3 border-b border-rcd-border bg-rcd-surface px-4 py-2.5">
      <h1 className="truncate text-base font-semibold text-rcd-text" title={name}>
        {name}
      </h1>
      {isShared && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-rcd-border px-2 py-0.5 text-[11px] text-rcd-text-2">
          <Share2 size={11} />
          Shared
        </span>
      )}
      {mode === 'edit' && dirty && (
        <span className="shrink-0 text-xs text-rcd-muted">Unsaved changes</span>
      )}

      <div className="min-w-0 flex-1" />

      {error && (
        <span className="truncate text-xs text-[var(--rcd-status-critical)]" title={error}>
          {error}
        </span>
      )}

      {onToggleFilters && (
        <div className="relative shrink-0">
          <RcdIconButton
            aria-label={filtersOpen ? 'Hide filters pane' : 'Show filters pane'}
            title="Filters"
            aria-pressed={filtersOpen}
            onClick={onToggleFilters}
            className={filtersOpen ? 'bg-black/5 text-rcd-text dark:bg-white/10' : ''}
          >
            <Filter size={14} />
          </RcdIconButton>
          {activeFilterCount > 0 && (
            <span
              aria-hidden
              className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-rcd-accent px-1 text-[10px] font-semibold leading-none text-white"
            >
              {activeFilterCount}
            </span>
          )}
        </div>
      )}

      {onExport && (
        <RcdIconButton aria-label="Export as PDF" title="Export as PDF (print)" onClick={onExport}>
          <Printer size={14} />
        </RcdIconButton>
      )}

      {onRefresh && (
        <>
          {lastRefreshAt && <LastRefreshCaption at={lastRefreshAt} />}
          <RcdIconButton aria-label="Refresh tiles" title="Refresh tiles" onClick={onRefresh}>
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} />
          </RcdIconButton>
        </>
      )}

      {mode === 'view'
        ? !readonly && (
            <RcdButton onClick={onEnterEdit}>
              <Pencil size={14} />
              Edit
            </RcdButton>
          )
        : !readonly && (
            <>
              {onChangeRefreshSeconds && (
                <RcdSelect
                  aria-label="Auto refresh interval"
                  title="Auto refresh (view mode)"
                  value={refreshSeconds == null ? '' : String(refreshSeconds)}
                  onChange={(event) =>
                    onChangeRefreshSeconds(
                      event.target.value === '' ? null : Number(event.target.value),
                    )
                  }
                >
                  {REFRESH_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </RcdSelect>
              )}
              <AddTileMenu
                onAddChart={onAddChart}
                onAddText={onAddText}
                onAddImage={onAddImage}
                onAddSlicer={onAddSlicer}
                addSlicerDisabled={addSlicerDisabled ?? false}
              />
              <RcdButton onClick={handleDiscard} disabled={saving}>
                Discard
              </RcdButton>
              <RcdButton variant="primary" onClick={onSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </RcdButton>
            </>
          )}

      <ConfirmDialog
        title="Discard changes"
        message="Discard all unsaved changes to this dashboard?"
        confirmLabel="Discard"
        danger
        open={confirmDiscard}
        onConfirm={() => {
          setConfirmDiscard(false);
          onDiscard();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}

/** "Updated just now" / "Updated 2m ago" / "Updated 3:41 PM" (hour-plus old). */
const formatUpdated = (at: Date): string => {
  const ageMs = Date.now() - at.getTime();
  if (ageMs < 60_000) return 'Updated just now';
  if (ageMs < 3_600_000) return `Updated ${Math.floor(ageMs / 60_000)}m ago`;
  return `Updated ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
};

/**
 * Subtle "last refreshed" caption beside the refresh button. Ticks every 30s
 * so the relative label stays current — the tick only re-renders this span,
 * it never touches any data. Hidden on very narrow toolbars.
 */
function LastRefreshCaption({ at }: { at: Date }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span
      className="hidden shrink-0 text-[11px] text-rcd-muted sm:inline"
      title={`Last refreshed ${at.toLocaleString()}`}
    >
      {formatUpdated(at)}
    </span>
  );
}

/**
 * The edit-mode add affordance: one "Add" button opening a small menu card
 * (chart / text / image / slicer). A styled card, NOT a native menu; closed by
 * outside click or Escape. The toolbar sits in normal (untransformed) flow, so
 * the absolutely-positioned card needs no portal.
 */
function AddTileMenu({
  onAddChart,
  onAddText,
  onAddImage,
  onAddSlicer,
  addSlicerDisabled,
}: {
  onAddChart: () => void;
  onAddText: () => void;
  onAddImage: () => void;
  onAddSlicer: () => void;
  addSlicerDisabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const pick = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="relative" ref={rootRef}>
      <RcdButton
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus size={14} />
        Add
        <ChevronDown size={13} />
      </RcdButton>

      {open && (
        <div
          role="menu"
          aria-label="Add tile"
          className="absolute right-0 top-full z-40 mt-1 w-40 rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-lg"
        >
          <AddMenuItem onClick={() => pick(onAddChart)}>
            <BarChart3 size={14} />
            Chart
          </AddMenuItem>
          <AddMenuItem onClick={() => pick(onAddText)}>
            <Type size={14} />
            Text
          </AddMenuItem>
          <AddMenuItem onClick={() => pick(onAddImage)}>
            <ImageIcon size={14} />
            Image
          </AddMenuItem>
          <AddMenuItem
            onClick={() => pick(onAddSlicer)}
            disabled={addSlicerDisabled}
            title={addSlicerDisabled ? 'Attach a model to add slicers' : undefined}
          >
            <SlidersHorizontal size={14} />
            Slicer
          </AddMenuItem>
        </div>
      )}
    </div>
  );
}

function AddMenuItem({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
    >
      {children}
    </button>
  );
}
