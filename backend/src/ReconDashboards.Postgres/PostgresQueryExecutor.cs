using System.Diagnostics;
using NpgsqlTypes;
using Npgsql;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Postgres;

/// <summary>
/// Runs compiled SELECTs over the shared NpgsqlDataSource. The session is
/// already read-only with a statement timeout (connection string options set at
/// registration); CommandTimeout is belt-and-braces. Reads MaxRows + 1 rows so
/// truncation is detectable, never returns more than MaxRows.
/// </summary>
public sealed class PostgresQueryExecutor(NpgsqlDataSource dataSource) : IQueryExecutor
{
    public async Task<ExecutedQuery> ExecuteAsync(
        CompiledQuery query, ExecutionOptions options, CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();

        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = new NpgsqlCommand(query.Sql, connection)
        {
            CommandTimeout = Math.Max(1, options.TimeoutSeconds),
        };

        foreach (var parameter in query.Parameters)
        {
            command.Parameters.Add(ToNpgsqlParameter(parameter));
        }

        var rows = new List<object?[]>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        var truncated = false;
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            if (rows.Count >= options.MaxRows)
            {
                truncated = true;
                break;
            }

            var row = new object?[reader.FieldCount];
            for (var i = 0; i < reader.FieldCount; i++)
            {
                var value = reader.GetValue(i);
                row[i] = value is DBNull ? null : value;
            }

            rows.Add(row);
        }

        stopwatch.Stop();
        return new ExecutedQuery(rows, truncated, (int)stopwatch.ElapsedMilliseconds);
    }

    private static NpgsqlParameter ToNpgsqlParameter(QueryParameter parameter)
    {
        var elementType = parameter.Type switch
        {
            NormalizedType.Integer => NpgsqlDbType.Bigint,
            NormalizedType.Decimal => NpgsqlDbType.Numeric,
            NormalizedType.Text => NpgsqlDbType.Text,
            NormalizedType.Boolean => NpgsqlDbType.Boolean,
            NormalizedType.Date => NpgsqlDbType.Date,
            NormalizedType.Timestamp => NpgsqlDbType.Timestamp,
            NormalizedType.Uuid => NpgsqlDbType.Uuid,
            _ => throw new InvalidOperationException(
                $"Parameter '{parameter.Name}' has unsupported type {parameter.Type}."),
        };

        var npgsqlType = parameter.IsArray ? NpgsqlDbType.Array | elementType : elementType;

        return new NpgsqlParameter(parameter.Name, npgsqlType)
        {
            Value = parameter.Value switch
            {
                null => DBNull.Value,
                IReadOnlyList<object?> list when parameter.IsArray => list.ToArray(),
                var value => value,
            },
        };
    }
}
