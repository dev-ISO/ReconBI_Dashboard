using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace ReconDashboards.Core.Persistence;

/// <summary>
/// Library-owned storage context. Only rcd_-prefixed tables; its own migrations
/// history table (__RcdMigrationsHistory, configured by the host/factory) so it
/// coexists with a host context in the same database.
///
/// The model must build on BOTH Npgsql (production) and SQLite (host test
/// suites), hence the provider-conditional mapping. Timestamps are plain UTC
/// DateTime stored as "timestamp without time zone" — correct under either
/// state of Npgsql's legacy-timestamp switch via the kind-normalizing converter.
/// </summary>
public sealed class ReconDashboardsDbContext(DbContextOptions<ReconDashboardsDbContext> options)
    : DbContext(options)
{
    public DbSet<DataModelRecord> DataModels => Set<DataModelRecord>();
    public DbSet<DashboardRecord> Dashboards => Set<DashboardRecord>();
    public DbSet<QueryAuditRecord> QueryAudit => Set<QueryAuditRecord>();
    public DbSet<SubscriptionRecord> Subscriptions => Set<SubscriptionRecord>();
    public DbSet<AlertRecord> Alerts => Set<AlertRecord>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var isNpgsql = Database.ProviderName?.Contains("Npgsql", StringComparison.OrdinalIgnoreCase) == true;
        var jsonColumnType = isNpgsql ? "jsonb" : null;
        var notDeletedFilter = isNpgsql ? "\"IsDeleted\" = false" : "\"IsDeleted\" = 0";

        var utcConverter = new ValueConverter<DateTime, DateTime>(
            v => DateTime.SpecifyKind(v, DateTimeKind.Unspecified),
            v => DateTime.SpecifyKind(v, DateTimeKind.Utc));

        modelBuilder.Entity<DataModelRecord>(entity =>
        {
            entity.ToTable("rcd_data_models");
            entity.Property(e => e.DataSourceName).HasMaxLength(64);
            entity.Property(e => e.Name).HasMaxLength(128);
            entity.Property(e => e.Description).HasMaxLength(512);
            entity.Property(e => e.OwnerUserId).HasMaxLength(128);
            if (jsonColumnType is not null)
            {
                entity.Property(e => e.DefinitionJson).HasColumnType(jsonColumnType);
            }

            entity.HasIndex(e => new { e.OwnerUserId, e.IsDeleted });
            entity.HasIndex(e => new { e.OwnerUserId, e.Name })
                .IsUnique()
                .HasFilter(notDeletedFilter);
        });

        modelBuilder.Entity<DashboardRecord>(entity =>
        {
            entity.ToTable("rcd_dashboards");
            entity.Property(e => e.Name).HasMaxLength(128);
            entity.Property(e => e.Description).HasMaxLength(512);
            entity.Property(e => e.OwnerUserId).HasMaxLength(128);
            if (jsonColumnType is not null)
            {
                entity.Property(e => e.LayoutJson).HasColumnType(jsonColumnType);
            }

            entity.HasIndex(e => new { e.OwnerUserId, e.IsDeleted });
            entity.HasIndex(e => new { e.OwnerUserId, e.Name })
                .IsUnique()
                .HasFilter(notDeletedFilter);
        });

        modelBuilder.Entity<SubscriptionRecord>(entity =>
        {
            entity.ToTable("rcd_subscriptions");
            entity.Property(e => e.OwnerUserId).HasMaxLength(128);
            entity.Property(e => e.Name).HasMaxLength(128);
            entity.Property(e => e.Recipients).HasMaxLength(2048);
            // Small discriminated strings, readable in psql; never cron.
            entity.Property(e => e.ScheduleKind).HasConversion<string>().HasMaxLength(16);
            entity.Property(e => e.Format).HasConversion<string>().HasMaxLength(8);
            entity.HasOne<DashboardRecord>()
                .WithMany()
                .HasForeignKey(e => e.DashboardId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(e => e.OwnerUserId);
            entity.HasIndex(e => e.DashboardId);
            entity.HasIndex(e => new { e.Enabled, e.LastRunUtc });
        });

        modelBuilder.Entity<AlertRecord>(entity =>
        {
            entity.ToTable("rcd_alerts");
            entity.Property(e => e.OwnerUserId).HasMaxLength(128);
            entity.Property(e => e.Name).HasMaxLength(128);
            entity.Property(e => e.Recipients).HasMaxLength(2048);
            entity.Property(e => e.Operator).HasConversion<string>().HasMaxLength(8);
            entity.Property(e => e.Threshold).HasPrecision(28, 8);
            entity.Property(e => e.LastValue).HasPrecision(28, 8);
            if (jsonColumnType is not null)
            {
                entity.Property(e => e.SpecJson).HasColumnType(jsonColumnType);
            }

            entity.HasIndex(e => e.OwnerUserId);
            entity.HasIndex(e => e.DashboardId);
            entity.HasIndex(e => new { e.Enabled, e.LastEvaluatedUtc });
            entity.HasIndex(e => e.LastFiredUtc);
        });

        modelBuilder.Entity<QueryAuditRecord>(entity =>
        {
            entity.ToTable("rcd_query_audit");
            entity.Property(e => e.UserId).HasMaxLength(128);
            entity.Property(e => e.DataSourceName).HasMaxLength(64);
            entity.Property(e => e.SqlHash).HasMaxLength(64);
            entity.Property(e => e.ErrorCode).HasMaxLength(64);
            entity.HasIndex(e => e.ExecutedAtUtc);
        });

        if (isNpgsql)
        {
            foreach (var entityType in modelBuilder.Model.GetEntityTypes())
            {
                foreach (var property in entityType.GetProperties()
                             .Where(p => p.ClrType == typeof(DateTime) || p.ClrType == typeof(DateTime?)))
                {
                    property.SetColumnType("timestamp without time zone");
                    property.SetValueConverter(utcConverter);
                }
            }
        }
    }
}
