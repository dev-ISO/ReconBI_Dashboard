using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using ReconDashboards.Core.Persistence;

namespace ReconDashboards.Postgres.Tests;

/// <summary>
/// Proves the 0.11.1 ShareMoveAndDeleteRights migration's BACKFILL against a
/// real postgres: pre-existing grantees must keep exactly the abilities they
/// had before move/delete were split out — CanMoveTiles := CanEditLayout,
/// CanDeleteContent := (CanEditCharts OR CanManagePages). Runs in its own
/// throwaway database inside the shared container: migrate to the last
/// pre-0.11.1 migration, seed share rows through raw SQL (the current EF model
/// already knows the new columns, so EF inserts would not compile against the
/// old schema), then migrate to head and read the backfilled values back.
/// </summary>
[Collection("postgres")]
public sealed class ShareRightsBackfillTests(PostgresContainerFixture fixture)
{
    private const string LastPre0111Migration = "20260819134939_SubscriptionDispatchesAndOptOuts";

    [Fact]
    public async Task Backfill_GranteesKeepTheirPreSplitAbilities()
    {
        // Fresh database so partially-applied history from other tests can never interfere.
        await using (var admin = await fixture.DataSource.OpenConnectionAsync())
        {
            await using var create = new NpgsqlCommand("CREATE DATABASE rcd_backfill_test;", admin);
            await create.ExecuteNonQueryAsync();
        }

        var builder = new NpgsqlConnectionStringBuilder(fixture.ConnectionString)
        {
            Database = "rcd_backfill_test",
        };

        var options = new DbContextOptionsBuilder<ReconDashboardsDbContext>()
            .UseNpgsql(builder.ConnectionString, npgsql => npgsql
                .MigrationsAssembly("ReconDashboards.Postgres")
                .MigrationsHistoryTable("__RcdMigrationsHistory"))
            .Options;

        await using var db = new ReconDashboardsDbContext(options);
        var migrator = db.GetService<IMigrator>();

        // 1. Old-world schema (no CanMoveTiles/CanDeleteContent columns yet).
        await migrator.MigrateAsync(LastPre0111Migration);

        // 2. Seed one dashboard + the four flag combinations that matter.
        await db.Database.ExecuteSqlRawAsync(
            """
            INSERT INTO rcd_dashboards ("Name", "Description", "ModelId", "LayoutJson", "OwnerUserId", "IsShared", "IsDeleted", "CreatedAtUtc", "UpdatedAtUtc")
            VALUES ('Backfill board', NULL, NULL, '{{}}', 'owner', false, false, now(), now());

            INSERT INTO rcd_dashboard_shares ("DashboardId", "UserId", "CanEditLayout", "CanManagePages", "CanEditCharts", "GrantedByUserId", "CreatedAtUtc", "UpdatedAtUtc")
            SELECT d."Id", v.user_id, v.layout, v.pages, v.charts, 'owner', now(), now()
            FROM rcd_dashboards d,
                 (VALUES ('layout-only', true,  false, false),
                         ('pages-only',  false, true,  false),
                         ('charts-only', false, false, true),
                         ('view-only',   false, false, false)) AS v(user_id, layout, pages, charts);
            """);

        // 3. Apply the 0.11.1 migration (adds the columns + backfills).
        await migrator.MigrateAsync();

        // 4. The backfill matrix: move follows layout; delete follows charts OR pages.
        var rows = await db.DashboardShares.AsNoTracking()
            .OrderBy(s => s.UserId)
            .Select(s => new { s.UserId, s.CanMoveTiles, s.CanDeleteContent })
            .ToListAsync();

        Assert.Equal(4, rows.Count);
        Assert.Equal(new { UserId = "charts-only", CanMoveTiles = false, CanDeleteContent = true }, rows[0]);
        Assert.Equal(new { UserId = "layout-only", CanMoveTiles = true, CanDeleteContent = false }, rows[1]);
        Assert.Equal(new { UserId = "pages-only", CanMoveTiles = false, CanDeleteContent = true }, rows[2]);
        Assert.Equal(new { UserId = "view-only", CanMoveTiles = false, CanDeleteContent = false }, rows[3]);
    }
}
