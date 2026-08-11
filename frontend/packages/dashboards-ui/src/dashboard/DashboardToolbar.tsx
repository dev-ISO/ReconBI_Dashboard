import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BarChart3,
  Bell,
  Bookmark,
  Check,
  ChevronDown,
  Copy,
  Filter,
  Highlighter,
  History,
  Image as ImageIcon,
  Lock,
  Mail,
  Maximize,
  MoreHorizontal,
  MoreVertical,
  Network,
  Pencil,
  Plus,
  Printer,
  Redo2,
  RefreshCw,
  Scan,
  Share2,
  Shrink,
  SlidersHorizontal,
  Smartphone,
  Trash2,
  Type,
  Undo2,
  UserMinus,
  Variable,
} from 'lucide-react';
import type { AlertFiring, ViewFitMode } from '@recon/dashboards-core';
import { ConfirmDialog, RcdButton, RcdIconButton, RcdInput, RcdSelect } from '../primitives';

/** Bookmark row data the toolbar menu needs (name + identity only). */
export interface ToolbarBookmark {
  id: string;
  name: string;
}

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
  /** Saved bookmarks (menu hidden when absent AND management is off). */
  bookmarks?: ToolbarBookmark[];
  /** Bookmark whose applied state is still current (check mark). */
  lastAppliedBookmarkId?: string | null;
  /** Editors get add/update/rename/delete; viewers are apply-only. */
  canManageBookmarks?: boolean;
  onApplyBookmark?: (id: string) => void;
  onAddBookmark?: (name: string) => void;
  onUpdateBookmark?: (id: string) => void;
  onRenameBookmark?: (id: string, name: string) => void;
  onDeleteBookmark?: (id: string) => void;
  /** Edit mode: opens the field-parameter manage dialog (Add ▾ menu item). */
  onManageParameters?: () => void;
  /** View mode (non-readonly): opens the Subscriptions dialog (⋯ menu). */
  onSubscribe?: () => void;
  /** Recent alert firings for the bell dropdown; undefined hides the bell. */
  alertFirings?: AlertFiring[] | null;
  /** Edit mode: mobile-layout canvas toggle (phone icon, pressed state). */
  mobileLayoutOpen?: boolean;
  onToggleMobileLayout?: () => void;
  /**
   * Edit mode: opens the "Filters & indicator" settings card, anchored under
   * its button (dashboard chrome — deliberately not in the chart Format panel).
   */
  onConfigureFilterIndicator?: (position: { x: number; y: number }) => void;
  /**
   * Content rendered in the toolbar's flexible middle — the filter
   * indicator's 'header' docking slot, which is the DEFAULT placement: active
   * cross-filter/slicer chips live in this row rather than floating over the
   * tiles. Must be single-line and self-clipping (HeaderFilterBar is).
   */
  centerContent?: ReactNode;
  /** Current view sizing shown by the View menu (control hidden when the handler is absent). */
  viewFit?: ViewFitMode;
  /**
   * Changes the view sizing: a transient per-session viewer choice in VIEW
   * mode, the persisted doc default (`defaultViewFit`) in EDIT mode.
   */
  onChangeViewFit?: (fit: ViewFitMode) => void;
  /** Built-in (seeded) content: "Built-in" badge next to the name. */
  isSystem?: boolean;
  /** Opens the Share dialog (owner/admin, non-system; button hidden when absent). */
  onShare?: () => void;
  /** Overflow ⋯: "Make a copy" (available to everyone who can view). */
  onMakeCopy?: () => void;
  /** Overflow ⋯: "Activity" (edit-rights holders). */
  onActivity?: () => void;
  /** Overflow ⋯: "Linked model…" (owner/admin, edit mode — caller gates). */
  onLinkedModel?: () => void;
  /** Overflow ⋯: "Delete" (owner/admin, non-system; danger). */
  onDelete?: () => void;
  /** Overflow ⋯: "Remove from my list" (grantee; danger). */
  onLeave?: () => void;
  /** Edit-mode Undo/Redo buttons (hidden when the handlers are absent). */
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  /**
   * Shows the edit-mode Add ▾ menu (default true). Grantees without chart
   * rights get their add-tile affordance hidden here.
   */
  canAddTiles?: boolean;
  /** Host-injected toolbar actions (e.g. "Send to chat"), right of the built-ins. */
  extraActions?: ReactNode;
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
  bookmarks = [],
  lastAppliedBookmarkId = null,
  canManageBookmarks = false,
  onApplyBookmark,
  onAddBookmark,
  onUpdateBookmark,
  onRenameBookmark,
  onDeleteBookmark,
  onManageParameters,
  onSubscribe,
  alertFirings,
  mobileLayoutOpen = false,
  onToggleMobileLayout,
  onConfigureFilterIndicator,
  centerContent,
  // Fit to page is the product default (matches the view's docViewFit default).
  viewFit = 'fitPage',
  onChangeViewFit,
  isSystem = false,
  onShare,
  onMakeCopy,
  onActivity,
  onLinkedModel,
  onDelete,
  onLeave,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  canAddTiles = true,
  extraActions,
}: DashboardToolbarProps) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const handleDiscard = () => {
    if (dirty) setConfirmDiscard(true);
    else onDiscard();
  };

  // The ⋯ menu hosts the less-frequent actions in BOTH modes.
  const overflowItems: OverflowItem[] = [];
  if (mode === 'view' && !readonly && onSubscribe) {
    overflowItems.push({
      key: 'subscribe',
      icon: <Mail size={14} />,
      label: 'Subscribe…',
      onClick: onSubscribe,
    });
  }
  if (onActivity) {
    overflowItems.push({
      key: 'activity',
      icon: <History size={14} />,
      label: 'Activity',
      onClick: onActivity,
    });
  }
  if (onLinkedModel && mode === 'edit') {
    overflowItems.push({
      key: 'linkedModel',
      icon: <Network size={14} />,
      label: 'Linked model…',
      onClick: onLinkedModel,
    });
  }
  if (onMakeCopy) {
    overflowItems.push({
      key: 'makeCopy',
      icon: <Copy size={14} />,
      label: 'Make a copy',
      onClick: onMakeCopy,
    });
  }
  if (onDelete) {
    overflowItems.push({
      key: 'delete',
      icon: <Trash2 size={14} />,
      label: 'Delete',
      danger: true,
      onClick: onDelete,
    });
  }
  if (onLeave) {
    overflowItems.push({
      key: 'leave',
      icon: <UserMinus size={14} />,
      label: 'Remove from my list',
      danger: true,
      onClick: onLeave,
    });
  }

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-rcd-border bg-rcd-surface px-4">
      <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-rcd-text" title={name}>
        {name}
      </h1>
      {isSystem && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-rcd-border bg-rcd-surface px-2 py-0.5 text-[11px] font-medium text-rcd-text-2 shadow-[var(--rcd-shadow-1)]"
          title="Built-in content managed by the application. Make a copy to edit it."
        >
          <Lock size={11} />
          Built-in
        </span>
      )}
      {isShared && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-rcd-border bg-rcd-surface px-2 py-0.5 text-[11px] font-medium text-rcd-text-2 shadow-[var(--rcd-shadow-1)]"
          title="Published: visible to everyone"
        >
          <Share2 size={11} />
          Everyone
        </span>
      )}
      {mode === 'edit' && dirty && (
        <span className="shrink-0 text-xs text-rcd-muted">Unsaved changes</span>
      )}

      {/* Flexible middle: the DEFAULT home of the active-filter chips. Its
          width comes from the flex line (flex-1 + basis 0), never from its
          content, and it is hard-clipped — so however many chips arrive, the
          row cannot wrap, grow taller, or push the controls on the right out
          of view. The chip bar measures this box and collapses the remainder
          into "+N filters". */}
      <div className="flex min-w-0 flex-1 items-center overflow-hidden">{centerContent}</div>

      {error && (
        <span className="truncate text-xs text-[var(--rcd-status-critical)]" title={error}>
          {error}
        </span>
      )}

      {onApplyBookmark && (bookmarks.length > 0 || canManageBookmarks) && (
        <BookmarksMenu
          bookmarks={bookmarks}
          lastAppliedId={lastAppliedBookmarkId}
          canManage={canManageBookmarks}
          onApply={onApplyBookmark}
          onAdd={onAddBookmark}
          onUpdate={onUpdateBookmark}
          onRename={onRenameBookmark}
          onDelete={onDeleteBookmark}
        />
      )}

      {onChangeViewFit && (
        <ViewMenu viewFit={viewFit} isEdit={mode === 'edit'} onChange={onChangeViewFit} />
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
        <RcdIconButton
          aria-label="Export as PDF"
          title="Export as PDF (print)"
          onClick={onExport}
          className="shrink-0"
        >
          <Printer size={14} />
        </RcdIconButton>
      )}

      {onRefresh && (
        <>
          {lastRefreshAt && <LastRefreshCaption at={lastRefreshAt} />}
          <RcdIconButton
            aria-label="Refresh tiles"
            title="Refresh tiles"
            onClick={onRefresh}
            className="shrink-0"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} />
          </RcdIconButton>
        </>
      )}

      {alertFirings !== undefined && <AlertsBell firings={alertFirings ?? []} />}

      {extraActions}

      {overflowItems.length > 0 && <OverflowMenu items={overflowItems} />}

      {onShare && (
        <RcdButton onClick={onShare} className="shrink-0">
          <Share2 size={14} />
          Share
        </RcdButton>
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
              {onUndo && (
                <RcdIconButton
                  aria-label="Undo"
                  title="Undo (Ctrl+Z)"
                  disabled={!canUndo}
                  onClick={onUndo}
                  className="shrink-0"
                >
                  <Undo2 size={14} />
                </RcdIconButton>
              )}
              {onRedo && (
                <RcdIconButton
                  aria-label="Redo"
                  title="Redo (Ctrl+Y)"
                  disabled={!canRedo}
                  onClick={onRedo}
                  className="shrink-0"
                >
                  <Redo2 size={14} />
                </RcdIconButton>
              )}
              {onToggleMobileLayout && (
                <RcdIconButton
                  aria-label={mobileLayoutOpen ? 'Back to the desktop layout' : 'Edit the mobile layout'}
                  title="Mobile layout"
                  aria-pressed={mobileLayoutOpen}
                  onClick={onToggleMobileLayout}
                  className={mobileLayoutOpen ? 'bg-black/5 text-[var(--rcd-accent-interactive)] dark:bg-white/10' : ''}
                >
                  <Smartphone size={14} />
                </RcdIconButton>
              )}
              {onConfigureFilterIndicator && (
                <RcdIconButton
                  aria-label="Filters and indicator settings"
                  title="Filters & indicator (scope + how active filters are shown)"
                  aria-haspopup="dialog"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    onConfigureFilterIndicator({ x: rect.left, y: rect.bottom + 4 });
                  }}
                >
                  <Highlighter size={14} />
                </RcdIconButton>
              )}
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
              {canAddTiles && (
                <AddTileMenu
                  onAddChart={onAddChart}
                  onAddText={onAddText}
                  onAddImage={onAddImage}
                  onAddSlicer={onAddSlicer}
                  addSlicerDisabled={addSlicerDisabled ?? false}
                  onManageParameters={onManageParameters}
                />
              )}
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

/** "3:41 PM" today, "Mon 3:41 PM" this week, else a short date. */
const formatFiredAt = (iso: string): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const ageMs = Date.now() - at.getTime();
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (ageMs < 86_400_000) return time;
  if (ageMs < 7 * 86_400_000) {
    return `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }
  return at.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/**
 * Alerts bell: badge shows the recent-firings count; the dropdown lists the
 * firings (name, time, value vs threshold). Same card pattern as AddTileMenu
 * (outside click / Escape closes, no portal — the toolbar is untransformed).
 */
function AlertsBell({ firings }: { firings: AlertFiring[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <RcdIconButton
        aria-label={
          firings.length > 0 ? `Alerts (${firings.length} recent firings)` : 'Alerts (no recent firings)'
        }
        title="Alert firings"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={open ? 'bg-black/5 text-rcd-text dark:bg-white/10' : ''}
      >
        <Bell size={14} />
      </RcdIconButton>
      {firings.length > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-[var(--rcd-status-warn)] px-1 text-[10px] font-semibold leading-none text-white"
        >
          {firings.length}
        </span>
      )}

      {open && (
        <div
          role="menu"
          aria-label="Recent alert firings"
          className="absolute right-0 top-full z-40 mt-1 w-72 rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
        >
          {firings.length === 0 ? (
            <p className="px-3 py-1.5 text-xs text-rcd-muted">No recent alert firings.</p>
          ) : (
            firings.map((firing, index) => (
              <div key={`${firing.alertId}-${firing.firedAtUtc}-${index}`} className="px-3 py-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-sm text-rcd-text" title={firing.alertName}>
                    {firing.alertName}
                  </span>
                  <span className="shrink-0 text-[11px] text-rcd-muted">
                    {formatFiredAt(firing.firedAtUtc)}
                  </span>
                </div>
                <p className="text-xs text-rcd-text-2">
                  Value {firing.value === null ? 'n/a' : firing.value.toLocaleString()} (threshold{' '}
                  {firing.threshold.toLocaleString()})
                </p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The View menu (Power BI's View > page-sizing options): Actual size vs Fit
 * to page, with a check on the active option. In VIEW mode picking an option
 * is a transient per-session choice; in EDIT mode it writes the dashboard's
 * persisted default (`defaultViewFit`, saved with the layout) — the caption
 * under the items says so. Same card pattern as AddTileMenu; the trigger gets
 * pressed styling while the page is fitted so the state reads at a glance.
 */
function ViewMenu({
  viewFit,
  isEdit,
  onChange,
}: {
  viewFit: ViewFitMode;
  isEdit: boolean;
  onChange: (fit: ViewFitMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const pick = (fit: ViewFitMode) => {
    setOpen(false);
    onChange(fit);
  };

  const options: { fit: ViewFitMode; icon: ReactNode; label: string }[] = [
    { fit: 'actual', icon: <Maximize size={14} />, label: 'Actual size' },
    { fit: 'fitPage', icon: <Shrink size={14} />, label: 'Fit to page' },
  ];

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <RcdIconButton
        aria-label="View size"
        title={isEdit ? 'View size (default for viewers)' : 'View size'}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          open || viewFit === 'fitPage' ? 'bg-black/5 text-rcd-text dark:bg-white/10' : ''
        }
      >
        <Scan size={14} />
      </RcdIconButton>

      {open && (
        <div
          role="menu"
          aria-label="View size"
          className="absolute right-0 top-full z-40 mt-1 w-48 rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
        >
          {options.map((option) => (
            <button
              key={option.fit}
              type="button"
              role="menuitemradio"
              aria-checked={viewFit === option.fit}
              onClick={() => pick(option.fit)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
            >
              <span className="w-3.5 shrink-0">
                {viewFit === option.fit && <Check size={14} className="text-rcd-accent" />}
              </span>
              <span aria-hidden className="shrink-0 text-rcd-muted">
                {option.icon}
              </span>
              {option.label}
            </button>
          ))}
          <p className="border-t border-rcd-border px-3 pb-0.5 pt-1.5 text-[11px] leading-snug text-rcd-muted">
            {isEdit
              ? 'Saved as the viewer default. Dashboards open in Fit to page unless set to Actual size.'
              : 'Fit to page scales the page to fit without scrolling.'}
          </p>
        </div>
      )}
    </div>
  );
}

/** One entry of the toolbar's overflow ⋯ menu. */
interface OverflowItem {
  key: string;
  icon: ReactNode;
  label: string;
  /** Critical styling (Delete / Remove from my list). */
  danger?: boolean;
  onClick: () => void;
}

/**
 * Overflow "⋯" menu (both modes): hosts the less-frequent actions so the
 * toolbar stays uncrowded — Subscribe, Activity, Linked model, Make a copy,
 * Delete / Remove from my list. Same card pattern as AddTileMenu. Danger
 * items sink to the bottom behind a divider.
 */
function OverflowMenu({ items }: { items: OverflowItem[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const plain = items.filter((item) => !item.danger);
  const danger = items.filter((item) => item.danger);

  const renderItem = (item: OverflowItem) => (
    <button
      key={item.key}
      type="button"
      role="menuitem"
      onClick={() => {
        setOpen(false);
        item.onClick();
      }}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10 ${
        item.danger ? 'text-[var(--rcd-status-critical)]' : 'text-rcd-text'
      }`}
    >
      {item.icon}
      {item.label}
    </button>
  );

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <RcdIconButton
        aria-label="More actions"
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={open ? 'bg-black/5 text-rcd-text dark:bg-white/10' : ''}
      >
        <MoreHorizontal size={14} />
      </RcdIconButton>

      {open && (
        <div
          role="menu"
          aria-label="More actions"
          className="absolute right-0 top-full z-40 mt-1 w-52 rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
        >
          {plain.map(renderItem)}
          {plain.length > 0 && danger.length > 0 && (
            <div className="my-1 border-t border-rcd-border" />
          )}
          {danger.map(renderItem)}
        </div>
      )}
    </div>
  );
}

/**
 * The Bookmarks affordance: a bookmark icon button opening a menu card listing
 * saved bookmarks (click = apply; a check marks the last-applied one until the
 * view diverges). Editors additionally get a per-row kebab (update to current
 * view / rename / delete) and a footer "add from current view"; viewers are
 * apply-only. Same card pattern as AddTileMenu: outside click / Escape closes,
 * no portal needed (the toolbar sits in untransformed flow).
 */
function BookmarksMenu({
  bookmarks,
  lastAppliedId,
  canManage,
  onApply,
  onAdd,
  onUpdate,
  onRename,
  onDelete,
}: {
  bookmarks: ToolbarBookmark[];
  lastAppliedId: string | null;
  canManage: boolean;
  onApply: (id: string) => void;
  onAdd?: (name: string) => void;
  onUpdate?: (id: string) => void;
  onRename?: (id: string, name: string) => void;
  onDelete?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Bookmark id whose row kebab menu is open. */
  const [kebabFor, setKebabFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<ToolbarBookmark | null>(null);

  // Close on outside click / Escape (suspended while the delete confirm owns
  // the keyboard — it renders inside rootRef, so its clicks stay "inside").
  useEffect(() => {
    if (!open || confirmDelete !== null) return;
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
  }, [open, confirmDelete]);

  // Transient row state resets whenever the card closes.
  useEffect(() => {
    if (open) return;
    setKebabFor(null);
    setRenaming(null);
    setAdding(false);
    setAddName('');
  }, [open]);

  const commitRename = () => {
    if (!renaming) return;
    const next = renaming.draft.trim();
    if (next !== '') onRename?.(renaming.id, next);
    setRenaming(null);
  };

  const commitAdd = () => {
    const name = addName.trim();
    if (name === '') return;
    onAdd?.(name);
    setAdding(false);
    setAddName('');
  };

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <RcdIconButton
        aria-label="Bookmarks"
        title="Bookmarks"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={open ? 'bg-black/5 text-rcd-text dark:bg-white/10' : ''}
      >
        <Bookmark size={14} />
      </RcdIconButton>

      {open && (
        <div
          role="menu"
          aria-label="Bookmarks"
          className="absolute right-0 top-full z-40 mt-1 w-60 rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
        >
          {bookmarks.length === 0 && (
            <p className="px-3 py-1.5 text-xs text-rcd-muted">No bookmarks yet.</p>
          )}

          {bookmarks.map((bookmark) =>
            renaming?.id === bookmark.id ? (
              <div key={bookmark.id} className="px-2 py-1">
                <RcdInput
                  value={renaming.draft}
                  onChange={(event) => setRenaming({ id: bookmark.id, draft: event.target.value })}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename();
                    if (event.key === 'Escape') setRenaming(null);
                  }}
                  aria-label={`Rename bookmark ${bookmark.name}`}
                  autoFocus
                  onFocus={(event) => event.target.select()}
                  className="w-full"
                />
              </div>
            ) : (
              <div key={bookmark.id} className="relative flex items-center pr-1">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onApply(bookmark.id);
                    setOpen(false);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <span className="w-3.5 shrink-0">
                    {lastAppliedId === bookmark.id && <Check size={14} className="text-rcd-accent" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={bookmark.name}>
                    {bookmark.name}
                  </span>
                </button>
                {canManage && (
                  <RcdIconButton
                    aria-label={`Actions for bookmark ${bookmark.name}`}
                    title="Bookmark actions"
                    aria-haspopup="menu"
                    aria-expanded={kebabFor === bookmark.id}
                    onClick={() => setKebabFor((id) => (id === bookmark.id ? null : bookmark.id))}
                  >
                    <MoreVertical size={13} />
                  </RcdIconButton>
                )}
                {kebabFor === bookmark.id && (
                  <div
                    role="menu"
                    className="absolute right-1 top-full z-50 w-44 rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setKebabFor(null);
                        onUpdate?.(bookmark.id);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      <RefreshCw size={13} />
                      Update to current view
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setKebabFor(null);
                        setRenaming({ id: bookmark.id, draft: bookmark.name });
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      <Pencil size={13} />
                      Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setKebabFor(null);
                        setConfirmDelete(bookmark);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--rcd-status-critical)] hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      <Trash2 size={13} />
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ),
          )}

          {canManage && onAdd && (
            <>
              <div className="my-1 border-t border-rcd-border" />
              {adding ? (
                <div className="flex items-center gap-1.5 px-2 py-1">
                  <RcdInput
                    value={addName}
                    onChange={(event) => setAddName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitAdd();
                      if (event.key === 'Escape') {
                        setAdding(false);
                        setAddName('');
                      }
                    }}
                    placeholder="Bookmark name"
                    aria-label="New bookmark name"
                    autoFocus
                    className="min-w-0 flex-1"
                  />
                  <RcdButton variant="primary" disabled={addName.trim() === ''} onClick={commitAdd}>
                    Add
                  </RcdButton>
                </div>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setAdding(true)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <Plus size={14} />
                  Add bookmark from current view
                </button>
              )}
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        title="Delete bookmark"
        message={
          confirmDelete
            ? `Delete bookmark "${confirmDelete.name}"? Removed from the dashboard (kept until you save).`
            : ''
        }
        confirmLabel="Delete"
        danger
        open={confirmDelete !== null}
        onConfirm={() => {
          if (confirmDelete) onDelete?.(confirmDelete.id);
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
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
  onManageParameters,
}: {
  onAddChart: () => void;
  onAddText: () => void;
  onAddImage: () => void;
  onAddSlicer: () => void;
  addSlicerDisabled: boolean;
  onManageParameters?: () => void;
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
          className="absolute right-0 top-full z-40 mt-1 w-40 rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
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
          {onManageParameters && (
            <>
              <div className="my-1 border-t border-rcd-border" />
              <AddMenuItem onClick={() => pick(onManageParameters)}>
                <Variable size={14} />
                Field parameter…
              </AddMenuItem>
            </>
          )}
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
