using Microsoft.EntityFrameworkCore;
using Npgsql;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Services;

namespace ReconDashboards.Postgres.Tests;

/// <summary>
/// Proves the collaborative-ops row lock against REAL postgres (SQLite cannot
/// express FOR UPDATE, so the suites there only exercise the logical path):
///  1. an op physically BLOCKS behind a foreign FOR UPDATE on its row and
///     completes once that transaction ends;
///  2. N ops applied concurrently from independent connections all land —
///     the read-modify-write is serialized, no lost update (the whole-doc
///     save TOCTOU the design kills for the op path).
/// Runs in throwaway databases inside the shared container, one per test, so
/// migration history and rows never interfere with other suites.
/// </summary>
[Collection("postgres")]
public sealed class DashboardOpForUpdateTests(PostgresContainerFixture fixture)
{
    private const string OwnerUserId = "owner";

    private const string SeedLayout = """{"pages":[{"id":"p1","name":"Main","tiles":[]}]}""";

    [Fact]
    public async Task Op_BlocksBehindForeignRowLock_ThenApplies()
    {
        var connectionString = await CreateDatabaseAsync("rcd_ops_lock_test");
        var dashboardId = await SeedDashboardAsync(connectionString);

        // A foreign transaction holds the row (simulating a concurrent op mid-apply).
        await using var blocker = new NpgsqlConnection(connectionString);
        await blocker.OpenAsync();
        await using var blockingTx = await blocker.BeginTransactionAsync();
        await using (var lockCmd = new NpgsqlCommand(
            $"""SELECT "Id" FROM rcd_dashboards WHERE "Id" = {dashboardId} FOR UPDATE""",
            blocker, blockingTx))
        {
            await lockCmd.ExecuteScalarAsync();
        }

        await using var db = CreateContext(connectionString);
        var service = CreateService(db);
        var opTask = service.ApplyAsync(
            dashboardId,
            new DashboardOpSubmission(
                "op-blocked", "tile", "t1",
                """{"kind":"tileUpsert","pageId":"p1","tile":{"id":"t1","kind":"text","text":{"html":"x"}}}"""),
            CancellationToken.None);

        // The op must be WAITING on the row lock, not failing or bypassing it.
        var winner = await Task.WhenAny(opTask, Task.Delay(TimeSpan.FromMilliseconds(750)));
        Assert.NotSame(opTask, winner);

        await blockingTx.RollbackAsync();

        var result = await opTask.WaitAsync(TimeSpan.FromSeconds(15));
        Assert.True(result.Succeeded, result.Error?.Message);
    }

    [Fact]
    public async Task ConcurrentOps_AllLand_NoLostUpdate()
    {
        var connectionString = await CreateDatabaseAsync("rcd_ops_race_test");
        var dashboardId = await SeedDashboardAsync(connectionString);

        // 10 editors add 10 distinct tiles at once, each on its own connection
        // and context. Without the row lock this read-modify-write races and
        // drops tiles; with it, every op applies on the latest doc.
        const int editors = 10;
        const string payloadTemplate =
            """{"kind":"tileUpsert","pageId":"p1","tile":{"id":"__ID__","kind":"text","text":{"html":"tile __ID__"}}}""";
        var tasks = Enumerable.Range(0, editors).Select(async i =>
        {
            await using var db = CreateContext(connectionString);
            var result = await CreateService(db).ApplyAsync(
                dashboardId,
                new DashboardOpSubmission(
                    $"op-{i}", "tile", $"t{i}",
                    payloadTemplate.Replace("__ID__", $"t{i}")),
                CancellationToken.None);
            Assert.True(result.Succeeded, result.Error?.Message);
        });
        await Task.WhenAll(tasks);

        await using var verify = CreateContext(connectionString);
        var layout = (await verify.Dashboards.AsNoTracking().SingleAsync(d => d.Id == dashboardId)).LayoutJson;
        using var doc = System.Text.Json.JsonDocument.Parse(layout);
        var tileIds = doc.RootElement.GetProperty("pages")[0].GetProperty("tiles").EnumerateArray()
            .Select(t => t.GetProperty("id").GetString())
            .ToHashSet();

        Assert.Equal(editors, tileIds.Count);
        for (var i = 0; i < editors; i++)
        {
            Assert.Contains($"t{i}", tileIds);
        }
    }

    // ------------------------------- plumbing -------------------------------

    private async Task<string> CreateDatabaseAsync(string databaseName)
    {
        await using (var admin = await fixture.DataSource.OpenConnectionAsync())
        {
            await using var create = new NpgsqlCommand($"CREATE DATABASE {databaseName};", admin);
            await create.ExecuteNonQueryAsync();
        }

        var builder = new NpgsqlConnectionStringBuilder(fixture.ConnectionString)
        {
            Database = databaseName,
        };
        return builder.ConnectionString;
    }

    private static ReconDashboardsDbContext CreateContext(string connectionString)
    {
        var options = new DbContextOptionsBuilder<ReconDashboardsDbContext>()
            .UseNpgsql(connectionString, npgsql => npgsql
                .MigrationsAssembly("ReconDashboards.Postgres")
                .MigrationsHistoryTable("__RcdMigrationsHistory"))
            .Options;
        return new ReconDashboardsDbContext(options);
    }

    private async Task<int> SeedDashboardAsync(string connectionString)
    {
        await using var db = CreateContext(connectionString);
        await db.Database.MigrateAsync();

        var record = new DashboardRecord
        {
            Name = "Collab board",
            LayoutJson = SeedLayout,
            OwnerUserId = OwnerUserId,
            CreatedAtUtc = DateTime.UtcNow,
            UpdatedAtUtc = DateTime.UtcNow,
        };
        db.Dashboards.Add(record);
        await db.SaveChangesAsync();
        return record.Id;
    }

    private static DashboardOpService CreateService(ReconDashboardsDbContext db) =>
        new(
            db,
            new FixedCurrentUser(OwnerUserId),
            new NullUserDirectory(),
            new ReconDashboardsOptions(),
            TimeProvider.System,
            new DashboardTileLockService(TimeProvider.System),
            new NullRcdDashboardOpNotifier());

    private sealed class FixedCurrentUser(string userId) : ICurrentUserProvider
    {
        public string GetUserId() => userId;

        public bool CanManageShared => false;
    }
}
