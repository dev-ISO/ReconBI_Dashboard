using System.Security.Cryptography;
using System.Text;

namespace ReconDashboards.Core.Schema;

/// <summary>
/// Produces a stable hash of a schema snapshot's structure so clients can
/// detect drift. Deliberately ignores row estimates and fetch time.
/// </summary>
public static class SchemaHasher
{
    public static string ComputeVersionHash(IEnumerable<TableSchema> tables, IEnumerable<ForeignKeySchema> foreignKeys)
    {
        var builder = new StringBuilder();

        foreach (var table in tables.OrderBy(t => t.Key, StringComparer.Ordinal))
        {
            builder.Append(table.Key).Append('|').Append(table.Kind).Append('\n');
            foreach (var column in table.Columns.OrderBy(c => c.Name, StringComparer.Ordinal))
            {
                builder.Append("  c:").Append(column.Name).Append('|')
                    .Append(column.RawType).Append('|')
                    .Append(column.Type).Append('|')
                    .Append(column.IsNullable).Append('\n');
            }

            builder.Append("  pk:").Append(string.Join(",", table.PrimaryKey)).Append('\n');
            foreach (var unique in table.UniqueConstraints.OrderBy(u => string.Join(",", u), StringComparer.Ordinal))
            {
                builder.Append("  uq:").Append(string.Join(",", unique)).Append('\n');
            }
        }

        foreach (var fk in foreignKeys.OrderBy(f => f.Name, StringComparer.Ordinal))
        {
            builder.Append("fk:").Append(fk.Name).Append('|')
                .Append(fk.FromTable).Append('(').Append(string.Join(",", fk.FromColumns)).Append(')')
                .Append("->")
                .Append(fk.ToTable).Append('(').Append(string.Join(",", fk.ToColumns)).Append(")\n");
        }

        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(builder.ToString()));
        return Convert.ToHexStringLower(bytes);
    }
}
