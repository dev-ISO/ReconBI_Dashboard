using Npgsql;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Postgres;

/// <summary>
/// Reads the catalog straight from pg_catalog (not information_schema): one
/// round trip per query, row estimates and matviews included. Returns the RAW
/// schema — allowlist filtering and hashing happen in the schema cache.
/// </summary>
public sealed class PostgresSchemaIntrospector(NpgsqlDataSource dataSource, string connectionName)
    : ISchemaIntrospector
{
    private const string NamespaceFilter = """
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\_toast%'
        AND n.nspname NOT LIKE 'pg\_temp%'
        """;

    private const string TablesSql = $"""
        SELECT n.nspname,
               c.relname,
               c.relkind::text,
               c.reltuples::bigint,
               obj_description(c.oid, 'pg_class')
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        {NamespaceFilter}
        ORDER BY n.nspname, c.relname
        """;

    private const string ColumnsSql = $"""
        SELECT n.nspname,
               c.relname,
               a.attname,
               a.attnum,
               pg_catalog.format_type(a.atttypid, a.atttypmod),
               COALESCE(bt.typname, t.typname),
               COALESCE(bt.typtype, t.typtype)::text,
               NOT a.attnotnull,
               col_description(c.oid, a.attnum)
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
        LEFT JOIN pg_catalog.pg_type bt ON t.typtype = 'd' AND bt.oid = t.typbasetype
        WHERE a.attnum > 0
          AND NOT a.attisdropped
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        {NamespaceFilter}
        ORDER BY n.nspname, c.relname, a.attnum
        """;

    private const string KeysSql = $"""
        SELECT n.nspname,
               c.relname,
               con.conname,
               con.contype::text,
               a.attname,
               k.ordinality
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ordinality)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE con.contype IN ('p', 'u')
        {NamespaceFilter}
        ORDER BY n.nspname, c.relname, con.conname, k.ordinality
        """;

    private const string ForeignKeysSql = """
        SELECT con.conname,
               sn.nspname,
               sc.relname,
               sa.attname,
               tn.nspname,
               tc.relname,
               ta.attname,
               k.ordinality
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class sc ON sc.oid = con.conrelid
        JOIN pg_catalog.pg_namespace sn ON sn.oid = sc.relnamespace
        JOIN pg_catalog.pg_class tc ON tc.oid = con.confrelid
        JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
        CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ordinality)
        JOIN pg_catalog.pg_attribute sa ON sa.attrelid = sc.oid AND sa.attnum = k.attnum
        JOIN pg_catalog.pg_attribute ta ON ta.attrelid = tc.oid AND ta.attnum = con.confkey[k.ordinality]
        WHERE con.contype = 'f'
          AND sn.nspname NOT IN ('pg_catalog', 'information_schema')
          AND sn.nspname NOT LIKE 'pg\_toast%'
          AND sn.nspname NOT LIKE 'pg\_temp%'
        ORDER BY sn.nspname, sc.relname, con.conname, k.ordinality
        """;

    public async Task<DatabaseSchema> IntrospectAsync(CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);

        var tableShells = await ReadTablesAsync(connection, cancellationToken).ConfigureAwait(false);
        var columnsByTable = await ReadColumnsAsync(connection, cancellationToken).ConfigureAwait(false);
        var keysByTable = await ReadKeysAsync(connection, cancellationToken).ConfigureAwait(false);
        var foreignKeys = await ReadForeignKeysAsync(connection, cancellationToken).ConfigureAwait(false);

        var tables = new List<TableSchema>(tableShells.Count);
        foreach (var shell in tableShells)
        {
            columnsByTable.TryGetValue(shell.Key, out var columns);
            keysByTable.TryGetValue(shell.Key, out var keys);

            var primaryKey = keys?.FirstOrDefault(k => k.Type == "p")?.Columns ?? [];
            var uniques = keys?.Where(k => k.Type == "u").Select(k => (IReadOnlyList<string>)k.Columns).ToArray()
                ?? [];

            tables.Add(shell.Table with
            {
                Columns = columns ?? [],
                PrimaryKey = primaryKey,
                UniqueConstraints = uniques,
            });
        }

        return new DatabaseSchema(
            connectionName,
            DateTime.UtcNow,
            VersionHash: "",
            tables,
            foreignKeys);
    }

    private sealed record TableShell(string Key, TableSchema Table);

    private sealed record KeyConstraint(string Type, List<string> Columns);

    private static async Task<List<TableShell>> ReadTablesAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        var result = new List<TableShell>();
        await using var command = new NpgsqlCommand(TablesSql, connection);
        await using var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await reader.ReadAsync(ct).ConfigureAwait(false))
        {
            var schema = reader.GetString(0);
            var name = reader.GetString(1);
            var relkind = reader.GetString(2);
            var rowEstimate = reader.GetInt64(3);
            var comment = reader.IsDBNull(4) ? null : reader.GetString(4);

            var kind = relkind switch
            {
                "v" => TableKind.View,
                "m" => TableKind.MaterializedView,
                "f" => TableKind.ForeignTable,
                _ => TableKind.Table,
            };

            var table = new TableSchema(
                schema, name, kind,
                RowEstimate: rowEstimate < 0 ? null : rowEstimate,
                comment,
                Columns: [], PrimaryKey: [], UniqueConstraints: []);
            result.Add(new TableShell(table.Key, table));
        }

        return result;
    }

    private static async Task<Dictionary<string, List<ColumnSchema>>> ReadColumnsAsync(
        NpgsqlConnection connection, CancellationToken ct)
    {
        var result = new Dictionary<string, List<ColumnSchema>>(StringComparer.Ordinal);
        await using var command = new NpgsqlCommand(ColumnsSql, connection);
        await using var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await reader.ReadAsync(ct).ConfigureAwait(false))
        {
            var key = $"{reader.GetString(0)}.{reader.GetString(1)}";
            var column = new ColumnSchema(
                Name: reader.GetString(2),
                Ordinal: reader.GetInt16(3),
                RawType: reader.GetString(4),
                Type: PostgresTypeMap.Normalize(reader.GetString(5), reader.GetString(6)),
                IsNullable: reader.GetBoolean(7),
                Comment: reader.IsDBNull(8) ? null : reader.GetString(8));

            if (!result.TryGetValue(key, out var list))
            {
                result[key] = list = [];
            }

            list.Add(column);
        }

        return result;
    }

    private static async Task<Dictionary<string, List<KeyConstraint>>> ReadKeysAsync(
        NpgsqlConnection connection, CancellationToken ct)
    {
        var byTableAndConstraint = new Dictionary<string, Dictionary<string, KeyConstraint>>(StringComparer.Ordinal);
        await using var command = new NpgsqlCommand(KeysSql, connection);
        await using var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await reader.ReadAsync(ct).ConfigureAwait(false))
        {
            var tableKey = $"{reader.GetString(0)}.{reader.GetString(1)}";
            var constraintName = reader.GetString(2);
            var constraintType = reader.GetString(3);
            var columnName = reader.GetString(4);

            if (!byTableAndConstraint.TryGetValue(tableKey, out var constraints))
            {
                byTableAndConstraint[tableKey] = constraints = new Dictionary<string, KeyConstraint>(StringComparer.Ordinal);
            }

            if (!constraints.TryGetValue(constraintName, out var constraint))
            {
                constraints[constraintName] = constraint = new KeyConstraint(constraintType, []);
            }

            constraint.Columns.Add(columnName);
        }

        return byTableAndConstraint.ToDictionary(
            kvp => kvp.Key,
            kvp => kvp.Value.Values.ToList(),
            StringComparer.Ordinal);
    }

    private static async Task<List<ForeignKeySchema>> ReadForeignKeysAsync(
        NpgsqlConnection connection, CancellationToken ct)
    {
        // conname is unique per table, not globally — key on (fromTable, conname).
        var ordered = new List<string>();
        var byKey = new Dictionary<string, (string Name, string FromTable, List<string> FromColumns, string ToTable, List<string> ToColumns)>(StringComparer.Ordinal);

        await using var command = new NpgsqlCommand(ForeignKeysSql, connection);
        await using var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await reader.ReadAsync(ct).ConfigureAwait(false))
        {
            var name = reader.GetString(0);
            var fromTable = $"{reader.GetString(1)}.{reader.GetString(2)}";
            var fromColumn = reader.GetString(3);
            var toTable = $"{reader.GetString(4)}.{reader.GetString(5)}";
            var toColumn = reader.GetString(6);

            var key = $"{fromTable}::{name}";
            if (!byKey.TryGetValue(key, out var entry))
            {
                byKey[key] = entry = (name, fromTable, [], toTable, []);
                ordered.Add(key);
            }

            entry.FromColumns.Add(fromColumn);
            entry.ToColumns.Add(toColumn);
        }

        return ordered
            .Select(key => byKey[key])
            .Select(e => new ForeignKeySchema(e.Name, e.FromTable, e.FromColumns, e.ToTable, e.ToColumns))
            .ToList();
    }
}
