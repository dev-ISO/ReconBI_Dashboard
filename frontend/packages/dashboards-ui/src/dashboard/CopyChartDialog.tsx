import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, LayoutDashboard, Sigma } from 'lucide-react';
import {
  dashboardAccessOf,
  rcdErrorMessage,
  type ChartSpec,
  type DashboardSummary,
} from '@recon/dashboards-core';
import { useDashboardState, useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdDialog, RcdSpinner } from '../primitives';

export interface CopyChartDialogProps {
  open: boolean;
  /** The AUTHORED chart spec to copy (never a drilled/filtered effective spec). */
  chart: ChartSpec | null;
  /** Model id of the SOURCE dashboard (model-mismatch warning). */
  sourceModelId: number | null;
  /** The open dashboard — marked "(this dashboard)" in the target list. */
  currentDashboardId: number;
  onClose: () => void;
}

/** A dashboard the caller may add charts to (owner or charts-class grant). */
const isWritableTarget = (row: DashboardSummary): boolean =>
  !(row.isSystem ?? false) && (row.ownerIsMe || dashboardAccessOf(row).canEditCharts);

type Phase = 'pick' | 'copying' | 'done';

/**
 * "Copy chart to…": clones one authored chart onto a writable dashboard.
 * Offered to every viewer — that is the point: a built-in dashboard's charts
 * are cloneable onto the caller's own dashboards even though the built-in
 * itself is read-only. Copying to the CURRENT dashboard appends in-store
 * (honoring an active edit session); other targets round-trip the server via
 * the store's copyChartToDashboard.
 */
export function CopyChartDialog({
  open,
  chart,
  sourceModelId,
  currentDashboardId,
  onClose,
}: CopyChartDialogProps) {
  const runtime = useRuntime();
  const list = useDashboardState((state) => state.list);
  const listStatus = useDashboardState((state) => state.listStatus);
  const mode = useDashboardState((state) => state.mode);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('pick');
  const [error, setError] = useState<string | null>(null);
  const [doneTarget, setDoneTarget] = useState<string | null>(null);

  // Fresh target list (and clean state) on each open.
  useEffect(() => {
    if (!open) return;
    setSelectedId(null);
    setPhase('pick');
    setError(null);
    setDoneTarget(null);
    void runtime.dashboards.loadList();
  }, [open, runtime]);

  // The CURRENT dashboard is a valid target only during an edit session: the
  // same-dashboard path appends to the IN-MEMORY draft, and view mode has no
  // Save affordance — the copy looked successful, then silently evaporated on
  // close. Other targets round-trip the server and are safe from any mode.
  const targets = useMemo(
    () =>
      list.filter(
        (row) => isWritableTarget(row) && (mode === 'edit' || row.id !== currentDashboardId),
      ),
    [list, mode, currentDashboardId],
  );
  const selected = targets.find((t) => t.id === selectedId) ?? null;
  const modelMismatch = selected !== null && selected.modelId !== sourceModelId;
  // Scoped (dashboard/personal) measures the chart cites travel WITH it — say
  // how many, because they land in the target dashboard as its own measures
  // and that is a real edit to somebody else's dashboard.
  const measureCarryCount = useMemo(
    () => (chart ? runtime.dashboards.measureCarryCount(chart) : 0),
    [chart, runtime],
  );

  const copy = async () => {
    if (!chart || selected === null) return;
    setPhase('copying');
    setError(null);
    try {
      await runtime.dashboards.copyChartToDashboard(selected.id, chart, sourceModelId);
      setDoneTarget(selected.name);
      setPhase('done');
    } catch (err) {
      setPhase('pick');
      setError(rcdErrorMessage(err));
    }
  };

  const loading = listStatus === 'loading' && list.length === 0;

  return (
    <RcdDialog
      title="Copy chart to…"
      open={open}
      onClose={onClose}
      footer={
        phase === 'done' ? (
          <RcdButton variant="primary" onClick={onClose}>
            Done
          </RcdButton>
        ) : (
          <>
            <RcdButton onClick={onClose} disabled={phase === 'copying'}>
              Cancel
            </RcdButton>
            <RcdButton
              variant="primary"
              disabled={selected === null || phase === 'copying' || chart === null}
              onClick={() => void copy()}
            >
              {phase === 'copying' ? 'Copying…' : 'Copy chart'}
            </RcdButton>
          </>
        )
      }
    >
      {phase === 'done' ? (
        <div className="flex items-start gap-2 py-2">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-[var(--rcd-status-good)]" />
          <p className="text-sm text-rcd-text">
            “{chart?.title || 'Chart'}” was copied to <span className="font-medium">{doneTarget}</span>
            {selectedId === currentDashboardId ? ' (this dashboard)' : ''}.
            {selectedId === currentDashboardId
              ? ' It was appended to the current page.'
              : ' Open that dashboard to see it.'}
          </p>
        </div>
      ) : loading ? (
        <div className="flex h-24 items-center justify-center">
          <RcdSpinner label="Loading dashboards…" />
        </div>
      ) : targets.length === 0 ? (
        <p className="text-sm text-rcd-muted">
          No dashboard you can add charts to. Create a dashboard first, or ask for edit access.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-rcd-text-2">
            Copy <span className="font-medium">“{chart?.title || 'this chart'}”</span> to:
          </p>
          <div
            role="listbox"
            aria-label="Target dashboard"
            className="max-h-64 overflow-y-auto rounded-lg border border-rcd-border"
          >
            {targets.map((target) => {
              const isSelected = target.id === selectedId;
              const mismatched = target.modelId !== sourceModelId;
              return (
                <button
                  key={target.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => setSelectedId(target.id)}
                  className={`flex w-full items-center gap-2 border-b border-rcd-border px-2.5 py-1.5 text-left last:border-b-0 ${
                    isSelected ? 'bg-black/5 dark:bg-white/10' : 'hover:bg-black/5 dark:hover:bg-white/10'
                  }`}
                >
                  <LayoutDashboard size={14} aria-hidden className="shrink-0 text-rcd-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm text-rcd-text">
                    {target.name}
                    {target.id === currentDashboardId && (
                      <span className="text-rcd-muted"> (this dashboard)</span>
                    )}
                  </span>
                  {mismatched && (
                    <AlertTriangle
                      size={13}
                      aria-label="Built on a different model"
                      className="shrink-0 text-[var(--rcd-status-warn)]"
                    />
                  )}
                  {isSelected && <Check size={14} className="shrink-0 text-rcd-accent" aria-hidden />}
                </button>
              );
            })}
          </div>

          {measureCarryCount > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-rcd-text-2">
              <Sigma size={13} aria-hidden className="mt-[1px] shrink-0 text-rcd-muted" />
              <span>
                {measureCarryCount === 1
                  ? '1 measure this chart uses belongs to this dashboard and will be copied across too.'
                  : `${measureCarryCount} measures this chart uses belong to this dashboard and will be copied across too.`}
              </span>
            </p>
          )}

          {modelMismatch && (
            <p className="flex items-start gap-1.5 text-xs text-[var(--rcd-status-warn)]" role="alert">
              <AlertTriangle size={13} aria-hidden className="mt-[1px] shrink-0" />
              <span>
                “{selected!.name}” is built on a different model — the copied chart’s fields may
                not resolve there.
              </span>
            </p>
          )}

          {error && (
            <p className="text-xs text-[var(--rcd-status-critical)]" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </RcdDialog>
  );
}
