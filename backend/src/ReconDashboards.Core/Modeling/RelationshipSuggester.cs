using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Modeling;

/// <summary>One FK-derived suggestion for the modeling canvas.</summary>
public sealed record RelationshipSuggestion(
    string FromTable,
    string FromColumn,
    string ToTable,
    string ToColumn,
    string ConstraintName,
    bool CompositeUnsupported);

/// <summary>
/// Turns declared foreign keys into relationship suggestions. Single-column FKs
/// become accept-able many-to-one edges (FK side = many). Composite FKs are
/// surfaced dimmed so the GUI can communicate the v1 limitation.
/// </summary>
public static class RelationshipSuggester
{
    public static IReadOnlyList<RelationshipSuggestion> Suggest(
        DatabaseSchema schema,
        ModelDefinition? existingModel = null)
    {
        var suggestions = new List<RelationshipSuggestion>();

        foreach (var fk in schema.ForeignKeys)
        {
            if (fk.IsComposite)
            {
                suggestions.Add(new RelationshipSuggestion(
                    fk.FromTable, string.Join(",", fk.FromColumns),
                    fk.ToTable, string.Join(",", fk.ToColumns),
                    fk.Name, CompositeUnsupported: true));
                continue;
            }

            var fromColumn = fk.FromColumns[0];
            var toColumn = fk.ToColumns[0];

            var alreadyModeled = existingModel?.Relationships.Any(r =>
                (string.Equals(r.FromTable, fk.FromTable, StringComparison.Ordinal)
                    && string.Equals(r.FromColumn, fromColumn, StringComparison.Ordinal)
                    && string.Equals(r.ToTable, fk.ToTable, StringComparison.Ordinal)
                    && string.Equals(r.ToColumn, toColumn, StringComparison.Ordinal))
                || (string.Equals(r.ToTable, fk.FromTable, StringComparison.Ordinal)
                    && string.Equals(r.ToColumn, fromColumn, StringComparison.Ordinal)
                    && string.Equals(r.FromTable, fk.ToTable, StringComparison.Ordinal)
                    && string.Equals(r.FromColumn, toColumn, StringComparison.Ordinal))) ?? false;

            if (!alreadyModeled)
            {
                suggestions.Add(new RelationshipSuggestion(
                    fk.FromTable, fromColumn, fk.ToTable, toColumn, fk.Name, CompositeUnsupported: false));
            }
        }

        return suggestions;
    }
}
