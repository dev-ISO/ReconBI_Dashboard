import { useState } from 'react';
import { Pencil, Plus, RefreshCw, Share2, SlidersHorizontal } from 'lucide-react';
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
  onAddSlicer: () => void;
  /** Disables Add slicer (no model attached). */
  addSlicerDisabled?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** View-mode auto-refresh interval (persisted with the layout); null = off. */
  refreshSeconds?: number | null;
  /** Edit-mode change of the auto-refresh interval. */
  onChangeRefreshSeconds?: (seconds: number | null) => void;
  /** Manual "refresh all tiles now" (both modes). */
  onRefresh?: () => void;
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
  onAddSlicer,
  addSlicerDisabled,
  onSave,
  onDiscard,
  refreshSeconds = null,
  onChangeRefreshSeconds,
  onRefresh,
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

      {onRefresh && (
        <RcdIconButton aria-label="Refresh tiles" title="Refresh tiles" onClick={onRefresh}>
          <RefreshCw size={14} />
        </RcdIconButton>
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
              <RcdButton onClick={onAddChart}>
                <Plus size={14} />
                Add chart
              </RcdButton>
              <RcdButton
                onClick={onAddSlicer}
                disabled={addSlicerDisabled}
                title={addSlicerDisabled ? 'Attach a model to add slicers' : undefined}
              >
                <SlidersHorizontal size={14} />
                Add slicer
              </RcdButton>
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
