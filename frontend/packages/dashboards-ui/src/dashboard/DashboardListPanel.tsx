import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Copy,
  LayoutDashboard,
  Lock,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
  UserMinus,
  Users,
} from 'lucide-react';
import { dashboardAccessOf, rcdErrorMessage, type DashboardSummary } from '@recon/dashboards-core';
import { useDashboardState, useModelState, useRuntime } from '../provider/DashboardsProvider';
import {
  ConfirmDialog,
  RcdButton,
  RcdDialog,
  RcdIconButton,
  RcdInput,
  RcdSelect,
  RcdSpinner,
} from '../primitives';

export interface DashboardListPanelProps {
  onOpen: (id: number) => void;
  /** Called after a successful create (typically navigates into edit). */
  onCreated?: (id: number) => void;
}

const updatedFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const formatUpdated = (iso: string): string => {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : updatedFormat.format(parsed);
};

const messageOf = (error: unknown): string => rcdErrorMessage(error);

/** Own + shared dashboards with create/duplicate/delete. */
export function DashboardListPanel({ onOpen, onCreated }: DashboardListPanelProps) {
  const runtime = useRuntime();

  const list = useDashboardState((state) => state.list);
  const listStatus = useDashboardState((state) => state.listStatus);
  const listError = useDashboardState((state) => state.error);
  const saveStatus = useDashboardState((state) => state.saveStatus);
  const saveError = useDashboardState((state) => state.error);

  const models = useModelState((state) => state.models);
  const modelsStatus = useModelState((state) => state.modelsStatus);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [modelChoice, setModelChoice] = useState('');
  const [pendingDelete, setPendingDelete] = useState<DashboardSummary | null>(null);
  const [pendingLeave, setPendingLeave] = useState<DashboardSummary | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * Sections: my dashboards, dashboards shared with me by name, and published
   * ("Everyone") content — built-ins land in Everyone. Pre-0.8 servers send no
   * myAccess, so dashboardAccessOf routes their non-owned rows to Everyone.
   */
  const sections = useMemo(() => {
    const mine: DashboardSummary[] = [];
    const sharedWithMe: DashboardSummary[] = [];
    const everyone: DashboardSummary[] = [];
    for (const dashboard of list) {
      if (dashboard.ownerIsMe) mine.push(dashboard);
      else if (dashboardAccessOf(dashboard).viaShare) sharedWithMe.push(dashboard);
      else everyone.push(dashboard);
    }
    return [
      { key: 'mine', label: 'Mine', rows: mine },
      { key: 'shared', label: 'Shared with me', rows: sharedWithMe },
      { key: 'everyone', label: 'Everyone', rows: everyone },
    ].filter((section) => section.rows.length > 0);
  }, [list]);

  useEffect(() => {
    void runtime.dashboards.loadList();
    void runtime.models.loadModels();
  }, [runtime]);

  const modelName = (modelId: number | null): string => {
    if (modelId === null) return '—';
    return models.find((model) => model.id === modelId)?.name ?? `Model #${modelId}`;
  };

  const openCreate = () => {
    setName('');
    setModelChoice('');
    setCreateOpen(true);
  };

  const creating = saveStatus === 'loading';

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = await runtime.dashboards.create(trimmed, modelChoice ? Number(modelChoice) : null);
    if (id !== null) {
      setCreateOpen(false);
      onCreated?.(id);
    }
  };

  const handleDuplicate = async (dashboard: DashboardSummary) => {
    setBusyId(dashboard.id);
    setActionError(null);
    try {
      await runtime.api.duplicateDashboard(dashboard.id);
      await runtime.dashboards.loadList();
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (dashboard: DashboardSummary) => {
    setPendingDelete(null);
    setBusyId(dashboard.id);
    setActionError(null);
    try {
      await runtime.api.deleteDashboard(dashboard.id);
      await runtime.dashboards.loadList();
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setBusyId(null);
    }
  };

  /** "Remove from my list": drops only the caller's share row. */
  const handleLeave = async (dashboard: DashboardSummary) => {
    setPendingLeave(null);
    setBusyId(dashboard.id);
    setActionError(null);
    try {
      await runtime.dashboards.leave(dashboard.id);
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-rcd-bg">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold text-rcd-text">Dashboards</h1>
          <RcdButton variant="primary" onClick={openCreate}>
            <Plus size={14} />
            New dashboard
          </RcdButton>
        </div>

        {actionError && (
          <p className="text-sm text-[var(--rcd-status-critical)]" role="alert">
            {actionError}
          </p>
        )}

        {listStatus === 'loading' && list.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <RcdSpinner label="Loading dashboards…" />
          </div>
        ) : listStatus === 'error' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <AlertTriangle size={24} className="text-[var(--rcd-status-warn)]" />
            <p className="max-w-md text-sm text-rcd-text-2">{listError ?? 'Failed to load dashboards.'}</p>
            <RcdButton onClick={() => void runtime.dashboards.loadList()}>
              <RefreshCw size={14} />
              Retry
            </RcdButton>
          </div>
        ) : list.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--rcd-accent)_10%,transparent)]">
              <LayoutDashboard size={28} className="text-rcd-accent" />
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-rcd-text">No dashboards yet</p>
              <p className="text-sm text-rcd-muted">
                Create one, attach a model, and start dropping in charts.
              </p>
            </div>
            <RcdButton variant="primary" onClick={openCreate}>
              <Plus size={14} />
              Create your first dashboard
            </RcdButton>
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.key} className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-rcd-muted">
                {section.label}
              </h2>
              <div className="rcd-card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-rcd-border text-left text-xs uppercase tracking-wide text-rcd-muted">
                        <th className="px-3 py-2 font-medium">Name</th>
                        <th className="px-3 py-2 font-medium">Model</th>
                        <th className="px-3 py-2 font-medium">Sharing</th>
                        <th className="px-3 py-2 font-medium">Updated</th>
                        <th className="px-3 py-2" aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {section.rows.map((dashboard) => {
                        const access = dashboardAccessOf(dashboard);
                        const shareCount = dashboard.shareCount ?? 0;
                        return (
                          <tr
                            key={dashboard.id}
                            className="cursor-pointer border-b border-rcd-border last:border-b-0 hover:bg-black/5 dark:hover:bg-white/10"
                            onClick={() => onOpen(dashboard.id)}
                          >
                            <td className="px-3 py-2.5 font-medium text-rcd-text">
                              {dashboard.name}
                            </td>
                            <td className="px-3 py-2.5 text-rcd-text-2">
                              {modelName(dashboard.modelId)}
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex flex-wrap items-center gap-1">
                                {dashboard.isSystem && (
                                  <span
                                    className="inline-flex items-center gap-1 rounded-md border border-rcd-border px-2 py-0.5 text-[11px] font-medium text-rcd-text-2"
                                    title="Built-in content managed by the application. Make a copy to edit it."
                                  >
                                    <Lock size={11} />
                                    Built-in
                                  </span>
                                )}
                                {dashboard.ownerIsMe && shareCount > 0 && (
                                  <span
                                    className="inline-flex items-center gap-1 rounded-md border border-rcd-border px-2 py-0.5 text-[11px] font-medium text-rcd-text-2"
                                    title={`Shared with ${shareCount} ${shareCount === 1 ? 'person' : 'people'}`}
                                  >
                                    <Users size={11} />
                                    {shareCount}
                                  </span>
                                )}
                                {dashboard.isShared && (
                                  <span
                                    className="inline-flex items-center gap-1 rounded-md border border-rcd-border px-2 py-0.5 text-[11px] font-medium text-rcd-text-2"
                                    title="Published: visible to everyone"
                                  >
                                    <Share2 size={11} />
                                    Everyone
                                  </span>
                                )}
                                {!dashboard.ownerIsMe && dashboard.ownerDisplayName && (
                                  <span className="text-[11px] text-rcd-muted">
                                    by {dashboard.ownerDisplayName}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-rcd-text-2 tabular-nums">
                              {formatUpdated(dashboard.updatedAtUtc)}
                            </td>
                            <td className="px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                              <div className="flex items-center justify-end gap-1">
                                <RcdIconButton
                                  aria-label={`Make a copy of ${dashboard.name}`}
                                  title="Make a copy"
                                  disabled={busyId === dashboard.id}
                                  onClick={() => void handleDuplicate(dashboard)}
                                >
                                  <Copy size={15} />
                                </RcdIconButton>
                                {!dashboard.ownerIsMe && access.viaShare && (
                                  <RcdIconButton
                                    aria-label={`Remove ${dashboard.name} from my list`}
                                    title="Remove from my list"
                                    disabled={busyId === dashboard.id}
                                    onClick={() => setPendingLeave(dashboard)}
                                  >
                                    <UserMinus size={15} />
                                  </RcdIconButton>
                                )}
                                {dashboard.ownerIsMe && !dashboard.isSystem && (
                                  <RcdIconButton
                                    aria-label={`Delete ${dashboard.name}`}
                                    title="Delete"
                                    disabled={busyId === dashboard.id}
                                    onClick={() => setPendingDelete(dashboard)}
                                  >
                                    <Trash2 size={15} />
                                  </RcdIconButton>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <RcdDialog
        title="New dashboard"
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <RcdButton onClick={() => setCreateOpen(false)}>Cancel</RcdButton>
            <RcdButton
              variant="primary"
              disabled={!name.trim() || creating}
              onClick={() => void handleCreate()}
            >
              {creating ? 'Creating…' : 'Create'}
            </RcdButton>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
            Name
            <RcdInput
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Quarterly ops review"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
            Model
            <RcdSelect value={modelChoice} onChange={(event) => setModelChoice(event.target.value)}>
              <option value="">No model (attach later)</option>
              {models.map((model) => (
                <option key={model.id} value={String(model.id)}>
                  {model.name}
                </option>
              ))}
            </RcdSelect>
            {modelsStatus === 'loading' && (
              <span className="text-xs text-rcd-muted">Loading models…</span>
            )}
            {modelsStatus === 'error' && (
              <span className="text-xs text-[var(--rcd-status-critical)]">
                Could not load models — you can attach one later.
              </span>
            )}
          </label>
          {saveStatus === 'error' && saveError && (
            <p className="text-xs text-[var(--rcd-status-critical)]" role="alert">
              {saveError}
            </p>
          )}
        </div>
      </RcdDialog>

      <ConfirmDialog
        title="Delete dashboard"
        message={
          pendingDelete
            ? `Delete "${pendingDelete.name}"? This cannot be undone.`
            : 'Delete this dashboard?'
        }
        confirmLabel="Delete"
        danger
        open={pendingDelete !== null}
        onConfirm={() => pendingDelete && void handleDelete(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        title="Remove from my list"
        message={
          pendingLeave
            ? `Remove "${pendingLeave.name}" from your list? Only your access is removed — the dashboard itself is untouched.`
            : 'Remove this dashboard from your list?'
        }
        confirmLabel="Remove"
        danger
        open={pendingLeave !== null}
        onConfirm={() => pendingLeave && void handleLeave(pendingLeave)}
        onCancel={() => setPendingLeave(null)}
      />
    </div>
  );
}
