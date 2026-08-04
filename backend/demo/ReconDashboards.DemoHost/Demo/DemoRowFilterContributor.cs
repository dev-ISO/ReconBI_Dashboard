using ReconDashboards.Core.Abstractions;

namespace ReconDashboards.DemoHost.Demo;

/// <summary>
/// Demonstrates row-level scoping (the PSV SystemScope pattern): users with a
/// region scope only see matching rows of public.sites — and therefore only
/// data joined through those sites — in every chart query. Any failure here
/// fails the query (the engine treats contributor exceptions as denial).
/// </summary>
public sealed class DemoRowFilterContributor : IRowFilterContributor
{
    public Task<RowFilterDecision> GetFiltersAsync(RowFilterContext context, CancellationToken cancellationToken)
    {
        if (context.Schema != "public" || context.Table != "sites")
        {
            return Task.FromResult(RowFilterDecision.Allow);
        }

        var user = DemoTokens.FindUser(context.UserId);
        if (user is null)
        {
            // Unknown identity on a scoped table: deny, never run unfiltered.
            return Task.FromResult(RowFilterDecision.DenyAccess());
        }

        return Task.FromResult(user.RegionScope is null
            ? RowFilterDecision.Allow
            : RowFilterDecision.Filter(new RowFilter("region", RowFilterOperator.Equals, [user.RegionScope])));
    }
}
