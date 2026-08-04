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
