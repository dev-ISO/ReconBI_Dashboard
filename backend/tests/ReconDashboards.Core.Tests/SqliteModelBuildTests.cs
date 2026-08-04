using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using ReconDashboards.Core.Persistence;

namespace ReconDashboards.Core.Tests;

public class SqliteModelBuildTests
{
    private static (SqliteConnection Connection, ReconDashboardsDbContext Db) CreateContext()
    {
        var connection = new SqliteConnection("DataSource=:memory:");
        connection.Open();
        var db = NewContext(connection);
        db.Database.EnsureCreated();
        return (connection, db);
    }

    private static ReconDashboardsDbContext NewContext(SqliteConnection connection) =>
        new(new DbContextOptionsBuilder<ReconDashboardsDbContext>().UseSqlite(connection).Options);

    private static DataModelRecord NewModelRecord(string owner, string name, bool isDeleted = false) => new()
    {
        DataSourceName = "demo",
        Name = name,
        Description = "A model",
        DefinitionJson = """{"version":1}""",
        OwnerUserId = owner,
        IsShared = false,
        IsDeleted = isDeleted,
        CreatedAtUtc = new DateTime(2026, 8, 1, 12, 0, 0, DateTimeKind.Utc),
        UpdatedAtUtc = new DateTime(2026, 8, 2, 12, 0, 0, DateTimeKind.Utc),
    };

    [Fact]
    public void EnsureCreatedBuildsTheModelOnSqlite()
    {
        var connection = new SqliteConnection("DataSource=:memory:");
        connection.Open();
        using var db = NewContext(connection);

        var created = db.Database.EnsureCreated();

        Assert.True(created);
        connection.Dispose();
    }

    [Fact]
    public async Task DataModelRecordRoundTripsThroughSqlite()
    {
        var (connection, db) = CreateContext();
        using (connection)
        using (db)
        {
            var record = NewModelRecord("owner-1", "Round Trip Model");
            record.IsShared = true;
            db.DataModels.Add(record);
            await db.SaveChangesAsync();

            using var freshContext = NewContext(connection);
            var reloaded = await freshContext.DataModels.AsNoTracking().SingleAsync(m => m.Id == record.Id);

            Assert.Equal(record.DataSourceName, reloaded.DataSourceName);
            Assert.Equal(record.Name, reloaded.Name);
            Assert.Equal(record.Description, reloaded.Description);
            Assert.Equal(record.DefinitionJson, reloaded.DefinitionJson);
            Assert.Equal(record.OwnerUserId, reloaded.OwnerUserId);
            Assert.Equal(record.IsShared, reloaded.IsShared);
            Assert.Equal(record.IsDeleted, reloaded.IsDeleted);
            Assert.Equal(record.CreatedAtUtc, reloaded.CreatedAtUtc);
            Assert.Equal(record.UpdatedAtUtc, reloaded.UpdatedAtUtc);
        }
    }

    [Fact]
    public async Task FilteredUniqueIndexRejectsSecondLiveModelWithSameOwnerAndName()
    {
        var (connection, db) = CreateContext();
        using (connection)
        using (db)
        {
            db.DataModels.Add(NewModelRecord("owner-1", "Duplicate Name"));
            await db.SaveChangesAsync();

            using var secondContext = NewContext(connection);
            secondContext.DataModels.Add(NewModelRecord("owner-1", "Duplicate Name"));

            await Assert.ThrowsAsync<DbUpdateException>(() => secondContext.SaveChangesAsync());
        }
    }

    [Fact]
    public async Task FilteredUniqueIndexAllowsReusingNameOfSoftDeletedModel()
    {
        var (connection, db) = CreateContext();
        using (connection)
        using (db)
        {
            db.DataModels.Add(NewModelRecord("owner-1", "Recycled Name", isDeleted: true));
            await db.SaveChangesAsync();

            db.DataModels.Add(NewModelRecord("owner-1", "Recycled Name"));
            await db.SaveChangesAsync();

            Assert.Equal(2, await db.DataModels.CountAsync(m => m.Name == "Recycled Name"));
        }
    }
}
