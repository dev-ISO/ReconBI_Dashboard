using System.Text.Json;
using System.Text.Json.Serialization;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Execution;
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
    int MaxDashboardLayoutBytes);

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
    DateTime UpdatedAtUtc);

public sealed record ModelResponse(
    int Id,
    string Name,
    string? Description,
    string DataSourceName,
    bool IsShared,
    bool OwnerIsMe,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
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

public sealed record DashboardSummaryResponse(
    int Id,
    string Name,
    string? Description,
    int? ModelId,
    bool IsShared,
    bool OwnerIsMe,
    DateTime UpdatedAtUtc);

public sealed record DashboardResponse(
    int Id,
    string Name,
    string? Description,
    int? ModelId,
    bool IsShared,
    bool OwnerIsMe,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    JsonElement Layout);

public sealed record SaveDashboardRequest(
    string Name,
    string? Description,
    int? ModelId,
    JsonElement Layout,
    bool IsShared = false,
    DateTime? ExpectedUpdatedAtUtc = null);

public sealed record QueryColumnDto(
    string Name,
    string Label,
    string Role,
    string Type,
    string? Source,
    string? DateBucket,
    string? FormatHint);

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

    public static ModelResponse ToModelResponse(SemanticModel model, string currentUserId)
    {
        using var doc = JsonDocument.Parse(ModelJson.Serialize(model.Definition));
        return new ModelResponse(
            model.Id, model.Name, model.Description, model.DataSourceName, model.IsShared,
            string.Equals(model.OwnerUserId, currentUserId, StringComparison.Ordinal),
            model.CreatedAtUtc, model.UpdatedAtUtc,
            doc.RootElement.Clone());
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
                c.FormatHint))
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
