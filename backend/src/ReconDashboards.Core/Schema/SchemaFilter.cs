using ReconDashboards.Core.Options;

namespace ReconDashboards.Core.Schema;

/// <summary>
/// Applies a data source's allowlist to a raw introspection result. Matching is
/// exact and case-sensitive against catalog names. Foreign keys with either
/// endpoint filtered out are dropped.
/// </summary>
public static class SchemaFilter
{
    public static DatabaseSchema Apply(DatabaseSchema raw, DataSourceOptions options)
    {
        var tables = raw.Tables.Where(t => IsAllowed(t, options)).ToArray();
        var allowedKeys = tables.Select(t => t.Key).ToHashSet(StringComparer.Ordinal);
        var foreignKeys = raw.ForeignKeys
            .Where(fk => allowedKeys.Contains(fk.FromTable) && allowedKeys.Contains(fk.ToTable))
            .ToArray();

        return raw with { Tables = tables, ForeignKeys = foreignKeys };
    }

    public static bool IsAllowed(TableSchema table, DataSourceOptions options)
    {
        if (options.DeniedTables.Contains(table.Key, StringComparer.Ordinal)
            || options.DeniedTables.Contains(table.Name, StringComparer.Ordinal))
        {
            return false;
        }

        if (options.AllowedTables.Count > 0)
        {
            return options.AllowedTables.Contains(table.Key, StringComparer.Ordinal);
        }

        return options.AllowedSchemas.Contains(table.Schema, StringComparer.Ordinal);
    }
}
