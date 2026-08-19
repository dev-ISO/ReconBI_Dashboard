using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ReconDashboards.Core.Persistence;

namespace ReconDashboards.Core.Services;

/// <summary>
/// The per-dashboard activity log's write path, shared by the save path
/// (<see cref="DashboardService"/>) and the collaborative-ops path
/// (<see cref="DashboardOpService"/>) so both record "saved" rows with the
/// same serialization and the same trim discipline.
/// </summary>
internal static class DashboardActivityLog
{
    /// <summary>DetailJson is camelCase on disk (re-emitted verbatim by the API).</summary>
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    internal static void Add(
        ReconDashboardsDbContext db, int dashboardId, string userId, string action, string? detailJson, DateTime atUtc) =>
        db.DashboardActivity.Add(new DashboardActivityRecord
        {
            DashboardId = dashboardId,
            UserId = userId,
            Action = action,
            DetailJson = detailJson,
            AtUtc = atUtc,
        });

    /// <summary>
    /// Keeps only the newest <see cref="DashboardService.MaxActivityEntriesPerDashboard"/>
    /// rows. Call after SaveChanges. The cap is what makes per-op "saved" rows
    /// affordable: heavy live editing rotates the log, it never grows it.
    /// </summary>
    internal static async Task TrimAsync(ReconDashboardsDbContext db, int dashboardId, CancellationToken ct)
    {
        var threshold = await db.DashboardActivity
            .Where(a => a.DashboardId == dashboardId)
            .OrderByDescending(a => a.Id)
            .Select(a => a.Id)
            .Skip(DashboardService.MaxActivityEntriesPerDashboard)
            .FirstOrDefaultAsync(ct);

        if (threshold > 0)
        {
            await db.DashboardActivity
                .Where(a => a.DashboardId == dashboardId && a.Id <= threshold)
                .ExecuteDeleteAsync(ct);
        }
    }
}
