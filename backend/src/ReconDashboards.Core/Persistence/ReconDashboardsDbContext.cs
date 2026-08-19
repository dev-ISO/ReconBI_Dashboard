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
    public DbSet<DashboardShareRecord> DashboardShares => Set<DashboardShareRecord>();
    public DbSet<DashboardActivityRecord> DashboardActivity => Set<DashboardActivityRecord>();
    public DbSet<QueryAuditRecord> QueryAudit => Set<QueryAuditRecord>();
    public DbSet<SubscriptionRecord> Subscriptions => Set<SubscriptionRecord>();
    public DbSet<AlertRecord> Alerts => Set<AlertRecord>();
    public DbSet<SubscriptionDispatchRecord> SubscriptionDispatches => Set<SubscriptionDispatchRecord>();
    public DbSet<SubscriptionDispatchRecipientRecord> SubscriptionDispatchRecipients =>
        Set<SubscriptionDispatchRecipientRecord>();
    public DbSet<SubscriptionOptOutRecord> SubscriptionOptOuts => Set<SubscriptionOptOutRecord>();
    public DbSet<GlobalOptOutRecord> GlobalOptOuts => Set<GlobalOptOutRecord>();

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

        modelBuilder.Entity<DashboardShareRecord>(entity =>
        {
            entity.ToTable("rcd_dashboard_shares");
            entity.Property(e => e.UserId).HasMaxLength(128);
            entity.Property(e => e.GrantedByUserId).HasMaxLength(128);
            entity.Property(e => e.CanEditLayout).HasDefaultValue(false);
            entity.Property(e => e.CanManagePages).HasDefaultValue(false);
            entity.Property(e => e.CanEditCharts).HasDefaultValue(false);
            entity.Property(e => e.CanMoveTiles).HasDefaultValue(false);
            entity.Property(e => e.CanDeleteContent).HasDefaultValue(false);
            entity.HasOne<DashboardRecord>()
                .WithMany()
                .HasForeignKey(e => e.DashboardId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(e => new { e.DashboardId, e.UserId }).IsUnique();
            entity.HasIndex(e => e.UserId);
        });

        modelBuilder.Entity<DashboardActivityRecord>(entity =>
        {
            entity.ToTable("rcd_dashboard_activity");
            entity.Property(e => e.UserId).HasMaxLength(128);
            entity.Property(e => e.Action).HasMaxLength(64);
            if (jsonColumnType is not null)
            {
                entity.Property(e => e.DetailJson).HasColumnType(jsonColumnType);
            }

            entity.HasOne<DashboardRecord>()
                .WithMany()
                .HasForeignKey(e => e.DashboardId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(e => new { e.DashboardId, e.AtUtc }).IsDescending(false, true);
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

        modelBuilder.Entity<SubscriptionDispatchRecord>(entity =>
        {
            entity.ToTable("rcd_subscription_dispatches");
            // Deliberately NO FK to rcd_subscriptions: history must survive
            // subscription deletion (SubscriptionName is the snapshot).
            entity.Property(e => e.SubscriptionName).HasMaxLength(200);
            entity.Property(e => e.OwnerUserId).HasMaxLength(128);
            entity.Property(e => e.RequestedBy).HasMaxLength(64);
            entity.Property(e => e.Error).HasMaxLength(1000);
            // Small discriminated strings, readable in psql — same convention
            // as ScheduleKind/Format ("Schedule"/"Manual", "Running".."Skipped").
            entity.Property(e => e.Trigger).HasConversion<string>().HasMaxLength(10);
            entity.Property(e => e.Status).HasConversion<string>().HasMaxLength(12);
            entity.HasIndex(e => new { e.SubscriptionId, e.StartedUtc }).IsDescending(false, true);
            // The retention sweep and abandoned-dispatch close both scan by these.
            entity.HasIndex(e => new { e.Status, e.StartedUtc });
        });

        modelBuilder.Entity<SubscriptionDispatchRecipientRecord>(entity =>
        {
            entity.ToTable("rcd_subscription_dispatch_recipients");
            entity.Property(e => e.Email).HasMaxLength(320);
            entity.Property(e => e.Error).HasMaxLength(1000);
            entity.Property(e => e.Status).HasConversion<string>().HasMaxLength(12);
            entity.Property(e => e.Attempts).HasDefaultValue(0);
            entity.Property(e => e.OpenCount).HasDefaultValue(0);
            entity.HasOne<SubscriptionDispatchRecord>()
                .WithMany()
                .HasForeignKey(e => e.DispatchId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(e => e.DispatchId);
        });

        modelBuilder.Entity<SubscriptionOptOutRecord>(entity =>
        {
            entity.ToTable("rcd_subscription_optouts");
            entity.HasKey(e => new { e.SubscriptionId, e.Email });
            entity.Property(e => e.Email).HasMaxLength(320);
        });

        modelBuilder.Entity<GlobalOptOutRecord>(entity =>
        {
            entity.ToTable("rcd_global_optouts");
            entity.HasKey(e => e.Email);
            entity.Property(e => e.Email).HasMaxLength(320);
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
