using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using ReconDashboards.Core.Persistence;

namespace ReconDashboards.Postgres.Design;

/// <summary>
/// Lets EF tooling (migrations add / script / bundle) run against this project
/// alone — migrations are authored in the library repo, never inside a host.
/// The connection string is only needed by commands that touch a database;
/// "migrations add"/"script" work with the placeholder.
/// </summary>
public sealed class RcdDesignTimeFactory : IDesignTimeDbContextFactory<ReconDashboardsDbContext>
{
    public ReconDashboardsDbContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("RCD_MIGRATIONS_CONNECTION")
            ?? "Host=localhost;Port=5445;Database=rcd_design;Username=postgres;Password=postgres";

        var builder = new DbContextOptionsBuilder<ReconDashboardsDbContext>();
        builder.UseNpgsql(connectionString, npgsql => npgsql
            .MigrationsAssembly("ReconDashboards.Postgres")
            .MigrationsHistoryTable("__RcdMigrationsHistory"));

        return new ReconDashboardsDbContext(builder.Options);
    }
}
