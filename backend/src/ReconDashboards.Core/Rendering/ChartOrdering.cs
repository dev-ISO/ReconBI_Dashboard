namespace ReconDashboards.Core.Rendering;

/// <summary>
/// Manual-order reconciliation, ported from the frontend's util/ordering.ts
/// (categoryOrder/seriesOrder): listed names come first in the order given,
/// items not listed append in their CURRENT order, stale names drop silently —
/// a saved order survives renames, filters, and additions without ever hiding
/// data or throwing.
/// </summary>
public static class ChartOrdering
{
    /// <summary>
    /// Reorders <paramref name="items"/> against a persisted name order.
    /// Duplicate item names keep their current relative order (the sort is
    /// stable; duplicate ORDER entries beyond the first are ignored). An
    /// absent/empty order — or an entirely stale one — returns the items
    /// unchanged (same instance).
    /// </summary>
    public static IReadOnlyList<T> ReconcileOrderBy<T>(
        IReadOnlyList<string>? order, IReadOnlyList<T> items, Func<T, string> keyOf)
    {
        if (order is null || order.Count == 0)
        {
            return items;
        }

        var rank = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < order.Count; i++)
        {
            rank.TryAdd(order[i], i);
        }

        var listed = items.Where(item => rank.ContainsKey(keyOf(item))).ToList();
        if (listed.Count == 0)
        {
            return items;
        }

        var unlisted = items.Where(item => !rank.ContainsKey(keyOf(item)));
        // List.Sort is unstable; OrderBy is the stable sort the contract needs.
        return listed.OrderBy(item => rank[keyOf(item)]).Concat(unlisted).ToArray();
    }
}
