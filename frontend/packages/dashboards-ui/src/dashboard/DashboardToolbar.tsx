import { useState } from 'react';
import { Pencil, Plus, Share2, SlidersHorizontal } from 'lucide-react';
import { ConfirmDialog, RcdButton } from '../primitives';

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
}

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

      {mode === 'view'
        ? !readonly && (
            <RcdButton onClick={onEnterEdit}>
              <Pencil size={14} />
              Edit
            </RcdButton>
          )
        : !readonly && (
            <>
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
