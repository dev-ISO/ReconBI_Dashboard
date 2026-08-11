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
/// rcd_dashboard_shares — a named-user grant on one dashboard. All three flags
/// false = view-only. UserId/GrantedByUserId are opaque host ids, same
/// convention as OwnerUserId. One row per (DashboardId, UserId).
/// </summary>
public sealed class DashboardShareRecord
{
    public int Id { get; set; }
    public int DashboardId { get; set; }
    public string UserId { get; set; } = "";

    /// <summary>Move/resize tiles, doc-level settings, slicer/text/image tiles.</summary>
    public bool CanEditLayout { get; set; }

    /// <summary>Add/remove/rename/reorder/recolor pages.</summary>
    public bool CanManagePages { get; set; }

    /// <summary>Add/remove tiles, edit chart specs/format.</summary>
    public bool CanEditCharts { get; set; }

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

    /// <summary>Once a day at <see cref="SubscriptionRecord.TimeOfDayMinutesUtc"/> (UTC).</summary>
    Daily = 1,

    /// <summary>Once a week on <see cref="SubscriptionRecord.DayOfWeekUtc"/> at <see cref="SubscriptionRecord.TimeOfDayMinutesUtc"/> (UTC).</summary>
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
/// All times are UTC (DST-agnostic by construction).
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

    /// <summary>Daily/Weekly kinds: minutes past UTC midnight (0..1439).</summary>
    public int? TimeOfDayMinutesUtc { get; set; }

    /// <summary>Weekly kind: 0 = Sunday .. 6 = Saturday (matches <see cref="DayOfWeek"/>).</summary>
    public int? DayOfWeekUtc { get; set; }

    /// <summary>Semicolon-separated email addresses.</summary>
    public string Recipients { get; set; } = "";

    public SubscriptionFormat Format { get; set; }
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
