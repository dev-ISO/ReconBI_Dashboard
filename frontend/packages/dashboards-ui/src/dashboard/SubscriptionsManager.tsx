import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Eye,
  FlaskConical,
  History,
  Pencil,
  RefreshCw,
  Send,
  Trash2,
} from 'lucide-react';
import type {
  AlertOperator,
  DashboardAlert,
  DashboardSubscription,
  DispatchLiveProgress,
  DispatchRecipientStatus,
  SubscriptionDispatch,
  SubscriptionOptOut,
} from '@recon/dashboards-core';
import { rcdErrorMessage } from '@recon/dashboards-core';
import { useDashboardState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdDialog, RcdIconButton, RcdInput, RcdSelect, RcdSpinner } from '../primitives';
import { DeliveryBadge, EnabledToggle, formatInstant } from './deliveryBadge';
import {
  looksLikeEmail,
  parseRecipients,
  scheduleSummary,
  SubscriptionEditorDialog,
} from './SubscriptionsDialog';
import { SubscriptionPreviewDialog, type SubscriptionPreviewRequest } from './SubscriptionPreviewDialog';

export interface SubscriptionsManagerProps {
  open: boolean;
  onClose: () => void;
  /** Failures surface through the host page's transient notice chip. */
  onError: (message: string) => void;
  initialTab?: 'subscriptions' | 'alerts';
}

const OPERATOR_SYMBOL: Record<AlertOperator, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
};

/** "value > 10 every 1h" — the Alerts tab's measure/condition summary. */
export const alertConditionText = (alert: DashboardAlert): string => {
  const spec = alert.spec as { measures?: { alias?: string | null; measureId?: string | null; column?: string | null }[] };
  const measure = spec.measures?.[0];
  const subject = measure?.alias ?? measure?.measureId ?? measure?.column ?? 'value';
  const cadence =
    alert.everyMinutes >= 60 ? `${alert.everyMinutes / 60}h` : `${alert.everyMinutes}m`;
  return `${subject} ${OPERATOR_SYMBOL[alert.operator]} ${alert.threshold.toLocaleString()} · every ${cadence}`;
};

const recipientCountOf = (recipients: string): number =>
  recipients.split(';').filter((email) => email.trim() !== '').length;

const RECIPIENT_TONES: Record<DispatchRecipientStatus, string> = {
  sent: 'text-[var(--rcd-status-ok,#059669)] border-rcd-border',
  failed: 'text-[var(--rcd-status-critical)] border-[var(--rcd-status-critical)]',
  optedOut: 'text-rcd-muted border-rcd-border line-through',
  pending: 'text-rcd-text-2 border-rcd-border',
};

const RECIPIENT_LABELS: Record<DispatchRecipientStatus, string> = {
  sent: 'sent',
  failed: 'failed',
  optedOut: 'opted out',
  pending: 'sending…',
};

/**
 * Live per-recipient progress strip under a subscription row during Send now
 * (or a scheduled send the host forwards events for). Renders from the
 * runtime's dispatchProgress slice when the host bridge feeds it; otherwise
 * from the 2s polling fallback the manager runs while a send is watched.
 */
function ProgressStrip({
  live,
  polledDispatch,
}: {
  live: DispatchLiveProgress | null;
  polledDispatch: SubscriptionDispatch | null;
}) {
  // Event-driven state wins (it is fresher than the last poll).
  const rows: { email: string; status: DispatchRecipientStatus; attempts: number; error: string | null }[] =
    live !== null
      ? Object.entries(live.recipients).map(([email, r]) => ({ email, ...r }))
      : (polledDispatch?.recipients ?? []).map((r) => ({
          email: r.email,
          status: r.status,
          attempts: r.attempts,
          error: r.error,
        }));
  const status = live?.status ?? polledDispatch?.status ?? 'running';
  const done = rows.filter((r) => r.status !== 'pending').length;
  const total =
    live?.recipientCount ?? polledDispatch?.recipients.length ?? rows.length;

  return (
    <div className="mt-1 rounded-md border border-rcd-border bg-rcd-surface-2 px-2.5 py-1.5">
      <p className="text-[11px] font-medium text-rcd-text-2">
        {status === 'running' ? `Sending — ${done}/${total} recipients resolved` : `Send ${status}`}
      </p>
      {rows.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {rows.map((r) => (
            <span
              key={r.email}
              title={r.error ?? undefined}
              className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${RECIPIENT_TONES[r.status]}`}
            >
              {r.status === 'pending' && (
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              )}
              {r.email} · {RECIPIENT_LABELS[r.status]}
              {r.attempts > 1 ? ` (attempt ${r.attempts})` : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * "Subscriptions & alerts" manager — THE management surface the design wave
 * adds: every subscription and alert the caller owns (or, with manage-shared
 * rights, everyone's), one-click pause, Send now with a live per-recipient
 * progress strip (host realtime bridge, 2s polling fallback), per-send
 * history with per-recipient outcomes and approximate opens, opt-out
 * management, and — for the first time — a findable list of alerts.
 */
export function SubscriptionsManager({ open, onClose, onError, initialTab }: SubscriptionsManagerProps) {
  const runtime = useRuntime();
  const { scheduleTimeZoneId, scheduleTimeLabel } = runtime.options;
  const dashboards = useDashboardState((state) => state.list);
  const dispatchProgress = useDashboardState((state) => state.dispatchProgress);

  const [tab, setTab] = useState<'subscriptions' | 'alerts'>(initialTab ?? 'subscriptions');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [canManageShared, setCanManageShared] = useState(false);
  const [subscriptions, setSubscriptions] = useState<DashboardSubscription[] | null>(null);
  const [alerts, setAlerts] = useState<DashboardAlert[] | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [editSubscription, setEditSubscription] = useState<DashboardSubscription | null>(null);
  const [editAlert, setEditAlert] = useState<DashboardAlert | null>(null);
  const [historyFor, setHistoryFor] = useState<DashboardSubscription | null>(null);
  const [preview, setPreview] = useState<SubscriptionPreviewRequest | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<
    { kind: 'subscription'; row: DashboardSubscription } | { kind: 'alert'; row: DashboardAlert } | null
  >(null);
  const [testResults, setTestResults] = useState<Record<number, string>>({});
  const [globalOptOuts, setGlobalOptOuts] = useState<SubscriptionOptOut[] | null>(null);

  /** Subscriptions with an in-flight send this dialog is watching (Send now / live events). */
  const [watched, setWatched] = useState<Record<number, true>>({});
  const [polled, setPolled] = useState<Record<number, SubscriptionDispatch>>({});
  const progressRef = useRef(dispatchProgress);
  progressRef.current = dispatchProgress;

  const fail = useCallback(
    (prefix: string, error: unknown) => onError(`${prefix}: ${rcdErrorMessage(error)}`),
    [onError],
  );

  const loadSubscriptions = useCallback(async () => {
    try {
      setSubscriptions(
        scope === 'all'
          ? await runtime.api.listAllSubscriptions()
          : await runtime.api.listSubscriptions(),
      );
    } catch (error) {
      setSubscriptions([]);
      fail('Could not load subscriptions', error);
    }
  }, [runtime, scope, fail]);

  const loadAlerts = useCallback(async () => {
    try {
      setAlerts(scope === 'all' ? await runtime.api.listAllAlerts() : await runtime.api.listAlerts());
    } catch (error) {
      setAlerts([]);
      fail('Could not load alerts', error);
    }
  }, [runtime, scope, fail]);

  const loadGlobalOptOuts = useCallback(async () => {
    try {
      setGlobalOptOuts(await runtime.api.listGlobalOptOuts());
    } catch (error) {
      setGlobalOptOuts([]);
      fail('Could not load global opt-outs', error);
    }
  }, [runtime, fail]);

  // Open: reset transient state, learn admin standing, load both tabs once.
  useEffect(() => {
    if (!open) {
      setSubscriptions(null);
      setAlerts(null);
      setWatched({});
      setPolled({});
      setTestResults({});
      setGlobalOptOuts(null);
      setScope('mine');
      setTab(initialTab ?? 'subscriptions');
      setPreview(null);
      return;
    }
    runtime.api
      .getMeta()
      .then((meta) => setCanManageShared(meta.canManageShared))
      .catch(() => setCanManageShared(false));
    // Dashboard names for the Dashboard column come from the store list.
    void runtime.dashboards.loadList();
  }, [open, runtime, initialTab]);

  useEffect(() => {
    if (!open) return;
    setSubscriptions(null);
    setAlerts(null);
    void loadSubscriptions();
    void loadAlerts();
  }, [open, loadSubscriptions, loadAlerts]);

  useEffect(() => {
    if (open && scope === 'all' && canManageShared) void loadGlobalOptOuts();
  }, [open, scope, canManageShared, loadGlobalOptOuts]);

  /**
   * 2s polling fallback while any send is watched. Skips subscriptions whose
   * progress is arriving through the host's realtime bridge — polling is for
   * hosts (portal/demo) that never forward events. A watch ends when the
   * dispatch closes (either source), which also refreshes the table so the
   * Last-delivery badge speaks the final truth.
   */
  useEffect(() => {
    const ids = Object.keys(watched).map(Number);
    if (!open || ids.length === 0) return;
    const timer = window.setInterval(() => {
      for (const subId of ids) {
        const live = progressRef.current[subId];
        if (live !== undefined) {
          if (live.status !== 'running') {
            setWatched((prev) => {
              const next = { ...prev };
              delete next[subId];
              return next;
            });
            void loadSubscriptions();
          }
          continue;
        }
        runtime.api
          .listSubscriptionDispatches(subId, 1)
          .then(([latest]) => {
            if (!latest) return;
            setPolled((prev) => ({ ...prev, [subId]: latest }));
            if (latest.status !== 'running') {
              setWatched((prev) => {
                const next = { ...prev };
                delete next[subId];
                return next;
              });
              void loadSubscriptions();
            }
          })
          .catch(() => {
            /* transient poll failure: next tick retries */
          });
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [open, watched, runtime, loadSubscriptions]);

  const handleSendNow = async (subscription: DashboardSubscription) => {
    try {
      await runtime.api.sendSubscriptionNow(subscription.id);
      setPolled((prev) => {
        const next = { ...prev };
        delete next[subscription.id];
        return next;
      });
      setWatched((prev) => ({ ...prev, [subscription.id]: true }));
    } catch (error) {
      fail(`Could not start the send for "${subscription.name}"`, error);
    }
  };

  const handleToggleSubscription = async (subscription: DashboardSubscription, enabled: boolean) => {
    setTogglingId(`s${subscription.id}`);
    try {
      await runtime.api.setSubscriptionEnabled(subscription.id, enabled);
      await loadSubscriptions();
    } catch (error) {
      fail(`Could not ${enabled ? 'enable' : 'pause'} "${subscription.name}"`, error);
    } finally {
      setTogglingId(null);
    }
  };

  const handleToggleAlert = async (alert: DashboardAlert, enabled: boolean) => {
    setTogglingId(`a${alert.id}`);
    try {
      await runtime.api.setAlertEnabled(alert.id, enabled);
      await loadAlerts();
    } catch (error) {
      fail(`Could not ${enabled ? 'enable' : 'pause'} "${alert.name}"`, error);
    } finally {
      setTogglingId(null);
    }
  };

  const handleTestAlert = async (alert: DashboardAlert) => {
    setTestResults((prev) => ({ ...prev, [alert.id]: 'Testing…' }));
    try {
      const result = await runtime.api.testAlert(alert.id);
      setTestResults((prev) => ({
        ...prev,
        [alert.id]: `Value ${result.value === null ? 'no data' : result.value.toLocaleString()} — ${
          result.wouldFire ? 'WOULD fire' : 'would not fire'
        }`,
      }));
    } catch (error) {
      setTestResults((prev) => {
        const next = { ...prev };
        delete next[alert.id];
        return next;
      });
      fail(`Alert test failed for "${alert.name}"`, error);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      if (confirmDelete.kind === 'subscription') {
        await runtime.api.deleteSubscription(confirmDelete.row.id);
        await loadSubscriptions();
      } else {
        await runtime.api.deleteAlert(confirmDelete.row.id);
        await loadAlerts();
      }
    } catch (error) {
      fail(`Could not delete "${confirmDelete.row.name}"`, error);
    } finally {
      setConfirmDelete(null);
    }
  };

  const handleClearGlobalOptOut = async (email: string) => {
    try {
      await runtime.api.clearGlobalOptOut(email);
      await loadGlobalOptOuts();
    } catch (error) {
      fail(`Could not clear the global opt-out for ${email}`, error);
    }
  };

  const dashboardName = (dashboardId: number | null | undefined): string => {
    if (dashboardId == null) return '—';
    return dashboards.find((d) => d.id === dashboardId)?.name ?? `#${dashboardId}`;
  };

  const ownerText = (row: { ownerIsMe?: boolean; ownerDisplayName?: string | null; ownerUserId?: string }) =>
    row.ownerIsMe ? 'Me' : (row.ownerDisplayName ?? row.ownerUserId ?? '—');

  const tabButton = (key: 'subscriptions' | 'alerts', label: string) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      className={`cursor-pointer rounded-md px-3 py-1 text-sm font-medium transition-colors ${
        tab === key ? 'bg-rcd-surface-2 text-rcd-text' : 'text-rcd-text-2 hover:text-rcd-text'
      }`}
    >
      {label}
    </button>
  );

  return (
    <RcdDialog
      title="Subscriptions & alerts"
      open={open}
      onClose={onClose}
      wide
      fillHeight
      footer={<RcdButton onClick={onClose}>Close</RcdButton>}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-rcd-border p-0.5">
            {tabButton('subscriptions', 'Subscriptions')}
            {tabButton('alerts', 'Alerts')}
          </div>
          <div className="flex items-center gap-2">
            {canManageShared && (
              <div className="flex items-center gap-1 rounded-lg border border-rcd-border p-0.5">
                {(['mine', 'all'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setScope(value)}
                    className={`cursor-pointer rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors ${
                      scope === value ? 'bg-rcd-surface-2 text-rcd-text' : 'text-rcd-text-2 hover:text-rcd-text'
                    }`}
                  >
                    {value === 'mine' ? 'Mine' : 'All'}
                  </button>
                ))}
              </div>
            )}
            <RcdIconButton
              aria-label="Refresh"
              title="Refresh"
              onClick={() => {
                void loadSubscriptions();
                void loadAlerts();
              }}
            >
              <RefreshCw size={14} />
            </RcdIconButton>
          </div>
        </div>

        {tab === 'subscriptions' ? (
          subscriptions === null ? (
            <div className="flex h-24 items-center justify-center">
              <RcdSpinner label="Loading subscriptions…" />
            </div>
          ) : subscriptions.length === 0 ? (
            <p className="text-sm text-rcd-text-2">
              No subscriptions{scope === 'all' ? '' : ' of yours'} yet. Subscribe from a dashboard&apos;s
              Subscribe… dialog to get it emailed on a schedule.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {subscriptions.map((subscription) => {
                const live = dispatchProgress[subscription.id] ?? null;
                const polledDispatch = polled[subscription.id] ?? null;
                const showStrip =
                  watched[subscription.id] === true || live?.status === 'running';
                const recipientCount = recipientCountOf(subscription.recipients);
                return (
                  <div
                    key={subscription.id}
                    className="rounded-md border border-rcd-border px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-rcd-text">
                          {subscription.name}
                          {!subscription.enabled && (
                            <span className="ml-1.5 text-xs font-normal text-rcd-muted">(paused)</span>
                          )}
                        </p>
                        <p className="truncate text-xs text-rcd-muted">
                          {dashboardName(subscription.dashboardId)} ·{' '}
                          {scheduleSummary(subscription, scheduleTimeLabel)} ·{' '}
                          {recipientCount} recipient{recipientCount === 1 ? '' : 's'}
                          {scope === 'all' ? ` · Owner: ${ownerText(subscription)}` : ''}
                        </p>
                        <p className="mt-0.5 truncate">
                          <DeliveryBadge
                            summary={subscription.lastDispatch}
                            zoneId={scheduleTimeZoneId}
                            zoneLabel={scheduleTimeLabel}
                          />
                        </p>
                      </div>
                      <EnabledToggle
                        enabled={subscription.enabled}
                        busy={togglingId === `s${subscription.id}`}
                        label={`${subscription.enabled ? 'Pause' : 'Enable'} subscription ${subscription.name}`}
                        onChange={(enabled) => void handleToggleSubscription(subscription, enabled)}
                      />
                      <RcdIconButton
                        aria-label={`Preview ${subscription.name}`}
                        title="Preview email"
                        onClick={() =>
                          // Saved endpoint with {} — the manager previews the config as saved.
                          setPreview({
                            kind: 'saved',
                            subscriptionId: subscription.id,
                            format: subscription.format,
                          })
                        }
                      >
                        <Eye size={14} />
                      </RcdIconButton>
                      <RcdIconButton
                        aria-label={`Send ${subscription.name} now`}
                        title="Send now"
                        disabled={showStrip}
                        onClick={() => void handleSendNow(subscription)}
                      >
                        <Send size={14} />
                      </RcdIconButton>
                      <RcdIconButton
                        aria-label={`Delivery history for ${subscription.name}`}
                        title="History"
                        onClick={() => setHistoryFor(subscription)}
                      >
                        <History size={14} />
                      </RcdIconButton>
                      <RcdIconButton
                        aria-label={`Edit subscription ${subscription.name}`}
                        title="Edit"
                        onClick={() => setEditSubscription(subscription)}
                      >
                        <Pencil size={14} />
                      </RcdIconButton>
                      <RcdIconButton
                        aria-label={`Delete subscription ${subscription.name}`}
                        title="Delete"
                        onClick={() => setConfirmDelete({ kind: 'subscription', row: subscription })}
                      >
                        <Trash2 size={14} />
                      </RcdIconButton>
                    </div>
                    {showStrip && <ProgressStrip live={live} polledDispatch={polledDispatch} />}
                  </div>
                );
              })}

              {scope === 'all' && canManageShared && (
                <div className="mt-2 rounded-md border border-rcd-border px-3 py-2">
                  <p className="text-sm font-medium text-rcd-text">Global opt-outs</p>
                  <p className="text-xs text-rcd-muted">
                    Addresses suppressed from EVERY dashboard subscription email (self-service via the
                    unsubscribe link). Clearing re-enables delivery everywhere.
                  </p>
                  {globalOptOuts === null ? (
                    <div className="py-2">
                      <RcdSpinner label="Loading…" />
                    </div>
                  ) : globalOptOuts.length === 0 ? (
                    <p className="mt-1 text-xs text-rcd-text-2">None.</p>
                  ) : (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {globalOptOuts.map((optOut) => (
                        <span
                          key={optOut.email}
                          className="inline-flex items-center gap-1.5 rounded-md border border-rcd-border px-2 py-0.5 text-xs text-rcd-text-2"
                        >
                          {optOut.email}
                          <button
                            type="button"
                            className="cursor-pointer text-rcd-muted underline-offset-2 hover:underline"
                            onClick={() => void handleClearGlobalOptOut(optOut.email)}
                          >
                            clear
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        ) : alerts === null ? (
          <div className="flex h-24 items-center justify-center">
            <RcdSpinner label="Loading alerts…" />
          </div>
        ) : alerts.length === 0 ? (
          <p className="text-sm text-rcd-text-2">
            No alerts{scope === 'all' ? '' : ' of yours'} yet. Create one from a chart tile&apos;s
            &quot;Set alert on this measure&quot; menu.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {alerts.map((alert) => (
              <div key={alert.id} className="rounded-md border border-rcd-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <Bell size={15} className="shrink-0 text-rcd-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-rcd-text">
                      {alert.name}
                      {!alert.enabled && (
                        <span className="ml-1.5 text-xs font-normal text-rcd-muted">(paused)</span>
                      )}
                    </p>
                    <p className="truncate text-xs text-rcd-muted">
                      {alertConditionText(alert)} · {dashboardName(alert.dashboardId)}
                      {scope === 'all' ? ` · Owner: ${ownerText(alert)}` : ''}
                    </p>
                    <p className="truncate text-xs text-rcd-muted">
                      {alert.lastFiredUtc
                        ? `Last fired ${formatInstant(alert.lastFiredUtc, scheduleTimeZoneId, scheduleTimeLabel)}${
                            alert.lastValue != null ? ` (value ${alert.lastValue.toLocaleString()})` : ''
                          }`
                        : 'Never fired'}
                    </p>
                    {testResults[alert.id] && (
                      <p className="truncate text-xs text-rcd-text-2">{testResults[alert.id]}</p>
                    )}
                  </div>
                  <EnabledToggle
                    enabled={alert.enabled}
                    busy={togglingId === `a${alert.id}`}
                    label={`${alert.enabled ? 'Pause' : 'Enable'} alert ${alert.name}`}
                    onChange={(enabled) => void handleToggleAlert(alert, enabled)}
                  />
                  <RcdIconButton
                    aria-label={`Test alert ${alert.name}`}
                    title="Test send"
                    onClick={() => void handleTestAlert(alert)}
                  >
                    <FlaskConical size={14} />
                  </RcdIconButton>
                  <RcdIconButton
                    aria-label={`Edit alert ${alert.name}`}
                    title="Edit"
                    onClick={() => setEditAlert(alert)}
                  >
                    <Pencil size={14} />
                  </RcdIconButton>
                  <RcdIconButton
                    aria-label={`Delete alert ${alert.name}`}
                    title="Delete"
                    onClick={() => setConfirmDelete({ kind: 'alert', row: alert })}
                  >
                    <Trash2 size={14} />
                  </RcdIconButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <SubscriptionEditorDialog
        open={editSubscription !== null}
        subscription={editSubscription}
        onClose={() => setEditSubscription(null)}
        onSaved={() => void loadSubscriptions()}
        onError={onError}
      />

      <AlertEditorDialog
        open={editAlert !== null}
        alert={editAlert}
        onClose={() => setEditAlert(null)}
        onSaved={() => void loadAlerts()}
        onError={onError}
      />

      <SubscriptionHistoryDialog
        open={historyFor !== null}
        subscription={historyFor}
        onClose={() => setHistoryFor(null)}
        onError={onError}
      />

      <SubscriptionPreviewDialog request={preview} onClose={() => setPreview(null)} />

      <ConfirmDialog
        title={confirmDelete?.kind === 'alert' ? 'Delete alert' : 'Delete subscription'}
        message={confirmDelete ? `Delete "${confirmDelete.row.name}"?` : ''}
        confirmLabel="Delete"
        danger
        open={confirmDelete !== null}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(null)}
      />
    </RcdDialog>
  );
}

const DISPATCH_STATUS_TONES: Record<string, string> = {
  running: 'text-rcd-text-2 border-rcd-border',
  sent: 'text-[var(--rcd-status-ok,#059669)] border-rcd-border',
  partial: 'text-[var(--rcd-status-warn)] border-[var(--rcd-status-warn)]',
  failed: 'text-[var(--rcd-status-critical)] border-[var(--rcd-status-critical)]',
  skipped: 'text-rcd-muted border-rcd-border',
};

/**
 * History drawer (dialog-based — the design system has no drawer primitive):
 * the last 20 dispatches, each expandable to per-recipient rows with status,
 * attempts, error text, opt-out marker, and "Opened (approximate)" from the
 * tracking pixel — labeled approximate because image proxies/blocking make
 * opens a floor, never a receipt. Also lists and clears this subscription's
 * opt-outs (re-invite someone).
 */
export function SubscriptionHistoryDialog({
  open,
  subscription,
  onClose,
  onError,
}: {
  open: boolean;
  subscription: DashboardSubscription | null;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const runtime = useRuntime();
  const { scheduleTimeZoneId, scheduleTimeLabel } = runtime.options;
  const [dispatches, setDispatches] = useState<SubscriptionDispatch[] | null>(null);
  const [optOuts, setOptOuts] = useState<SubscriptionOptOut[]>([]);
  const [expanded, setExpanded] = useState<Record<number, true>>({});

  const load = useCallback(async () => {
    if (!subscription) return;
    try {
      setDispatches(await runtime.api.listSubscriptionDispatches(subscription.id, 20));
      setOptOuts(await runtime.api.listSubscriptionOptOuts(subscription.id));
    } catch (error) {
      setDispatches([]);
      onError(`Could not load delivery history: ${rcdErrorMessage(error)}`);
    }
  }, [runtime, subscription, onError]);

  useEffect(() => {
    if (!open) {
      setDispatches(null);
      setOptOuts([]);
      setExpanded({});
      return;
    }
    void load();
  }, [open, load]);

  const clearOptOut = async (email: string) => {
    if (!subscription) return;
    try {
      await runtime.api.clearSubscriptionOptOut(subscription.id, email);
      await load();
    } catch (error) {
      onError(`Could not clear the opt-out for ${email}: ${rcdErrorMessage(error)}`);
    }
  };

  return (
    <RcdDialog
      title={`Delivery history — ${subscription?.name ?? ''}`}
      open={open}
      onClose={onClose}
      wide
      fillHeight
      footer={<RcdButton onClick={onClose}>Close</RcdButton>}
    >
      {dispatches === null ? (
        <div className="flex h-24 items-center justify-center">
          <RcdSpinner label="Loading history…" />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {optOuts.length > 0 && (
            <div className="rounded-md border border-rcd-border px-3 py-2">
              <p className="text-xs font-medium text-rcd-text-2">
                Opted out of this subscription (cleared = re-invited):
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {optOuts.map((optOut) => (
                  <span
                    key={optOut.email}
                    className="inline-flex items-center gap-1.5 rounded-md border border-rcd-border px-2 py-0.5 text-xs text-rcd-text-2"
                  >
                    {optOut.email}
                    <button
                      type="button"
                      className="cursor-pointer text-rcd-muted underline-offset-2 hover:underline"
                      onClick={() => void clearOptOut(optOut.email)}
                    >
                      clear
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {dispatches.length === 0 ? (
            <p className="text-sm text-rcd-text-2">No deliveries yet.</p>
          ) : (
            dispatches.map((dispatch) => {
              const isOpen = expanded[dispatch.id] === true;
              return (
                <div key={dispatch.id} className="rounded-md border border-rcd-border">
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = { ...prev };
                        if (isOpen) delete next[dispatch.id];
                        else next[dispatch.id] = true;
                        return next;
                      })
                    }
                  >
                    {isOpen ? (
                      <ChevronDown size={14} className="shrink-0 text-rcd-muted" />
                    ) : (
                      <ChevronRight size={14} className="shrink-0 text-rcd-muted" />
                    )}
                    <span
                      className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${
                        DISPATCH_STATUS_TONES[dispatch.status] ?? 'text-rcd-muted border-rcd-border'
                      }`}
                    >
                      {dispatch.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-rcd-text-2">
                      {formatInstant(dispatch.startedUtc, scheduleTimeZoneId, scheduleTimeLabel)} ·{' '}
                      {dispatch.trigger === 'manual'
                        ? `manual${dispatch.requestedBy ? ` (by ${dispatch.requestedBy})` : ''}`
                        : 'scheduled'}
                      {dispatch.error ? ` · ${dispatch.error}` : ''}
                    </span>
                    <span className="shrink-0 text-[11px] text-rcd-muted">
                      {dispatch.recipients.filter((r) => r.status === 'sent').length}/
                      {dispatch.recipients.length} sent
                    </span>
                  </button>
                  {isOpen && (
                    <div className="overflow-x-auto border-t border-rcd-border px-3 py-2">
                      {dispatch.recipients.length === 0 ? (
                        <p className="text-xs text-rcd-muted">No recipients recorded.</p>
                      ) : (
                        <table className="w-full border-collapse text-xs">
                          <thead>
                            <tr className="text-left text-rcd-muted">
                              <th className="py-1 pr-3 font-medium">Recipient</th>
                              <th className="py-1 pr-3 font-medium">Status</th>
                              <th className="py-1 pr-3 font-medium">Attempts</th>
                              <th className="py-1 pr-3 font-medium">Opened (approximate)</th>
                              <th className="py-1 font-medium">Error</th>
                            </tr>
                          </thead>
                          <tbody>
                            {dispatch.recipients.map((recipient) => (
                              <tr key={recipient.id} className="border-t border-rcd-border/60">
                                <td className="py-1 pr-3 text-rcd-text">{recipient.email}</td>
                                <td className={`py-1 pr-3 ${RECIPIENT_TONES[recipient.status].split(' ')[0]}`}>
                                  {RECIPIENT_LABELS[recipient.status]}
                                </td>
                                <td className="py-1 pr-3 text-rcd-text-2">{recipient.attempts}</td>
                                <td className="py-1 pr-3 text-rcd-text-2">
                                  {recipient.openedUtc
                                    ? `${formatInstant(recipient.openedUtc, scheduleTimeZoneId, scheduleTimeLabel)}${
                                        recipient.openCount > 1 ? ` (${recipient.openCount}×)` : ''
                                      }`
                                    : '—'}
                                </td>
                                <td className="py-1 text-rcd-text-2">{recipient.error ?? ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </RcdDialog>
  );
}

/**
 * Editor for a SAVED alert (the manager's Edit action). The watched query
 * spec is deliberately NOT editable here: it was captured from a live chart's
 * effective filters at creation and there is no chart context to rebuild it
 * from — everything else (name, condition, recipients, cadence, cooldown,
 * enabled) round-trips through the same PUT the AlertDialog uses.
 */
export function AlertEditorDialog({
  open,
  alert,
  onClose,
  onSaved,
  onError,
}: {
  open: boolean;
  alert: DashboardAlert | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const runtime = useRuntime();
  const [name, setName] = useState('');
  const [operator, setOperator] = useState<AlertOperator>('gt');
  const [threshold, setThreshold] = useState('0');
  const [recipientsText, setRecipientsText] = useState('');
  const [everyMinutes, setEveryMinutes] = useState(60);
  const [cooldownMinutes, setCooldownMinutes] = useState(60);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !alert) return;
    setName(alert.name);
    setOperator(alert.operator);
    setThreshold(String(alert.threshold));
    setRecipientsText(
      alert.recipients
        .split(';')
        .map((email) => email.trim())
        .filter((email) => email !== '')
        .join(', '),
    );
    setEveryMinutes(alert.everyMinutes);
    setCooldownMinutes(alert.cooldownMinutes);
    setEnabled(alert.enabled);
    setSaving(false);
  }, [open, alert]);

  const recipients = parseRecipients(recipientsText);
  const invalidRecipients = recipients.filter((email) => !looksLikeEmail(email));
  const thresholdNumber = Number(threshold);
  const canSave =
    alert !== null &&
    name.trim() !== '' &&
    Number.isFinite(thresholdNumber) &&
    recipients.length > 0 &&
    invalidRecipients.length === 0;

  const handleSave = async () => {
    if (!alert || !canSave || saving) return;
    setSaving(true);
    try {
      await runtime.api.updateAlert(alert.id, {
        dashboardId: alert.dashboardId ?? null,
        name: name.trim(),
        spec: alert.spec, // unchanged — see the component remarks
        operator,
        threshold: thresholdNumber,
        recipients: recipients.join(';'),
        everyMinutes,
        cooldownMinutes,
        enabled,
      });
      onSaved();
      onClose();
    } catch (error) {
      onError(`Could not save the alert: ${rcdErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const cadenceOptions = [5, 15, 30, 60, 240, 1440];

  return (
    <RcdDialog
      title="Edit alert"
      open={open}
      onClose={onClose}
      footer={
        <>
          <RcdButton onClick={onClose} disabled={saving}>
            Cancel
          </RcdButton>
          <RcdButton variant="primary" disabled={!canSave || saving} onClick={() => void handleSave()}>
            {saving ? 'Saving…' : 'Save alert'}
          </RcdButton>
        </>
      }
    >
      {alert && (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
            Name
            <RcdInput value={name} onChange={(event) => setName(event.target.value)} />
          </label>

          <div className="flex flex-col gap-1 text-sm text-rcd-text-2">
            Condition
            <div className="flex flex-wrap items-center gap-1.5">
              <RcdSelect
                aria-label="Operator"
                value={operator}
                onChange={(event) => setOperator(event.target.value as AlertOperator)}
              >
                <option value="gt">is greater than</option>
                <option value="gte">is at least</option>
                <option value="lt">is less than</option>
                <option value="lte">is at most</option>
                <option value="eq">equals</option>
              </RcdSelect>
              <RcdInput
                type="number"
                aria-label="Threshold"
                value={threshold}
                onChange={(event) => setThreshold(event.target.value)}
                className="w-28"
              />
            </div>
            <span className="text-xs text-rcd-muted">
              The watched query itself is fixed at creation (it captured the chart&apos;s filters);
              re-create the alert from the chart to change what it measures.
            </span>
          </div>

          <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
            Recipients
            <textarea
              value={recipientsText}
              onChange={(event) => setRecipientsText(event.target.value)}
              rows={2}
              className="rounded-lg border border-rcd-border bg-rcd-surface px-3 py-1.5 text-sm text-rcd-text shadow-[var(--rcd-shadow-1)] outline-none transition-[border-color,box-shadow] placeholder:text-rcd-muted focus:border-[var(--rcd-accent-interactive)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--rcd-accent-interactive)_20%,transparent)]"
            />
            {invalidRecipients.length > 0 && (
              <span className="text-xs text-[var(--rcd-status-critical)]">
                These don&apos;t look like email addresses: {invalidRecipients.join(', ')}
              </span>
            )}
          </label>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-sm text-rcd-text-2">
              Check
              <RcdSelect
                value={String(everyMinutes)}
                onChange={(event) => setEveryMinutes(Number(event.target.value))}
              >
                {cadenceOptions.map((minutes) => (
                  <option key={minutes} value={String(minutes)}>
                    every {minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`}
                  </option>
                ))}
              </RcdSelect>
            </label>
            <label className="flex items-center gap-1.5 text-sm text-rcd-text-2">
              Cooldown
              <RcdSelect
                value={String(cooldownMinutes)}
                onChange={(event) => setCooldownMinutes(Number(event.target.value))}
              >
                {cadenceOptions.map((minutes) => (
                  <option key={minutes} value={String(minutes)}>
                    {minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`}
                  </option>
                ))}
              </RcdSelect>
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-sm text-rcd-text">
              <input
                type="checkbox"
                className="accent-[var(--rcd-accent)]"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              Enabled
            </label>
          </div>
        </div>
      )}
    </RcdDialog>
  );
}
