import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Mail, Pencil, Plus, Settings2, Trash2 } from 'lucide-react';
import type {
  ChartType,
  DashboardLayoutDoc,
  DashboardSubscription,
  RcdUser,
  SaveSubscriptionBody,
  SubscriptionContentBody,
  SubscriptionContentConfig,
  SubscriptionImageWidth,
  SubscriptionScheduleKind,
} from '@recon/dashboards-core';
import { useDashboardState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdDialog, RcdIconButton, RcdInput, RcdSelect, RcdSpinner } from '../primitives';
import { chartTypeLabel } from '../chart-builder/chartTypeMeta';
import { DeliveryBadge, EnabledToggle } from './deliveryBadge';
import { SubscriptionPreviewDialog, type SubscriptionPreviewRequest } from './SubscriptionPreviewDialog';
import { UserPicker, type UserPickerChip } from './UserPicker';

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

/**
 * The ';'-joined recipients string is stored in a varchar(2048) column
 * (ReconDashboardsDbContext: Recipients.HasMaxLength(2048)) — roughly 60-70
 * addresses. Free typing made that hard to reach; a picker makes bulk-add one
 * click each, so the form says so BEFORE the server truncates or rejects.
 */
export const RECIPIENTS_MAX_CHARS = 2048;

/**
 * Server cap on the excluded-tile list (SubscriptionContent.MaxExcludedTiles).
 * Exceeding it is a 400 (rcd.subscription.bad_content), so a dashboard with
 * hundreds of chart tiles must not be allowed to "Deselect all" in silence.
 */
export const MAX_EXCLUDED_TILES = 200;

/** Recipients are picked BY ADDRESS; rows with no email cannot be picked at all. */
const recipientKeyOf = (user: RcdUser): string | null => {
  const email = user.email?.trim();
  return email === undefined || email === '' ? null : email.toLowerCase();
};

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

/** One emailable chart tile in the include checklist. */
export interface SubscriptionTileEntry {
  id: string;
  title: string;
  type: ChartType;
}

/** The checklist's chart tiles for ONE dashboard page. */
export interface SubscriptionTilePage {
  pageId: string;
  pageName: string;
  tiles: SubscriptionTileEntry[];
}

/** Legacy flat docs email as one page; the backend synthesizes the same name. */
const LEGACY_PAGE_ID = '__page1';

/** Stable empty set for "no page sections known yet" (a literal would churn memos). */
const NO_PAGES: ReadonlySet<string> = new Set<string>();

/**
 * The doc's emailable chart tiles, GROUPED BY PAGE — the shape the email
 * itself has (SnapshotComposer renders one section per page), so the checklist
 * mirrors the output instead of presenting one flat list.
 *
 * The three filters match LayoutSnapshotParser exactly, so this never offers a
 * tile the email would skip: kind absent-or-'chart', a `chart` spec, and a
 * non-null `chart.query` (a chart with no query has nothing to render). Pages
 * left with no emailable tile are dropped rather than shown empty. Legacy flat
 * docs (no `pages`) synthesize the parser's own "Page 1"; a page with a blank
 * name falls back to the parser's "Page".
 */
export const chartTilesOf = (layout: DashboardLayoutDoc): SubscriptionTilePage[] => {
  const pages = layout.pages ?? [];
  const source =
    pages.length > 0
      ? pages.map((page) => ({
          pageId: page.id,
          pageName: (page.name ?? '').trim() === '' ? 'Page' : page.name.trim(),
          tiles: page.tiles,
        }))
      : [{ pageId: LEGACY_PAGE_ID, pageName: 'Page 1', tiles: layout.tiles }];

  const out: SubscriptionTilePage[] = [];
  for (const page of source) {
    const tiles: SubscriptionTileEntry[] = [];
    for (const tile of page.tiles) {
      if ((tile.kind ?? 'chart') !== 'chart') continue;
      const chart = tile.chart;
      if (chart === undefined || chart.query === undefined || chart.query === null) continue;
      const title = chart.title.trim();
      tiles.push({
        id: tile.id,
        title: title === '' ? 'Untitled chart' : title,
        type: chart.type,
      });
    }
    if (tiles.length > 0) out.push({ ...page, tiles });
  }
  return out;
};

/**
 * The checklist's Select all / Deselect all pair (the slicer checklist's
 * vocabulary). Each button disables when it would be a no-op, so the pair also
 * reads as a status: both dead = the scope is already exactly as asked.
 */
function TileSelectAll({
  title,
  deselectTitle,
  canSelect,
  canDeselect,
  onSelect,
  onDeselect,
}: {
  title: string;
  deselectTitle: string;
  canSelect: boolean;
  canDeselect: boolean;
  onSelect: () => void;
  onDeselect: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <RcdButton
        variant="ghost"
        className="!px-1.5 !py-0.5 !text-[11px]"
        disabled={!canSelect}
        title={title}
        onClick={onSelect}
      >
        Select all
      </RcdButton>
      <RcdButton
        variant="ghost"
        className="!px-1.5 !py-0.5 !text-[11px]"
        disabled={!canDeselect}
        title={deselectTitle}
        onClick={onDeselect}
      >
        Deselect all
      </RcdButton>
    </span>
  );
}

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
  const tilePages = useMemo(() => (layout === null ? null : chartTilesOf(layout)), [layout]);
  const tileListUnavailable = loadedLayout === null && fetchedLayout === 'unavailable';
  const allTiles = useMemo(
    () => (tilePages === null ? [] : tilePages.flatMap((page) => page.tiles)),
    [tilePages],
  );
  const excluded = new Set(draft.excludedTileIds);
  const includedCount = allTiles.filter((tile) => !excluded.has(tile.id)).length;

  /**
   * Which page sections are open. `null` = untouched, so the default posture
   * (FieldList's: all open when there are few, otherwise only the first) can be
   * derived once the doc actually arrives rather than seeded from nothing.
   */
  const [expandedPages, setExpandedPages] = useState<ReadonlySet<string> | null>(null);
  const defaultExpanded = useMemo(() => {
    if (tilePages === null) return null;
    const keys = tilePages.map((page) => page.pageId);
    return new Set<string>(keys.length <= 3 ? keys : keys.slice(0, 1));
  }, [tilePages]);
  const openPages = expandedPages ?? defaultExpanded ?? NO_PAGES;
  const togglePage = (pageId: string) => {
    const next = new Set(openPages);
    if (next.has(pageId)) next.delete(pageId);
    else next.add(pageId);
    setExpandedPages(next);
  };

  // Only the toggled id moves — ids the doc no longer knows (deleted tiles)
  // stay excluded rather than being silently dropped.
  const toggleTile = (tileId: string, include: boolean) =>
    setDraft({
      ...draft,
      excludedTileIds: include
        ? draft.excludedTileIds.filter((id) => id !== tileId)
        : [...draft.excludedTileIds, tileId],
    });

  /**
   * Bulk include: removes ONLY the ids passed in — the same rule toggleTile
   * follows, applied N at a time. An id the doc no longer knows is not
   * "listed", so it survives untouched. excludedTileIds is NEVER reset to [],
   * which would silently re-include tiles this subscription deliberately drops.
   */
  const includeTiles = (list: SubscriptionTileEntry[]) => {
    const listed = new Set(list.map((tile) => tile.id));
    setDraft({
      ...draft,
      excludedTileIds: draft.excludedTileIds.filter((id) => !listed.has(id)),
    });
  };

  /** Bulk exclude: APPENDS the listed ids, leaving every other id exactly where it is. */
  const excludeTiles = (list: SubscriptionTileEntry[]) => {
    const next = [...draft.excludedTileIds];
    const have = new Set(next);
    for (const tile of list) {
      if (have.has(tile.id)) continue;
      have.add(tile.id);
      next.push(tile.id);
    }
    setDraft({ ...draft, excludedTileIds: next });
  };

  const overTileCap = draft.excludedTileIds.length > MAX_EXCLUDED_TILES;

  /* ------------------------------------------------------------ recipients */
  const recipients = useMemo(() => parseRecipients(draft.recipientsText), [draft.recipientsText]);
  const recipientKeys = useMemo(
    () => new Set(recipients.map((email) => email.toLowerCase())),
    [recipients],
  );
  const invalidRecipients = recipients.filter((email) => !looksLikeEmail(email));

  /**
   * Every address the directory has shown this session, lowercased -> display
   * name. Saved subscriptions predate the picker and can hold addresses no user
   * owns (contractors, distribution lists): those are FLAGGED here, never
   * dropped — silently discarding a recipient on edit is the one outcome this
   * form must not produce. Empty until the directory answers, so an
   * unconfigured or still-loading directory flags nothing.
   */
  const [knownEmails, setKnownEmails] = useState<ReadonlyMap<string, string>>(() => new Map());
  const rememberDirectory = useCallback((users: RcdUser[]) => {
    setKnownEmails((prev) => {
      let next: Map<string, string> | null = null;
      for (const user of users) {
        const key = recipientKeyOf(user);
        if (key === null || prev.has(key)) continue;
        next ??= new Map(prev);
        next.set(key, user.displayName);
      }
      // The SAME map when nothing is new — allocating a fresh one per response
      // would re-render the whole form on every keystroke of the picker.
      return next ?? prev;
    });
  }, []);

  const directoryAnswered = knownEmails.size > 0;
  const recipientChips: UserPickerChip[] = recipients.map((email) => {
    const key = email.toLowerCase();
    const displayName = knownEmails.get(key);
    if (displayName !== undefined) return { key, label: email, title: displayName };
    return {
      key,
      label: email,
      unknown: directoryAnswered,
      title: directoryAnswered
        ? 'Not in the user directory — kept from the saved subscription and still emailed. Remove it if it should not receive this report.'
        : email,
    };
  });
  const unknownCount = recipientChips.filter((chip) => chip.unknown === true).length;

  const setRecipients = (list: string[]) =>
    setDraft({ ...draft, recipientsText: list.join(', ') });

  /** Length the ';' join will actually occupy in the varchar(2048) column. */
  const recipientsWireLength = recipients.join(';').length;
  const overRecipientCap = recipientsWireLength > RECIPIENTS_MAX_CHARS;
  const nearRecipientCap = !overRecipientCap && recipientsWireLength > RECIPIENTS_MAX_CHARS * 0.9;

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

      {/* Recipients are picked from the host user directory — free typing is
          deliberately not offered, so a report can never be scheduled to an
          address nobody in the system owns. */}
      <div className="flex flex-col gap-1">
        <UserPicker
          label={`Recipients${recipients.length === 0 ? '' : ` (${recipients.length})`}`}
          searchAriaLabel="Search people to email"
          placeholder="Search by username or email"
          emptyDirectoryNote={
            <p className="rounded-lg border border-rcd-border bg-rcd-bg px-3 py-2 text-xs text-rcd-muted">
              User directory not configured — recipients cannot be added here. The saved list is
              kept as-is.
            </p>
          }
          takenKeys={recipientKeys}
          keyOf={recipientKeyOf}
          disabledRowHint="No email address"
          onPick={(user) => {
            const email = user.email?.trim();
            if (email !== undefined && email !== '') setRecipients([...recipients, email]);
          }}
          chips={recipientChips}
          onRemoveChip={(chip) =>
            setRecipients(recipients.filter((email) => email.toLowerCase() !== chip.key))
          }
          removeChipLabel={(chip) => `Remove ${chip.label} from the recipients`}
          noMatchNote="No people match — recipients must be users in the system."
          onDirectory={rememberDirectory}
        />
        {recipients.length === 0 && (
          <span className="text-xs text-rcd-muted">
            Pick at least one person — the email only goes to users in the system.
          </span>
        )}
        {unknownCount > 0 && (
          <span className="text-xs text-rcd-muted">
            {unknownCount === 1
              ? '1 address is not in the user directory'
              : `${unknownCount} addresses are not in the user directory`}{' '}
            (dashed chips) — kept from the saved subscription and still emailed.
          </span>
        )}
        {invalidRecipients.length > 0 && (
          <span className="text-xs text-[var(--rcd-status-critical)]">
            These don&apos;t look like email addresses: {invalidRecipients.join(', ')}
          </span>
        )}
        {(nearRecipientCap || overRecipientCap) && (
          <span
            className={
              overRecipientCap
                ? 'text-xs text-[var(--rcd-status-critical)]'
                : 'text-xs text-[var(--rcd-status-warn)]'
            }
          >
            {recipientsWireLength} of {RECIPIENTS_MAX_CHARS} characters of recipients
            {overRecipientCap
              ? ' — too long to save. Remove some addresses or split this into two subscriptions.'
              : ' — close to the limit. Consider a distribution list.'}
          </span>
        )}
      </div>

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
        ) : tilePages !== null && allTiles.length > 0 ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-expanded={tilesOpen}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left text-xs text-rcd-text-2 hover:text-rcd-text"
                onClick={() => setTilesOpen(!tilesOpen)}
              >
                {tilesOpen ? (
                  <ChevronDown size={12} className="shrink-0" />
                ) : (
                  <ChevronRight size={12} className="shrink-0" />
                )}
                Tiles to include ({includedCount}/{allTiles.length})
              </button>
              <TileSelectAll
                title="Include every tile in this dashboard"
                deselectTitle="Exclude every tile in this dashboard"
                canSelect={includedCount < allTiles.length}
                canDeselect={includedCount > 0}
                onSelect={() => includeTiles(allTiles)}
                onDeselect={() => excludeTiles(allTiles)}
              />
            </div>
            {tilesOpen && (
              <div className="flex max-h-40 flex-col overflow-y-auto pl-4">
                {/* One collapsible section per dashboard page — the same
                    grouping the email itself renders (SnapshotComposer emits a
                    section per page), so what is checked here maps 1:1 to what
                    arrives in the inbox. */}
                {tilePages.map((page) => {
                  const pageOpen = openPages.has(page.pageId);
                  const pageIncluded = page.tiles.filter((tile) => !excluded.has(tile.id)).length;
                  return (
                    <div key={page.pageId} className="flex flex-col">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-expanded={pageOpen}
                          onClick={() => togglePage(page.pageId)}
                          className="flex min-w-0 flex-1 items-center gap-1 pb-1 pt-2 text-left text-xs font-medium uppercase tracking-wide text-rcd-muted hover:text-rcd-text"
                        >
                          {pageOpen ? (
                            <ChevronDown size={12} className="shrink-0" />
                          ) : (
                            <ChevronRight size={12} className="shrink-0" />
                          )}
                          <span className="truncate" title={page.pageName}>
                            {page.pageName}
                          </span>
                          <span className="shrink-0 normal-case tracking-normal">
                            ({pageIncluded}/{page.tiles.length})
                          </span>
                        </button>
                        <TileSelectAll
                          title={`Include every tile on ${page.pageName}`}
                          deselectTitle={`Exclude every tile on ${page.pageName}`}
                          canSelect={pageIncluded < page.tiles.length}
                          canDeselect={pageIncluded > 0}
                          onSelect={() => includeTiles(page.tiles)}
                          onDeselect={() => excludeTiles(page.tiles)}
                        />
                      </div>
                      {pageOpen && (
                        <div className="flex flex-col gap-1 pl-4">
                          {page.tiles.map((tile) => {
                            const typeLabel = chartTypeLabel(tile.type);
                            return (
                              // The NAME absorbs truncation (min-w-0 + truncate)
                              // and the TYPE never is: a long chart title must
                              // not push "Stacked column" out of the row.
                              <label
                                key={tile.id}
                                title={`${tile.title} — ${typeLabel}`}
                                className="flex min-w-0 cursor-pointer items-center gap-1.5 text-xs text-rcd-text"
                              >
                                <input
                                  type="checkbox"
                                  className="shrink-0 accent-[var(--rcd-accent)]"
                                  checked={!excluded.has(tile.id)}
                                  onChange={(event) => toggleTile(tile.id, event.target.checked)}
                                />
                                <span className="min-w-0 flex-1 truncate">{tile.title}</span>
                                <span className="shrink-0 text-[11px] text-rcd-muted">
                                  {typeLabel}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {overTileCap && (
              <span className="text-xs text-[var(--rcd-status-critical)]">
                {draft.excludedTileIds.length} tiles are excluded — the server accepts at most{' '}
                {MAX_EXCLUDED_TILES}. Include at least{' '}
                {draft.excludedTileIds.length - MAX_EXCLUDED_TILES} more, or this subscription will
                be rejected when you save it.
              </span>
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
