using ReconDashboards.Core.Modeling;

namespace ReconDashboards.Core.Querying.Compilation;

/// <summary>One LEFT JOIN: TableKey joined onto ParentTableKey via a modeled relationship.</summary>
public sealed record JoinStep(string TableKey, string ParentTableKey, Relationship Via);

public sealed record JoinPlan(
    string BaseTable,
    IReadOnlyList<JoinStep> Steps,
    IReadOnlyDictionary<string, string> AliasByTable)
{
    public IEnumerable<string> Tables => AliasByTable.Keys;
}

/// <summary>
/// Resolves the minimal join subtree connecting all required tables over the
/// model's ACTIVE relationships. Deterministic: BFS from the base table with
/// neighbors ordered by relationship id, aliases assigned in join order
/// (t0 = base). Disconnection and same-depth path ambiguity are hard errors
/// with actionable messages — never a silently arbitrary join.
/// </summary>
public static class JoinPathResolver
{
    public static JoinPlan Resolve(
        string baseTable,
        IReadOnlyCollection<string> requiredTables,
        IReadOnlyList<Relationship> activeRelationships,
        int maxJoins)
    {
        // Adjacency ordered by relationship id for determinism.
        var adjacency = new Dictionary<string, List<(string Neighbor, Relationship Via)>>(StringComparer.Ordinal);
        foreach (var rel in activeRelationships.OrderBy(r => r.Id.ToString(), StringComparer.Ordinal))
        {
            AddEdge(adjacency, rel.FromTable, rel.ToTable, rel);
            AddEdge(adjacency, rel.ToTable, rel.FromTable, rel);
        }

        // BFS with predecessor tracking and same-depth ambiguity detection.
        var depth = new Dictionary<string, int>(StringComparer.Ordinal) { [baseTable] = 0 };
        var predecessor = new Dictionary<string, (string Parent, Relationship Via)>(StringComparer.Ordinal);
        var ambiguous = new HashSet<string>(StringComparer.Ordinal);
        var discoveryOrder = new List<string> { baseTable };
        var queue = new Queue<string>();
        queue.Enqueue(baseTable);

        while (queue.Count > 0)
        {
            var current = queue.Dequeue();
            if (!adjacency.TryGetValue(current, out var neighbors))
            {
                continue;
            }

            foreach (var (neighbor, via) in neighbors)
            {
                if (!depth.TryGetValue(neighbor, out var existingDepth))
                {
                    depth[neighbor] = depth[current] + 1;
                    predecessor[neighbor] = (current, via);
                    discoveryOrder.Add(neighbor);
                    queue.Enqueue(neighbor);
                }
                else if (existingDepth == depth[current] + 1 && predecessor[neighbor].Parent != current)
                {
                    // Second shortest path of equal length from a different parent.
                    ambiguous.Add(neighbor);
                }
            }
        }

        // Validate reachability and unambiguity for every required table, then
        // union the predecessor chains into the join subtree.
        var neededTables = new HashSet<string>(StringComparer.Ordinal) { baseTable };
        foreach (var required in requiredTables.OrderBy(t => t, StringComparer.Ordinal))
        {
            if (!depth.ContainsKey(required))
            {
                throw new QueryCompilationException(
                    "QRY_DISCONNECTED",
                    $"Table '{required}' is not connected to '{baseTable}' through any active relationship. Add a relationship between them on the model canvas.");
            }

            var walk = required;
            while (!string.Equals(walk, baseTable, StringComparison.Ordinal))
            {
                if (ambiguous.Contains(walk))
                {
                    throw new QueryCompilationException(
                        "QRY_AMBIGUOUS_PATH",
                        $"There are multiple equally short relationship paths to '{walk}'. Deactivate one of the competing relationships so the join path is unambiguous.");
                }

                neededTables.Add(walk);
                walk = predecessor[walk].Parent;
            }
        }

        // Steps in BFS discovery order guarantee each parent precedes its child.
        var steps = discoveryOrder
            .Where(t => neededTables.Contains(t) && !string.Equals(t, baseTable, StringComparison.Ordinal))
            .Select(t => new JoinStep(t, predecessor[t].Parent, predecessor[t].Via))
            .ToArray();

        if (steps.Length > maxJoins)
        {
            throw new QueryCompilationException(
                "QRY_TOO_MANY_JOINS",
                $"This query needs {steps.Length} joins; the limit is {maxJoins}. Reduce the number of tables involved.");
        }

        var aliases = new Dictionary<string, string>(StringComparer.Ordinal) { [baseTable] = "t0" };
        for (var i = 0; i < steps.Length; i++)
        {
            aliases[steps[i].TableKey] = $"t{i + 1}";
        }

        return new JoinPlan(baseTable, steps, aliases);
    }

    private static void AddEdge(
        Dictionary<string, List<(string, Relationship)>> adjacency,
        string from,
        string to,
        Relationship via)
    {
        if (!adjacency.TryGetValue(from, out var list))
        {
            adjacency[from] = list = [];
        }

        list.Add((to, via));
    }
}
