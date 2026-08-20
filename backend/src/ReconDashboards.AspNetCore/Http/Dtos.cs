using System.Text.Json;
using System.Text.Json.Serialization;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Execution;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;
using ReconDashboards.Core.Services;

namespace ReconDashboards.AspNetCore.Http;

// Wire DTOs. Enum-ish values are pre-converted to camelCase strings and the
// model definition travels as raw JSON (re-serialized via ModelJson), so the
// wire format is stable regardless of the host's MVC JSON configuration.

public sealed record MetaResponse(
    string Version,
    int MaxRows,
    int MaxJoins,
    int MaxDimensions,
    int MaxMeasures,
    int MaxFilters,
    int MaxDistinctValues,
    int MaxModelDefinitionBytes,
    int MaxDashboardLayoutBytes,
    bool CanManageShared,
    // The caller's own opaque host id, straight from ICurrentUserProvider — the
    // SAME value the share validator compares with StringComparison.Ordinal, so
    // a client-side filter built on it cannot drift from the server's rule.
    // Null when the host cannot identify the caller (anonymous meta reads).
    string? UserId);

public sealed record ConnectionResponse(string Name, string? Description, string Provider);

public sealed record CatalogColumnDto(
    string Name,
    int Ordinal,
    string RawType,
    string Type,
    bool IsNullable,
    string? Comment);

public sealed record CatalogTableDto(
    string Schema,
    string Name,
    string Key,
    string Kind,
    long? RowEstimate,
    string? Comment,
    IReadOnlyList<CatalogColumnDto> Columns,
    IReadOnlyList<string> PrimaryKey,
    IReadOnlyList<IReadOnlyList<string>> UniqueConstraints);

public sealed record CatalogForeignKeyDto(
    string Name,
    string FromTable,
    IReadOnlyList<string> FromColumns,
    string ToTable,
    IReadOnlyList<string> ToColumns,
    bool IsComposite);

public sealed record RelationshipSuggestionDto(
    string FromTable,
    string FromColumn,
    string ToTable,
    string ToColumn,
    string ConstraintName,
    bool CompositeUnsupported);

public sealed record CatalogResponse(
    string Connection,
    string VersionHash,
    DateTime FetchedAtUtc,
    IReadOnlyList<CatalogTableDto> Tables,
    IReadOnlyList<CatalogForeignKeyDto> ForeignKeys,
    IReadOnlyList<RelationshipSuggestionDto> Suggestions);

public sealed record ModelSummaryResponse(
    int Id,
    string Name,
    string? Description,
    string DataSourceName,
    bool IsShared,
    bool OwnerIsMe,
    DateTime UpdatedAtUtc,
    bool IsSystem);

public sealed record ModelResponse(
    int Id,
    string Name,
    string? Description,
    string DataSourceName,
    bool IsShared,
    bool OwnerIsMe,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    bool IsSystem,
    JsonElement Definition);

public sealed record SaveModelRequest(
    string Name,
    string? Description,
    string DataSourceName,
    JsonElement Definition,
    bool IsShared = false,
    DateTime? ExpectedUpdatedAtUtc = null);

public sealed record ValidateModelRequest(string DataSourceName, JsonElement Definition);

public sealed record ValidationIssueDto(string Code, string Severity, string Message, string? Path);

public sealed record ValidateModelResponse(bool Valid, IReadOnlyList<ValidationIssueDto> Issues);

/// <summary>
/// The portable model document: the body of GET /models/{id}/export and,
/// unchanged, the body POST /models/import accepts back. Carries no id, owner
/// or sharing flag — those belong to the installation, not the definition.
/// </summary>
public sealed record ModelExportResponse(
    string Name,
    string? Description,
    string DataSourceName,
    JsonElement Definition);

/// <summary>POST /models/import body — an export document, possibly renamed.</summary>
public sealed record ImportModelRequest(
    string Name,
    string? Description,
    string DataSourceName,
    JsonElement Definition);

/// <summary>The caller's rights on one dashboard (canEdit = owner || admin || any flag).</summary>
public sealed record DashboardAccessResponse(
    bool IsOwner,
    bool CanEdit,
    bool CanEditLayout,
    bool CanManagePages,
    bool CanEditCharts,
    bool CanMoveTiles,
    bool CanDeleteContent,
    bool ViaShare,
    bool ViaPublish);

public sealed record DashboardSummaryResponse(
    int Id,
    string Name,
    string? Description,
    int? ModelId,
    bool IsShared,
    bool OwnerIsMe,
    DateTime UpdatedAtUtc,
    bool IsSystem,
    string? OwnerDisplayName,
    DashboardAccessResponse MyAccess,
    int ShareCount);

public sealed record DashboardResponse(
    int Id,
    string Name,
    string? Description,
    int? ModelId,
    bool IsShared,
    bool OwnerIsMe,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    bool IsSystem,
    string? OwnerDisplayName,
    // The owner's opaque host id. The share dialog needs it to keep the owner
    // out of the picker: ValidateGrantTargets rejects the owner as a grant
    // target and fails the WHOLE save, so an admin editing someone else's
    // shares would otherwise lose every other pick along with it.
    string OwnerUserId,
    DashboardAccessResponse MyAccess,
    int ShareCount,
    JsonElement Layout);

public sealed record SaveDashboardRequest(
    string Name,
    string? Description,
    int? ModelId,
    JsonElement Layout,
    bool IsShared = false,
    DateTime? ExpectedUpdatedAtUtc = null);

public sealed record DashboardShareResponse(
    string UserId,
    string? DisplayName,
    bool CanEditLayout,
    bool CanManagePages,
    bool CanEditCharts,
    bool CanMoveTiles,
    bool CanDeleteContent,
    string GrantedByUserId,
    string? GrantedByDisplayName,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc);

public sealed record DashboardSharesResponse(IReadOnlyList<DashboardShareResponse> Shares);

/// <summary>The 0.11.1 flags default false so pre-0.11.1 bodies still bind.</summary>
public sealed record ShareGrantRequest(
    string UserId,
    bool CanEditLayout,
    bool CanManagePages,
    bool CanEditCharts,
    bool CanMoveTiles = false,
    bool CanDeleteContent = false);

/// <summary>PUT dashboards/{id}/shares body: REPLACES the full grant set.</summary>
public sealed record SaveDashboardSharesRequest(IReadOnlyList<ShareGrantRequest> Shares);

/// <summary>
/// POST dashboards/{id}/ops body: ONE element-scoped collaborative edit
/// (COLLAB-DESIGN wave 1). payload.kind selects from the closed op vocabulary
/// (tileUpsert/tileRemove/tileGeometry, pageAdd/pageRename/pageColor/pageSet/
/// pageRemove/pageReorder, docElementUpsert/docElementRemove/docSettingSet);
/// payloads are STRICT — unknown extra fields are rejected, never ignored.
/// The server classifies by DIFF and gates on the caller's share flags.
/// baseUpdatedAtUtc is informational — ops are last-writer-wins per element,
/// never stamp-rejected.
/// </summary>
public sealed record DashboardOpRequest(
    string OpId,
    string TargetKind,
    string? TargetId,
    JsonElement Payload,
    DateTime? BaseUpdatedAtUtc = null);

/// <summary>The committed op's receipt; updatedAtUtc is the client's new concurrency baseline.
/// class is "layout|pages|charts|geometry|removal", or "none" for an idempotent no-op replay.</summary>
public sealed record DashboardOpResponse(
    string OpId,
    string Class,
    DateTime UpdatedAtUtc);

/// <summary>The soft tile lock the caller now holds (acquire and heartbeat share this shape).</summary>
public sealed record DashboardTileLockResponse(
    string TileId,
    string HolderUserId,
    string? HolderDisplayName,
    DateTime AcquiredAtUtc,
    DateTime ExpiresAtUtc);

/// <summary>Detail is the stored DetailJson re-emitted verbatim (camelCase), or null.</summary>
public sealed record ActivityEntryResponse(
    long Id,
    string UserId,
    string? DisplayName,
    string Action,
    JsonElement? Detail,
    DateTime AtUtc);

public sealed record DashboardActivityResponse(IReadOnlyList<ActivityEntryResponse> Entries);

public sealed record RcdUserResponse(string Id, string DisplayName, string? Email);

/// <summary>POST /query/underlying body. MaxRows defaults to 1000 and clamps to [1, 10000].</summary>
public sealed record UnderlyingRequest(ChartQuerySpec Spec, int? MaxRows = null);

public sealed record QueryColumnDto(
    string Name,
    string Label,
    string Role,
    string Type,
    string? Source,
    string? DateBucket,
    string? FormatHint,
    string? FormatString = null);

public sealed record QueryWarningDto(string Code, string Message);

public sealed record QueryMetaDto(
    int RowCount,
    bool Truncated,
    int ElapsedMs,
    IReadOnlyList<QueryWarningDto> Warnings,
    string? Sql);

public sealed record QueryResponse(
    IReadOnlyList<QueryColumnDto> Columns,
    IReadOnlyList<object?[]> Rows,
    QueryMetaDto Meta);

public static class DtoMapping
{
    private static string Camel(string value) => JsonNamingPolicy.CamelCase.ConvertName(value);

    public static CatalogResponse ToCatalogResponse(DatabaseSchema schema)
    {
        var tables = schema.Tables
            .Select(t => new CatalogTableDto(
                t.Schema, t.Name, t.Key, Camel(t.Kind.ToString()), t.RowEstimate, t.Comment,
                t.Columns.Select(c => new CatalogColumnDto(
                    c.Name, c.Ordinal, c.RawType, Camel(c.Type.ToString()), c.IsNullable, c.Comment)).ToArray(),
                t.PrimaryKey,
                t.UniqueConstraints))
            .ToArray();

        var foreignKeys = schema.ForeignKeys
            .Select(fk => new CatalogForeignKeyDto(
                fk.Name, fk.FromTable, fk.FromColumns, fk.ToTable, fk.ToColumns, fk.IsComposite))
            .ToArray();

        var suggestions = RelationshipSuggester.Suggest(schema)
            .Select(s => new RelationshipSuggestionDto(
                s.FromTable, s.FromColumn, s.ToTable, s.ToColumn, s.ConstraintName, s.CompositeUnsupported))
            .ToArray();

        return new CatalogResponse(
            schema.ConnectionName, schema.VersionHash, schema.FetchedAtUtc, tables, foreignKeys, suggestions);
    }

    public static ModelResponse ToModelResponse(SemanticModel model, string currentUserId, bool isSystem)
    {
        using var doc = JsonDocument.Parse(ModelJson.Serialize(model.Definition));
        return new ModelResponse(
            model.Id, model.Name, model.Description, model.DataSourceName, model.IsShared,
            string.Equals(model.OwnerUserId, currentUserId, StringComparison.Ordinal),
            model.CreatedAtUtc, model.UpdatedAtUtc, isSystem,
            doc.RootElement.Clone());
    }

    /// <summary>
    /// Serializes the definition through ModelJson so an exported file is
    /// byte-for-byte what the engine persists, independent of the host's MVC
    /// JSON settings.
    /// </summary>
    public static ModelExportResponse ToModelExportResponse(ModelExportDocument document)
    {
        using var doc = JsonDocument.Parse(ModelJson.Serialize(document.Definition));
        return new ModelExportResponse(
            document.Name, document.Description, document.DataSourceName, doc.RootElement.Clone());
    }

    public static ValidationIssueDto ToIssueDto(ValidationIssue issue) =>
        new(issue.Code, issue.Severity.ToString().ToLowerInvariant(), issue.Message, issue.Path);

    public static QueryResponse ToQueryResponse(QueryOutcome outcome, bool includeSql)
    {
        var columns = outcome.Compiled.Columns
            .Select(c => new QueryColumnDto(
                c.Name,
                c.Label,
                Camel(c.Role.ToString()),
                Camel(c.Type.ToString()),
                c.Source,
                c.DateBucket is { } bucket ? Camel(bucket.ToString()) : null,
                c.FormatHint,
                c.FormatString))
            .ToArray();

        var warnings = outcome.Compiled.Warnings
            .Select(w => new QueryWarningDto(w.Code, w.Message))
            .ToArray();

        return new QueryResponse(
            columns,
            outcome.Rows,
            new QueryMetaDto(
                outcome.Rows.Count,
                outcome.Truncated,
                outcome.ElapsedMs,
                warnings,
                includeSql ? outcome.Compiled.Sql : null));
    }
}
