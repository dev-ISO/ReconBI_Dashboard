using System.Text.Json.Serialization;
using ReconDashboards.Core.Json;

namespace ReconDashboards.Core.Persistence;

/// <summary>rcd_data_models — semantic model definitions. OwnerUserId is an opaque host-supplied id; no FK to host tables.</summary>
public sealed class DataModelRecord
{
    public int Id { get; set; }
    public string DataSourceName { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    public string DefinitionJson { get; set; } = "";
    public string OwnerUserId { get; set; } = "";
    public bool IsShared { get; set; }
    public bool IsDeleted { get; set; }
    public DateTime CreatedAtUtc { get; set; }
    public DateTime UpdatedAtUtc { get; set; }
}

/// <summary>rcd_dashboards — layout + tiles as validated JSON. ModelId is informational (tiles carry their own refs).</summary>
public sealed class DashboardRecord
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    public int? ModelId { get; set; }
    public string LayoutJson { get; set; } = "";
    public string OwnerUserId { get; set; } = "";
    public bool IsShared { get; set; }
    public bool IsDeleted { get; set; }
    public DateTime CreatedAtUtc { get; set; }
    public DateTime UpdatedAtUtc { get; set; }
}

/// <summary>
/// rcd_dashboard_shares — a named-user grant on one dashboard. All flags
/// false = view-only. UserId/GrantedByUserId are opaque host ids, same
/// convention as OwnerUserId. One row per (DashboardId, UserId).
/// </summary>
public sealed class DashboardShareRecord
{
    public int Id { get; set; }
    public int DashboardId { get; set; }
    public string UserId { get; set; } = "";

    /// <summary>Doc-level settings, slicer/text/image/button tile adds/edits.</summary>
    public bool CanEditLayout { get; set; }

    /// <summary>Add/remove/rename/reorder/recolor pages (removal ALSO needs CanDeleteContent).</summary>
    public bool CanManagePages { get; set; }

    /// <summary>Add chart tiles, edit chart specs/format (never retitle — renames are owner-only).</summary>
    public bool CanEditCharts { get; set; }

    /// <summary>Move/resize tiles ("arrange tiles" — 0.11.1, backfilled from CanEditLayout).</summary>
    public bool CanMoveTiles { get; set; }

    /// <summary>Remove tiles (any kind) and pages, ON TOP of the matching class flag
    /// (0.11.1, backfilled from CanEditCharts OR CanManagePages).</summary>
    public bool CanDeleteContent { get; set; }

    public string GrantedByUserId { get; set; } = "";
    public DateTime CreatedAtUtc { get; set; }
    public DateTime UpdatedAtUtc { get; set; }
}

/// <summary>
/// rcd_dashboard_activity — append-only log per dashboard, trimmed to the
/// newest 500 rows after every insert. DetailJson carries the layout-change
/// summary ("saved") or {"targetUserIds":[...]} (share actions), camelCase.
/// </summary>
public sealed class DashboardActivityRecord
{
    public long Id { get; set; }
    public int DashboardId { get; set; }
    public string UserId { get; set; } = "";

    /// <summary>created | saved | renamed | shared | unshared | shareChanged | left | deleted | duplicated.</summary>
    public string Action { get; set; } = "";

    public string? DetailJson { get; set; }
    public DateTime AtUtc { get; set; }
}

/// <summary>How a subscription's next run is derived. Stored as small discriminated columns, never cron strings. Wire names: "interval", "daily", "weekly".</summary>
[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<SubscriptionScheduleKind>))]
public enum SubscriptionScheduleKind
{
    /// <summary>Every <see cref="SubscriptionRecord.IntervalMinutes"/> minutes.</summary>
    Interval = 0,

    /// <summary>Once a day at <see cref="SubscriptionRecord.TimeOfDayMinutesUtc"/> (schedule-zone wall time).</summary>
    Daily = 1,

    /// <summary>Once a week on <see cref="SubscriptionRecord.DayOfWeekUtc"/> at <see cref="SubscriptionRecord.TimeOfDayMinutesUtc"/> (schedule-zone wall time).</summary>
    Weekly = 2,
}

/// <summary>Snapshot delivery format. Wire names: "html", "csv".</summary>
[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<SubscriptionFormat>))]
public enum SubscriptionFormat
{
    Html = 0,
    Csv = 1,
}

/// <summary>
/// rcd_subscriptions — scheduled email snapshots of a dashboard, rendered and
/// row-filtered under the OWNER's identity. Recipients is a semicolon list.
/// Daily/weekly send times are wall-clock values in the host's configured
/// schedule zone (ReconDashboardsOptions.ScheduleTimeZoneId; default UTC) —
/// the *Utc column names below are historical and kept because rcd_ tables
/// are applied by hand via rcd_schema.sql (renaming = migration pain on every
/// host for zero user value).
/// </summary>
public sealed class SubscriptionRecord
{
    public int Id { get; set; }
    public int DashboardId { get; set; }
    public string OwnerUserId { get; set; } = "";
    public string Name { get; set; } = "";
    public SubscriptionScheduleKind ScheduleKind { get; set; }

    /// <summary>Interval kind: minutes between runs (&gt;= 5).</summary>
    public int? IntervalMinutes { get; set; }

    /// <summary>Daily/Weekly kinds: minutes past LOCAL midnight (0..1439) in the
    /// host's schedule zone. Historical column name — see the class remarks.</summary>
    public int? TimeOfDayMinutesUtc { get; set; }

    /// <summary>Weekly kind: 0 = Sunday .. 6 = Saturday (matches <see cref="DayOfWeek"/>),
    /// resolved on the schedule zone's calendar. Historical column name.</summary>
    public int? DayOfWeekUtc { get; set; }

    /// <summary>Semicolon-separated email addresses.</summary>
    public string Recipients { get; set; } = "";

    public SubscriptionFormat Format { get; set; }

    /// <summary>
    /// Email content composition (Scheduling.SubscriptionContentConfig as
    /// camelCase JSON; jsonb on Postgres). NULL = legacy behavior: tables
    /// only, 50-row cap — pre-0.14 rows are never backfilled.
    /// </summary>
    public string? ContentJson { get; set; }

    public bool Enabled { get; set; } = true;
    public DateTime? LastRunUtc { get; set; }
    public DateTime CreatedUtc { get; set; }
}

/// <summary>Comparison an alert applies to its single evaluated value. Wire names: "gt", "gte", "lt", "lte", "eq".</summary>
[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<AlertOperator>))]
public enum AlertOperator
{
    Gt = 0,
    Gte = 1,
    Lt = 2,
    Lte = 3,
    Eq = 4,
}

/// <summary>
/// rcd_alerts — a single-value chart query (0 dimensions, 1 measure) evaluated
/// on a fixed cadence under the OWNER's identity; fires email when the
/// condition holds and the cooldown has elapsed.
/// </summary>
public sealed class AlertRecord
{
    public int Id { get; set; }
    public string OwnerUserId { get; set; } = "";
    public int? DashboardId { get; set; }
    public string Name { get; set; } = "";

    /// <summary>A ChartQuerySpec (wire JSON) producing exactly one value.</summary>
    public string SpecJson { get; set; } = "";

    public AlertOperator Operator { get; set; }
    public decimal Threshold { get; set; }

    /// <summary>Semicolon-separated email addresses.</summary>
    public string Recipients { get; set; } = "";

    /// <summary>Evaluation cadence in minutes (min 5).</summary>
    public int EveryMinutes { get; set; }

    /// <summary>Minutes after a firing during which the alert stays silent.</summary>
    public int CooldownMinutes { get; set; }

    public bool Enabled { get; set; } = true;
    public DateTime? LastEvaluatedUtc { get; set; }
    public DateTime? LastFiredUtc { get; set; }
    public decimal? LastValue { get; set; }
    public DateTime CreatedUtc { get; set; }
}

/// <summary>What started a dispatch. Wire names: "schedule", "manual".</summary>
[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<DispatchTrigger>))]
public enum DispatchTrigger
{
    /// <summary>The minute scheduler found the subscription due.</summary>
    Schedule = 0,

    /// <summary>A user clicked Send now (RequestedBy records who).</summary>
    Manual = 1,
}

/// <summary>
/// Occurrence-level outcome of a dispatch. Wire names: "running", "sent",
/// "partial", "failed", "skipped".
/// </summary>
[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<DispatchStatus>))]
public enum DispatchStatus
{
    /// <summary>Recipients still pending (first pass or in-process retries).</summary>
    Running = 0,

    /// <summary>Every attempted recipient was delivered (opt-outs do not count against this).</summary>
    Sent = 1,

    /// <summary>Some recipients delivered, some exhausted their retries.</summary>
    Partial = 2,

    /// <summary>No recipient could be delivered, or the occurrence-level render failed.</summary>
    Failed = 3,

    /// <summary>Nothing was attempted (dashboard gone/not visible to owner, no model, no recipients) — reason in Error.</summary>
    Skipped = 4,
}

/// <summary>
/// Per-recipient outcome inside one dispatch. Wire names: "pending", "sent",
/// "failed", "optedOut". Pending exists beyond the design sketch because the
/// open-tracking pixel signs the RECIPIENT ROW id — the row must exist before
/// the email is built — and because the manager UI polls recipient rows while
/// a send is still running/retrying.
/// </summary>
[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<DispatchRecipientStatus>))]
public enum DispatchRecipientStatus
{
    /// <summary>Send in flight or awaiting an in-process retry.</summary>
    Pending = 0,

    Sent = 1,

    /// <summary>All (up to 3) attempts failed; Error holds the last failure.</summary>
    Failed = 2,

    /// <summary>Matched an opt-out row (per-subscription or global); never attempted.</summary>
    OptedOut = 3,
}

/// <summary>
/// rcd_subscription_dispatches — one row per delivery occurrence (scheduled or
/// manual send-now) per subscription; the audit truth for "did it send".
/// Deliberately NO foreign key to rcd_subscriptions: history must survive
/// subscription deletion, so SubscriptionName is snapshotted (same pattern as
/// the tracker's NotificationDelivery copying Title). LastRunUtc on the
/// subscription stays the scheduler's due-math cache only.
/// </summary>
public sealed class SubscriptionDispatchRecord
{
    public long Id { get; set; }
    public int SubscriptionId { get; set; }

    /// <summary>Snapshot of the subscription's name at dispatch time.</summary>
    public string SubscriptionName { get; set; } = "";

    /// <summary>
    /// Snapshot of the subscription's owner. Not in the design sketch, but the
    /// close-time notifier seams target the OWNER and history must remain
    /// readable (and attributable) after the subscription row is deleted —
    /// the same reason SubscriptionName is snapshotted.
    /// </summary>
    public string OwnerUserId { get; set; } = "";

    public int DashboardId { get; set; }
    public DispatchTrigger Trigger { get; set; }

    /// <summary>Opaque user id for manual sends; null for scheduled runs.</summary>
    public string? RequestedBy { get; set; }

    public DateTime StartedUtc { get; set; }
    public DateTime? FinishedUtc { get; set; }
    public DispatchStatus Status { get; set; }

    /// <summary>Occurrence-level error (render failure, skip reason); per-recipient errors live on the recipient rows.</summary>
    public string? Error { get; set; }
}

/// <summary>
/// rcd_subscription_dispatch_recipients — one row per recipient per dispatch.
/// OpenedUtc/OpenCount come from the tracking pixel and are inherently
/// approximate (image proxies, blocked images, Cloudflare Access in front of
/// the app) — surfaced as "Opened (approximate)", never as a read receipt.
/// </summary>
public sealed class SubscriptionDispatchRecipientRecord
{
    public long Id { get; set; }
    public long DispatchId { get; set; }
    public string Email { get; set; } = "";
    public DispatchRecipientStatus Status { get; set; }

    /// <summary>Send attempts so far (0 for opted-out recipients; max 3).</summary>
    public int Attempts { get; set; }

    /// <summary>Last attempt's failure message; null once sent.</summary>
    public string? Error { get; set; }

    public DateTime? SentUtc { get; set; }

    /// <summary>First pixel hit; later hits only increment OpenCount.</summary>
    public DateTime? OpenedUtc { get; set; }

    public int OpenCount { get; set; }
}

/// <summary>
/// rcd_subscription_optouts — per-subscription recipient opt-outs (the
/// unsubscribe target). Composite key: one row per (SubscriptionId, Email).
/// Emails are stored lower-cased so matching is case-insensitive.
/// </summary>
public sealed class SubscriptionOptOutRecord
{
    public int SubscriptionId { get; set; }
    public string Email { get; set; } = "";
    public DateTime OptedOutUtc { get; set; }
}

/// <summary>
/// rcd_global_optouts — suppresses an address from EVERY dashboard
/// subscription email (checked before the per-subscription table). Clearing
/// is admin-only. Emails are stored lower-cased.
/// </summary>
public sealed class GlobalOptOutRecord
{
    public string Email { get; set; } = "";
    public DateTime OptedOutUtc { get; set; }
}

/// <summary>
/// rcd_user_settings — ONE row per user holding that user's private preference
/// document. Deliberately generic: a single server-opaque JSON blob (parsed and
/// re-serialized, never schema-validated) so later preference waves add a
/// top-level section instead of a migration. Mirrors the tracker host's
/// AppUser.UiSettingsJson mechanism, which the library cannot reuse — that is a
/// different DbContext on a possibly different database.
///
/// Natural key, no surrogate id (GlobalOptOutRecord precedent): UserId is the
/// opaque host-supplied id at the established 128-char width shared by every
/// owner/user column here, and no foreign key ever points at a host user table.
/// The key IS the authorization boundary — the service only ever reads and
/// writes the row for ICurrentUserProvider.GetUserId(), and no user id is
/// accepted from the wire.
/// </summary>
public sealed class UserSettingsRecord
{
    public string UserId { get; set; } = "";

    /// <summary>Whole document, last-write-wins. Never interpreted by the server.</summary>
    public string SettingsJson { get; set; } = "";

    public DateTime UpdatedAtUtc { get; set; }
}

/// <summary>rcd_query_audit — written only when EnableQueryAudit; retention is host-driven.</summary>
public sealed class QueryAuditRecord
{
    public long Id { get; set; }
    public string UserId { get; set; } = "";
    public string DataSourceName { get; set; } = "";
    public int? ModelId { get; set; }
    public string SpecJson { get; set; } = "";
    public string SqlHash { get; set; } = "";
    public int RowCount { get; set; }
    public int ElapsedMs { get; set; }
    public bool Succeeded { get; set; }
    public string? ErrorCode { get; set; }
    public DateTime ExecutedAtUtc { get; set; }
}
