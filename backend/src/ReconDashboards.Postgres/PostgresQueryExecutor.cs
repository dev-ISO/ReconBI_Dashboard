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

            rows.Add(ReadRow(reader));
        }

        stopwatch.Stop();
        return new ExecutedQuery(rows, truncated, (int)stopwatch.ElapsedMilliseconds);
    }

    /// <summary>
    /// Materializes one row defensively. Internal + DbDataReader-typed (rather
    /// than inline over NpgsqlDataReader) so the overflow path below is
    /// unit-testable without a live server.
    /// </summary>
    internal static object?[] ReadRow(System.Data.Common.DbDataReader reader)
    {
        var row = new object?[reader.FieldCount];
        for (var i = 0; i < reader.FieldCount; i++)
        {
            row[i] = ReadCell(reader, i);
        }

        return row;
    }

    /// <summary>
    /// A Postgres <c>numeric</c> holds far more range and scale than
    /// System.Decimal, so materializing a perfectly legal value can throw —
    /// a division measure (CAST(x AS decimal) / y) or a very wide SUM is the
    /// usual source. That used to fail the ENTIRE query, turning one unlucky
    /// cell into a 502 for the whole chart. Here the cell degrades to NULL and
    /// the row, and every other row, survives.
    ///
    /// THE VALUE CANNOT BE RECOVERED, and that is a property of the driver,
    /// not a shortcut: Npgsql routes EVERY read of a numeric field through
    /// decimal, so GetFieldValue&lt;double&gt;, GetDouble and
    /// GetProviderSpecificValue all raise the same OverflowException, and
    /// reading it as a string is refused outright ("Reading as 'System.String'
    /// is not supported for fields having DataTypeName 'numeric'"). Verified
    /// against the real driver, not assumed — the wider-read attempt below is
    /// kept only because it costs nothing and would succeed on a provider that
    /// does offer a wider CLR target.
    ///
    /// The real mitigation is upstream: the compiler bounds the SCALE of every
    /// division it generates (QueryCompiler's ROUND wrapping), so ordinary
    /// ratios stay inside decimal and never reach this path. This guard is
    /// what makes the executor unable to crash when something still does.
    /// </summary>
    private static object? ReadCell(System.Data.Common.DbDataReader reader, int ordinal)
    {
        try
        {
            var value = reader.GetValue(ordinal);
            return value is DBNull ? null : value;
        }
        catch (Exception ex) when (ex is OverflowException or InvalidCastException)
        {
            // OverflowException = outside decimal's range; InvalidCastException =
            // a value decimal cannot express at all (NaN / +-Infinity).
            try
            {
                var wide = reader.GetFieldValue<double>(ordinal);
                return double.IsFinite(wide) ? wide : null;
            }
            catch (Exception fallback) when (
                fallback is OverflowException
                    or InvalidCastException
                    or FormatException
                    or NotSupportedException)
            {
                return null;
            }
        }
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
