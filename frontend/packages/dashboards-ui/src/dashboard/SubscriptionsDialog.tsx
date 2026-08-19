import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Mail, Pencil, Plus, Settings2, Trash2 } from 'lucide-react';
import type {
  DashboardLayoutDoc,
  DashboardSubscription,
  SaveSubscriptionBody,
  SubscriptionContentBody,
  SubscriptionContentConfig,
  SubscriptionImageWidth,
  SubscriptionScheduleKind,
} from '@recon/dashboards-core';
import { useDashboardState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdDialog, RcdIconButton, RcdInput, RcdSelect, RcdSpinner } from '../primitives';
import { DeliveryBadge, EnabledToggle } from './deliveryBadge';
import { SubscriptionPreviewDialog, type SubscriptionPreviewRequest } from './SubscriptionPreviewDialog';

export interface SubscriptionsDialogProps {
  open: boolean;
  dashboardId: number;
  onClose: () => void;
  /** Failures surface through the dashboard's transient notice chip. */
  onError: (message: string) => void;
  /**
   * Renders a "Manage all…" link that closes this dialog and opens the
   * Subscriptions & alerts manager. Optional: hosts/pages that never mount
   * the manager simply omit it.
   */
  onManageAll?: () => void;
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

/** Editing-friendly shape; the wire shape is built by draftToWire on save. */
export interface SubscriptionDraft {
  id: number | null;
  name: string;
  kind: SubscriptionScheduleKind;
  everyMinutes: number;
  /** "HH:mm" wall time in the host's schedule zone. */
  timeLocal: string;
  dayOfWeek: number;
  recipientsText: string;
  format: 'html' | 'csv';
  enabled: boolean;
  /* Email content composition — flattened wire `content` (ALWAYS emitted on save). */
  contentBody: SubscriptionContentBody;
  imageWidth: SubscriptionImageWidth;
  /** Editing-friendly text; must parse to an integer 5..500 to save/preview. */
  maxTableRowsText: string;
  /** Tile ids omitted from the email (unchecked in the include checklist). */
  excludedTileIds: string[];
}

/** New subscriptions default to chart images (LOCKED — the feature's point). */
const emptyDraft = (): SubscriptionDraft => ({
  id: null,
  name: '',
  kind: 'daily',
  everyMinutes: 60,
  timeLocal: '08:00',
  dayOfWeek: 1,
  recipientsText: '',
  format: 'html',
  enabled: true,
  contentBody: 'charts',
  imageWidth: 600,
  maxTableRowsText: '50',
  excludedTileIds: [],
});

/** The wire's ';'-joined recipients string as an array (for counting/editing). */
const recipientList = (recipients: string): string[] =>
  recipients.split(';').map((email) => email.trim()).filter((email) => email !== '');

export const draftFrom = (subscription: DashboardSubscription): SubscriptionDraft => {
  // Legacy rows (content null/absent) edit as the explicit tables defaults —
  // the next save upgrades NULL to { body:'tables', … } with IDENTICAL
  // semantics (LOCKED: draftToWire always emits the content object).
  const content = subscription.content ?? null;
  return {
    id: subscription.id,
    name: subscription.name,
    kind: subscription.scheduleKind,
    everyMinutes: subscription.intervalMinutes ?? 60,
    timeLocal: subscription.timeOfDayLocal ?? '08:00',
    dayOfWeek: subscription.dayOfWeek ?? 1,
    recipientsText: recipientList(subscription.recipients).join(', '),
    format: subscription.format,
    enabled: subscription.enabled,
    contentBody: content?.body ?? 'tables',
    imageWidth: content?.imageWidth ?? 600,
    maxTableRowsText: String(content?.maxTableRows ?? 50),
    excludedTileIds: content ? [...(content.excludedTileIds ?? [])] : [],
  };
};

/**
 * Parsed "Max rows per tile"; null = outside the wire's 5..500 integer range,
 * which blocks save AND preview (the backend validates the same bounds).
 */
export const draftMaxTableRows = (draft: SubscriptionDraft): number | null => {
  const value = Number(draft.maxTableRowsText.trim());
  return Number.isInteger(value) && value >= 5 && value <= 500 ? value : null;
};

/**
 * The draft's wire `content` object (rides saves and previews alike). Callers
 * gate on draftMaxTableRows first — the fallback only guards non-UI callers.
 */
export const draftContent = (draft: SubscriptionDraft): SubscriptionContentConfig => ({
  body: draft.contentBody,
  excludedTileIds: draft.excludedTileIds,
  imageWidth: draft.imageWidth,
  maxTableRows: draftMaxTableRows(draft) ?? 50,
});

/**
 * Draft -> FLAT wire body. This mapping IS the save contract — it must mirror
 * the backend's SaveSubscriptionRequest exactly (see the wire-shape test):
 * per-kind fields are nulled rather than omitted, and recipients are joined
 * with ';' because the backend splits on ';' ONLY — a ',' would validate as
 * one address and then fail at SMTP. `content` is ALWAYS the explicit object,
 * never null — a legacy-NULL row upgrades on its next save. Exported for the
 * wire-shape test.
 */
export const draftToWire = (draft: SubscriptionDraft, dashboardId: number): SaveSubscriptionBody => ({
  dashboardId,
  name: draft.name.trim(),
  scheduleKind: draft.kind,
  intervalMinutes: draft.kind === 'interval' ? draft.everyMinutes : null,
  timeOfDayLocal: draft.kind === 'interval' ? null : draft.timeLocal,
  dayOfWeek: draft.kind === 'weekly' ? draft.dayOfWeek : null,
  recipients: parseRecipients(draft.recipientsText).join(';'),
  format: draft.format,
  enabled: draft.enabled,
  content: draftContent(draft),
});

/**
 * Form-footer preview: a NEW subscription renders through the dashboard's
 * draft endpoint; editing a SAVED one posts its own endpoint with the current
 * draft's content as the override, so unsaved tweaks show without saving.
 */
export const previewRequestOf = (
  draft: SubscriptionDraft,
  dashboardId: number,
): SubscriptionPreviewRequest =>
  draft.id === null
    ? { kind: 'draft', dashboardId, format: draft.format, content: draftContent(draft) }
    : { kind: 'saved', subscriptionId: draft.id, format: draft.format, content: draftContent(draft) };

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const scheduleSummary = (subscription: DashboardSubscription, zoneLabel: string): string => {
  if (subscription.scheduleKind === 'interval') return `Every ${subscription.intervalMinutes ?? '?'} min`;
  if (subscription.scheduleKind === 'daily')
    return `Daily at ${subscription.timeOfDayLocal ?? '?'} ${zoneLabel}`;
  return `${DAYS[subscription.dayOfWeek ?? 0] ?? '?'} at ${subscription.timeOfDayLocal ?? '?'} ${zoneLabel}`;
};

/**
 * "Last sent 2026-08-18 07:00 CT" / "Never sent". The UTC instant is rendered
 * in the schedule zone via Intl (browsers ship the IANA database); an id the
 * browser doesn't know falls back to the raw UTC reading rather than lying
 * with the wrong offset.
 */
export const lastSentText = (lastRunUtc: string | null, zoneId: string, zoneLabel: string): string => {
  if (!lastRunUtc) return 'Never sent';
  // Backend DateTimes serialize with a trailing Z; tolerate a missing one so
  // an offsetless string is still read as UTC instead of browser-local.
  const instant = new Date(/(?:[zZ]|[+-]\d\d:\d\d)$/.test(lastRunUtc) ? lastRunUtc : `${lastRunUtc}Z`);
  if (Number.isNaN(instant.getTime())) return 'Never sent';
  try {
    // en-CA renders "2026-08-18, 07:00" — the ISO-like ordering we want.
    const stamp = new Intl.DateTimeFormat('en-CA', {
      timeZone: zoneId,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(instant)
      .replace(',', '');
    return `Last sent ${stamp} ${zoneLabel}`;
  } catch {
    return `Last sent ${instant.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
};

/**
 * "Subscribe" dialog: lists my email subscriptions for this dashboard and
 * hosts the create/edit form (name, schedule for the three kinds, recipients
 * with lite email validation, format, enabled). All I/O goes through the
 * typed DashboardsApi client; failures surface via the notice chip.
 */
export function SubscriptionsDialog({
  open,
  dashboardId,
  onClose,
  onError,
  onManageAll,
}: SubscriptionsDialogProps) {
  const runtime = useRuntime();
  const { scheduleTimeZoneId, scheduleTimeLabel } = runtime.options;
  const [subscriptions, setSubscriptions] = useState<DashboardSubscription[] | null>(null);
  const [draft, setDraft] = useState<SubscriptionDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<DashboardSubscription | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [preview, setPreview] = useState<SubscriptionPreviewRequest | null>(null);

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
      setPreview(null);
      return;
    }
    load();
  }, [open, load]);

  const recipients = draft ? parseRecipients(draft.recipientsText) : [];
  const invalidRecipients = recipients.filter((email) => !looksLikeEmail(email));
  const canSave =
    draft !== null &&
    draft.name.trim() !== '' &&
    recipients.length > 0 &&
    invalidRecipients.length === 0 &&
    draftMaxTableRows(draft) !== null;

  const handleSave = async () => {
    if (!draft || !canSave || saving) return;
    const body = draftToWire(draft, dashboardId);
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

  /** Backend-first toggle: flip, then re-render from the reload — the switch never lies. */
  const handleToggle = async (subscription: DashboardSubscription, enabled: boolean) => {
    setTogglingId(subscription.id);
    try {
      await runtime.api.setSubscriptionEnabled(subscription.id, enabled);
      load();
    } catch (error) {
      onError(
        `Could not ${enabled ? 'enable' : 'pause'} the subscription: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setTogglingId(null);
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
            <RcdButton
              disabled={saving || draftMaxTableRows(draft) === null}
              onClick={() => setPreview(previewRequestOf(draft, dashboardId))}
            >
              Preview
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
            subscriptions.map((subscription) => {
              const recipientCount = recipientList(subscription.recipients).length;
              return (
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
                    {scheduleSummary(subscription, scheduleTimeLabel)} · {subscription.format.toUpperCase()} ·{' '}
                    {recipientCount} recipient
                    {recipientCount === 1 ? '' : 's'} ·{' '}
                    {lastSentText(subscription.lastRunUtc, scheduleTimeZoneId, scheduleTimeLabel)}
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
                  busy={togglingId === subscription.id}
                  label={`${subscription.enabled ? 'Pause' : 'Enable'} subscription ${subscription.name}`}
                  onChange={(enabled) => void handleToggle(subscription, enabled)}
                />
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
              );
            })
          )}
          <div className="flex items-center justify-between gap-2">
            <RcdButton onClick={() => setDraft(emptyDraft())}>
              <Plus size={14} />
              New subscription
            </RcdButton>
            {onManageAll && (
              <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-1 text-xs text-rcd-text-2 underline-offset-2 hover:underline"
                onClick={onManageAll}
              >
                <Settings2 size={12} />
                Manage all…
              </button>
            )}
          </div>
        </div>
      ) : (
        <SubscriptionForm
          draft={draft}
          setDraft={setDraft}
          scheduleTimeLabel={scheduleTimeLabel}
          dashboardId={dashboardId}
        />
      )}

      <SubscriptionPreviewDialog request={preview} onClose={() => setPreview(null)} />

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

/** All chart tiles across the doc's pages (legacy single-page docs fall back to `tiles`). */
export const chartTilesOf = (layout: DashboardLayoutDoc): { id: string; title: string }[] => {
  const pages = layout.pages ?? [];
  const tiles = pages.length > 0 ? pages.flatMap((page) => page.tiles) : layout.tiles;
  const out: { id: string; title: string }[] = [];
  for (const tile of tiles) {
    if ((tile.kind ?? 'chart') !== 'chart' || tile.chart === undefined) continue;
    const title = tile.chart.title.trim();
    out.push({ id: tile.id, title: title === '' ? 'Untitled chart' : title });
  }
  return out;
};

/**
 * The subscription create/edit form, extracted so the Subscriptions & alerts
 * manager can edit any subscription through the EXACT same fields and
 * validation as the per-dashboard dialog (spec: "Edit opens the existing
 * dialog prefilled").
 */
export function SubscriptionForm({
  draft,
  setDraft,
  scheduleTimeLabel,
  dashboardId,
}: {
  draft: SubscriptionDraft;
  setDraft: (draft: SubscriptionDraft) => void;
  scheduleTimeLabel: string;
  /** The subscribed dashboard — sources the per-tile include checklist. */
  dashboardId: number;
}) {
  const runtime = useRuntime();
  // Tile list source: the ALREADY-LOADED doc when this dashboard is open (the
  // per-dashboard dialog); otherwise (the manager's editor spans dashboards)
  // fetch it once via the existing GET. A failed fetch hides the checklist
  // behind a note and leaves excludedTileIds untouched.
  const openDashboard = useDashboardState((state) => state.current);
  const loadedLayout =
    openDashboard !== null && openDashboard.id === dashboardId ? openDashboard.layout : null;
  const [fetchedLayout, setFetchedLayout] = useState<DashboardLayoutDoc | 'unavailable' | null>(null);
  const [tilesOpen, setTilesOpen] = useState(false);

  useEffect(() => {
    if (loadedLayout !== null) return;
    let cancelled = false;
    runtime.api
      .getDashboard(dashboardId)
      .then((detail) => {
        if (!cancelled) setFetchedLayout(detail.layout ?? 'unavailable');
      })
      .catch(() => {
        if (!cancelled) setFetchedLayout('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [runtime, dashboardId, loadedLayout]);

  const layout = loadedLayout ?? (fetchedLayout === 'unavailable' ? null : fetchedLayout);
  const tiles = layout === null ? null : chartTilesOf(layout);
  const tileListUnavailable = loadedLayout === null && fetchedLayout === 'unavailable';
  const excluded = new Set(draft.excludedTileIds);
  const includedCount = tiles === null ? 0 : tiles.filter((tile) => !excluded.has(tile.id)).length;

  // Only the toggled id moves — ids the doc no longer knows (deleted tiles)
  // stay excluded rather than being silently dropped.
  const toggleTile = (tileId: string, include: boolean) =>
    setDraft({
      ...draft,
      excludedTileIds: include
        ? draft.excludedTileIds.filter((id) => id !== tileId)
        : [...draft.excludedTileIds, tileId],
    });

  const recipients = parseRecipients(draft.recipientsText);
  const invalidRecipients = recipients.filter((email) => !looksLikeEmail(email));
  return (
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
              setDraft({ ...draft, kind: event.target.value as SubscriptionScheduleKind })
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
                aria-label={`Send time (${scheduleTimeLabel})`}
                value={draft.timeLocal}
                onChange={(event) => setDraft({ ...draft, timeLocal: event.target.value })}
              />
              <span className="text-xs text-rcd-muted">{scheduleTimeLabel}</span>
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

      <div className="flex flex-col gap-2 rounded-md border border-rcd-border px-3 py-2">
        <p className="text-sm font-medium text-rcd-text">Email content</p>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5 text-sm text-rcd-text-2">
            Body
            <RcdSelect
              aria-label="Email body"
              value={draft.contentBody}
              onChange={(event) =>
                setDraft({ ...draft, contentBody: event.target.value as SubscriptionContentBody })
              }
            >
              <option value="charts">Charts (images)</option>
              <option value="tables">Tables</option>
              <option value="both">Charts + tables</option>
            </RcdSelect>
          </label>
          {draft.contentBody !== 'tables' && (
            <label className="flex items-center gap-1.5 text-sm text-rcd-text-2">
              Image width
              <RcdSelect
                aria-label="Image width"
                value={String(draft.imageWidth)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    imageWidth: Number(event.target.value) as SubscriptionImageWidth,
                  })
                }
              >
                <option value="480">480 Compact</option>
                <option value="600">600 Standard</option>
                <option value="900">900 Wide</option>
              </RcdSelect>
            </label>
          )}
          {draft.contentBody !== 'charts' && (
            <label className="flex items-center gap-1.5 text-sm text-rcd-text-2">
              Max rows per tile
              <RcdInput
                type="number"
                min={5}
                max={500}
                aria-label="Max rows per tile"
                value={draft.maxTableRowsText}
                onChange={(event) => setDraft({ ...draft, maxTableRowsText: event.target.value })}
                className="w-20"
              />
            </label>
          )}
        </div>
        {draftMaxTableRows(draft) === null && (
          <span className="text-xs text-[var(--rcd-status-critical)]">
            Max rows per tile must be a whole number between 5 and 500.
          </span>
        )}
        {tileListUnavailable ? (
          <span className="text-xs text-rcd-muted">
            Tile list unavailable — the saved tile selection is kept as-is.
          </span>
        ) : tiles !== null && tiles.length > 0 ? (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              className="flex cursor-pointer items-center gap-1 text-xs text-rcd-text-2 hover:text-rcd-text"
              onClick={() => setTilesOpen(!tilesOpen)}
            >
              {tilesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Tiles to include ({includedCount}/{tiles.length})
            </button>
            {tilesOpen && (
              <div className="flex max-h-40 flex-col gap-1 overflow-y-auto pl-4">
                {tiles.map((tile) => (
                  <label
                    key={tile.id}
                    className="flex cursor-pointer items-center gap-1.5 text-xs text-rcd-text"
                  >
                    <input
                      type="checkbox"
                      className="accent-[var(--rcd-accent)]"
                      checked={!excluded.has(tile.id)}
                      onChange={(event) => toggleTile(tile.id, event.target.checked)}
                    />
                    {tile.title}
                  </label>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Standalone editor dialog for ONE subscription — the manager's Edit action.
 * Same form, same draftToWire save contract as the per-dashboard dialog; the
 * dashboardId comes from the subscription row (the manager spans dashboards).
 */
export function SubscriptionEditorDialog({
  open,
  subscription,
  onClose,
  onSaved,
  onError,
}: {
  open: boolean;
  subscription: DashboardSubscription | null;
  onClose: () => void;
  /** Called after a successful save so the manager can refresh its table. */
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const runtime = useRuntime();
  const { scheduleTimeLabel } = runtime.options;
  const [draft, setDraft] = useState<SubscriptionDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<SubscriptionPreviewRequest | null>(null);

  useEffect(() => {
    setDraft(open && subscription ? draftFrom(subscription) : null);
    setSaving(false);
    setPreview(null);
  }, [open, subscription]);

  const recipients = draft ? parseRecipients(draft.recipientsText) : [];
  const invalidRecipients = recipients.filter((email) => !looksLikeEmail(email));
  const canSave =
    draft !== null &&
    draft.name.trim() !== '' &&
    recipients.length > 0 &&
    invalidRecipients.length === 0 &&
    draftMaxTableRows(draft) !== null;

  const handleSave = async () => {
    if (!draft || draft.id === null || !subscription || !canSave || saving) return;
    setSaving(true);
    try {
      await runtime.api.updateSubscription(draft.id, draftToWire(draft, subscription.dashboardId));
      onSaved();
      onClose();
    } catch (error) {
      onError(`Could not save the subscription: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <RcdDialog
      title="Edit subscription"
      open={open}
      onClose={onClose}
      footer={
        <>
          <RcdButton onClick={onClose} disabled={saving}>
            Cancel
          </RcdButton>
          <RcdButton
            disabled={draft === null || saving || draftMaxTableRows(draft) === null}
            onClick={() => {
              if (draft !== null && subscription !== null)
                setPreview(previewRequestOf(draft, subscription.dashboardId));
            }}
          >
            Preview
          </RcdButton>
          <RcdButton variant="primary" disabled={!canSave || saving} onClick={() => void handleSave()}>
            {saving ? 'Saving…' : 'Save subscription'}
          </RcdButton>
        </>
      }
    >
      {draft !== null && subscription !== null && (
        <SubscriptionForm
          draft={draft}
          setDraft={setDraft}
          scheduleTimeLabel={scheduleTimeLabel}
          dashboardId={subscription.dashboardId}
        />
      )}

      <SubscriptionPreviewDialog request={preview} onClose={() => setPreview(null)} />
    </RcdDialog>
  );
}
