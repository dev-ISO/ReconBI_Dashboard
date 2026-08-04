using ReconDashboards.Core.Schema;

namespace ReconDashboards.Postgres;

/// <summary>
/// Maps pg_type names to the engine's normalized types. Domains are resolved to
/// their base type (one level) and user enums are treated as Text before this
/// map is consulted. Anything unmapped — arrays ('_'-prefixed), bytea, interval,
/// time, geometry, ranges — is Other: visible but never queryable.
/// </summary>
public static class PostgresTypeMap
{
    private static readonly Dictionary<string, NormalizedType> Map = new(StringComparer.Ordinal)
    {
        ["text"] = NormalizedType.Text,
        ["varchar"] = NormalizedType.Text,
        ["bpchar"] = NormalizedType.Text,
        ["char"] = NormalizedType.Text,
        ["name"] = NormalizedType.Text,
        ["citext"] = NormalizedType.Text,
        ["int2"] = NormalizedType.Integer,
        ["int4"] = NormalizedType.Integer,
        ["int8"] = NormalizedType.Integer,
        ["numeric"] = NormalizedType.Decimal,
        ["float4"] = NormalizedType.Decimal,
        ["float8"] = NormalizedType.Decimal,
        ["money"] = NormalizedType.Decimal,
        ["bool"] = NormalizedType.Boolean,
        ["date"] = NormalizedType.Date,
        ["timestamp"] = NormalizedType.Timestamp,
        ["timestamptz"] = NormalizedType.Timestamp,
        ["uuid"] = NormalizedType.Uuid,
        ["json"] = NormalizedType.Json,
        ["jsonb"] = NormalizedType.Json,
    };

    public static NormalizedType Normalize(string typeName, string typeKind)
    {
        // User-defined enums group and filter like strings.
        if (typeKind == "e")
        {
            return NormalizedType.Text;
        }

        return Map.TryGetValue(typeName, out var normalized) ? normalized : NormalizedType.Other;
    }
}
