import { useCallback, useEffect, useState } from 'react';
import { Mail, Pencil, Plus, Trash2 } from 'lucide-react';
import type {
  DashboardSubscription,
  SaveSubscriptionBody,
  SubscriptionSchedule,
} from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdDialog, RcdIconButton, RcdInput, RcdSelect, RcdSpinner } from '../primitives';

export interface SubscriptionsDialogProps {
  open: boolean;
  dashboardId: number;
  onClose: () => void;
  /** Failures surface through the dashboard's transient notice chip. */
  onError: (message: string) => void;
}

/** Splits a recipients textarea into trimmed, de-duplicated addresses. */
export const parseRecipients = (raw: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(/[\s,;]+/)) {
    const email = piece.trim();
    if (email === '' || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push(email);
  }
  return out;
};

/** Validation-lite: something@something.tld. */
export const looksLikeEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const INTERVAL_OPTIONS = [15, 30, 60, 240, 480, 1440];

interface SubscriptionDraft {
  id: number | null;
  name: string;
  kind: SubscriptionSchedule['kind'];
  everyMinutes: number;
  timeUtc: string;
  dayOfWeek: number;
  recipientsText: string;
  format: 'html' | 'csv';
  enabled: boolean;
}

const emptyDraft = (): SubscriptionDraft => ({
  id: null,
  name: '',
  kind: 'daily',
  everyMinutes: 60,
  timeUtc: '08:00',
  dayOfWeek: 1,
  recipientsText: '',
  format: 'html',
  enabled: true,
});

const draftFrom = (subscription: DashboardSubscription): SubscriptionDraft => ({
  id: subscription.id,
  name: subscription.name,
  kind: subscription.schedule.kind,
  everyMinutes: subscription.schedule.everyMinutes ?? 60,
  timeUtc: subscription.schedule.timeUtc ?? '08:00',
  dayOfWeek: subscription.schedule.dayOfWeek ?? 1,
  recipientsText: subscription.recipients.join(', '),
  format: subscription.format,
  enabled: subscription.enabled,
});

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const scheduleSummary = (schedule: SubscriptionSchedule): string => {
  if (schedule.kind === 'interval') return `Every ${schedule.everyMinutes ?? '?'} min`;
  if (schedule.kind === 'daily') return `Daily at ${schedule.timeUtc ?? '?'} UTC`;
  return `${DAYS[schedule.dayOfWeek ?? 0] ?? '?'} at ${schedule.timeUtc ?? '?'} UTC`;
};

/**
 * "Subscribe" dialog: lists my email subscriptions for this dashboard and
 * hosts the create/edit form (name, schedule for the three kinds, recipients
 * with lite email validation, format, enabled). All I/O goes through the
 * typed DashboardsApi client; failures surface via the notice chip.
 */
export function SubscriptionsDialog({ open, dashboardId, onClose, onError }: SubscriptionsDialogProps) {
  const runtime = useRuntime();
  const [subscriptions, setSubscriptions] = useState<DashboardSubscription[] | null>(null);
  const [draft, setDraft] = useState<SubscriptionDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<DashboardSubscription | null>(null);

  const load = useCallback(() => {
    runtime.api
      .listSubscriptions(dashboardId)
      .then(setSubscriptions)
      .catch((error: unknown) => {
        setSubscriptions([]);
        onError(`Could not load subscriptions: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, [runtime, dashboardId, onError]);

  useEffect(() => {
    if (!open) {
      setSubscriptions(null);
      setDraft(null);
      setConfirmDelete(null);
      return;
    }
    load();
  }, [open, load]);

  const recipients = draft ? parseRecipients(draft.recipientsText) : [];
  const invalidRecipients = recipients.filter((email) => !looksLikeEmail(email));
  const canSave =
    draft !== null && draft.name.trim() !== '' && recipients.length > 0 && invalidRecipients.length === 0;

  const handleSave = async () => {
    if (!draft || !canSave || saving) return;
    const schedule: SubscriptionSchedule =
      draft.kind === 'interval'
        ? { kind: 'interval', everyMinutes: draft.everyMinutes }
        : draft.kind === 'daily'
          ? { kind: 'daily', timeUtc: draft.timeUtc }
          : { kind: 'weekly', timeUtc: draft.timeUtc, dayOfWeek: draft.dayOfWeek };
    const body: SaveSubscriptionBody = {
      dashboardId,
      name: draft.name.trim(),
      schedule,
      recipients,
      format: draft.format,
      enabled: draft.enabled,
    };
    setSaving(true);
    try {
      if (draft.id === null) await runtime.api.createSubscription(body);
      else await runtime.api.updateSubscription(draft.id, body);
      setDraft(null);
      load();
    } catch (error) {
      onError(`Could not save the subscription: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (subscription: DashboardSubscription) => {
    try {
      await runtime.api.deleteSubscription(subscription.id);
      load();
    } catch (error) {
      onError(`Could not delete the subscription: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <RcdDialog
      title={draft ? (draft.id === null ? 'New subscription' : 'Edit subscription') : 'Subscriptions'}
      open={open}
      onClose={onClose}
      footer={
        draft ? (
          <>
            <RcdButton onClick={() => setDraft(null)} disabled={saving}>
              Back
            </RcdButton>
            <RcdButton variant="primary" disabled={!canSave || saving} onClick={() => void handleSave()}>
              {saving ? 'Saving…' : 'Save subscription'}
            </RcdButton>
          </>
        ) : (
          <RcdButton onClick={onClose}>Close</RcdButton>
        )
      }
    >
      {draft === null ? (
        <div className="flex flex-col gap-2">
          {subscriptions === null ? (
            <div className="flex h-24 items-center justify-center">
              <RcdSpinner label="Loading subscriptions…" />
            </div>
          ) : subscriptions.length === 0 ? (
            <p className="text-sm text-rcd-text-2">
              No subscriptions yet. Subscribe to get this dashboard emailed on a schedule.
            </p>
          ) : (
            subscriptions.map((subscription) => (
              <div
                key={subscription.id}
                className="flex items-center gap-2 rounded-md border border-rcd-border px-3 py-2"
              >
                <Mail size={15} className="shrink-0 text-rcd-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-rcd-text">
                    {subscription.name}
                    {!subscription.enabled && (
                      <span className="ml-1.5 text-xs font-normal text-rcd-muted">(paused)</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-rcd-muted">
                    {scheduleSummary(subscription.schedule)} · {subscription.format.toUpperCase()} ·{' '}
                    {subscription.recipients.length} recipient
                    {subscription.recipients.length === 1 ? '' : 's'}
                  </p>
                </div>
                <RcdIconButton
                  aria-label={`Edit subscription ${subscription.name}`}
                  title="Edit"
                  onClick={() => setDraft(draftFrom(subscription))}
                >
                  <Pencil size={14} />
                </RcdIconButton>
                <RcdIconButton
                  aria-label={`Delete subscription ${subscription.name}`}
                  title="Delete"
                  onClick={() => setConfirmDelete(subscription)}
                >
                  <Trash2 size={14} />
                </RcdIconButton>
              </div>
            ))
          )}
          <div>
            <RcdButton onClick={() => setDraft(emptyDraft())}>
              <Plus size={14} />
              New subscription
            </RcdButton>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
            Name
            <RcdInput
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="e.g. Monday morning report"
            />
          </label>

          <div className="flex flex-col gap-1 text-sm text-rcd-text-2">
            Schedule
            <div className="flex flex-wrap items-center gap-1.5">
              <RcdSelect
                aria-label="Schedule kind"
                value={draft.kind}
                onChange={(event) =>
                  setDraft({ ...draft, kind: event.target.value as SubscriptionSchedule['kind'] })
                }
              >
                <option value="interval">Every N minutes</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </RcdSelect>
              {draft.kind === 'interval' ? (
                <RcdSelect
                  aria-label="Interval minutes"
                  value={String(draft.everyMinutes)}
                  onChange={(event) => setDraft({ ...draft, everyMinutes: Number(event.target.value) })}
                >
                  {INTERVAL_OPTIONS.map((minutes) => (
                    <option key={minutes} value={String(minutes)}>
                      Every {minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`}
                    </option>
                  ))}
                </RcdSelect>
              ) : (
                <>
                  {draft.kind === 'weekly' && (
                    <RcdSelect
                      aria-label="Day of week"
                      value={String(draft.dayOfWeek)}
                      onChange={(event) => setDraft({ ...draft, dayOfWeek: Number(event.target.value) })}
                    >
                      {DAYS.map((day, index) => (
                        <option key={day} value={String(index)}>
                          {day}
                        </option>
                      ))}
                    </RcdSelect>
                  )}
                  <RcdInput
                    type="time"
                    aria-label="Send time (UTC)"
                    value={draft.timeUtc}
                    onChange={(event) => setDraft({ ...draft, timeUtc: event.target.value })}
                  />
                  <span className="text-xs text-rcd-muted">UTC</span>
                </>
              )}
            </div>
          </div>

          <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
            Recipients
            <textarea
              value={draft.recipientsText}
              onChange={(event) => setDraft({ ...draft, recipientsText: event.target.value })}
              placeholder="one@example.com, two@example.com"
              rows={3}
              className="rounded-lg border border-rcd-border bg-rcd-surface px-3 py-1.5 text-sm text-rcd-text shadow-[var(--rcd-shadow-1)] outline-none transition-[border-color,box-shadow] placeholder:text-rcd-muted focus:border-[var(--rcd-accent-interactive)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--rcd-accent-interactive)_20%,transparent)]"
            />
            {recipients.length > 0 && (
              <span className="flex flex-wrap gap-1">
                {recipients.map((email) => (
                  <span
                    key={email}
                    className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                      looksLikeEmail(email)
                        ? 'border-rcd-border text-rcd-text-2'
                        : 'border-[var(--rcd-status-critical)] text-[var(--rcd-status-critical)]'
                    }`}
                  >
                    {email}
                  </span>
                ))}
              </span>
            )}
            {invalidRecipients.length > 0 && (
              <span className="text-xs text-[var(--rcd-status-critical)]">
                These don&apos;t look like email addresses: {invalidRecipients.join(', ')}
              </span>
            )}
          </label>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-sm text-rcd-text-2">
              Format
              <RcdSelect
                value={draft.format}
                onChange={(event) => setDraft({ ...draft, format: event.target.value as 'html' | 'csv' })}
              >
                <option value="html">HTML</option>
                <option value="csv">CSV</option>
              </RcdSelect>
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-sm text-rcd-text">
              <input
                type="checkbox"
                className="accent-[var(--rcd-accent)]"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
              Enabled
            </label>
          </div>
        </div>
      )}

      <ConfirmDialog
        title="Delete subscription"
        message={confirmDelete ? `Delete the subscription "${confirmDelete.name}"?` : ''}
        confirmLabel="Delete"
        danger
        open={confirmDelete !== null}
        onConfirm={() => {
          if (confirmDelete) void handleDelete(confirmDelete);
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </RcdDialog>
  );
}
