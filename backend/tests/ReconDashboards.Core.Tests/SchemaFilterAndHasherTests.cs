using ReconDashboards.Core.Options;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Tests;

public class SchemaFilterAndHasherTests
{
    [Fact]
    public void DefaultOptionsAllowOnlyPublicSchemaTables()
    {
        var raw = TestFixtures.BuildRawDemoSchemaWithSecretsTable();

        var filtered = SchemaFilter.Apply(raw, new DataSourceOptions());

        Assert.Equal(3, filtered.Tables.Count);
        Assert.All(filtered.Tables, t => Assert.Equal("public", t.Schema));
        Assert.Null(filtered.FindTable("audit.secrets"));
    }

    [Fact]
    public void AllowedTablesListOverridesAllowedSchemas()
    {
        var raw = TestFixtures.BuildRawDemoSchemaWithSecretsTable();
        var options = new DataSourceOptions { AllowedTables = { "audit.secrets" } };

        var filtered = SchemaFilter.Apply(raw, options);

        var only = Assert.Single(filtered.Tables);
        Assert.Equal("audit.secrets", only.Key);
        Assert.Null(filtered.FindTable("public.customers"));
    }

    [Fact]
    public void DeniedTablesWinOverAllowedTablesUsingSchemaQualifiedName()
    {
        var raw = TestFixtures.BuildRawDemoSchemaWithSecretsTable();
        var options = new DataSourceOptions
        {
            AllowedTables = { "public.orders" },
            DeniedTables = { "public.orders" },
        };

        var filtered = SchemaFilter.Apply(raw, options);

        Assert.Empty(filtered.Tables);
    }

    [Fact]
    public void DeniedTablesWinUsingBareTableName()
    {
        var raw = TestFixtures.BuildRawDemoSchemaWithSecretsTable();
        var options = new DataSourceOptions { DeniedTables = { "orders" } };

        var filtered = SchemaFilter.Apply(raw, options);

        Assert.Null(filtered.FindTable("public.orders"));
        Assert.NotNull(filtered.FindTable("public.customers"));
    }

    [Fact]
    public void ForeignKeyIsDroppedWhenOneEndpointIsDenied()
    {
        var raw = TestFixtures.BuildRawDemoSchemaWithSecretsTable();
        var options = new DataSourceOptions { DeniedTables = { "public.customers" } };

        var filtered = SchemaFilter.Apply(raw, options);

        Assert.NotNull(filtered.FindTable("public.orders"));
        Assert.Empty(filtered.ForeignKeys);
    }

    [Fact]
    public void IdenticalSchemasProduceIdenticalVersionHashes()
    {
        var first = TestFixtures.BuildDemoSchema();
        var second = TestFixtures.BuildDemoSchema();

        var firstHash = SchemaHasher.ComputeVersionHash(first.Tables, first.ForeignKeys);
        var secondHash = SchemaHasher.ComputeVersionHash(second.Tables, second.ForeignKeys);

        Assert.NotEmpty(firstHash);
        Assert.Equal(firstHash, secondHash);
    }

    [Fact]
    public void ColumnTypeChangeProducesDifferentVersionHash()
    {
        var baseline = TestFixtures.BuildDemoSchema();

        var orders = TestFixtures.BuildOrdersTable();
        var retypedColumns = orders.Columns
            .Select(c => c.Name == "order_total" ? c with { Type = NormalizedType.Text, RawType = "text" } : c)
            .ToArray();
        var drifted = baseline with
        {
            Tables = [TestFixtures.BuildCustomersTable(), orders with { Columns = retypedColumns }, TestFixtures.BuildInspectionsTable()],
        };

        var baselineHash = SchemaHasher.ComputeVersionHash(baseline.Tables, baseline.ForeignKeys);
        var driftedHash = SchemaHasher.ComputeVersionHash(drifted.Tables, drifted.ForeignKeys);

        Assert.NotEqual(baselineHash, driftedHash);
    }

    [Fact]
    public void RowEstimateAndFetchTimeChangesDoNotChangeVersionHash()
    {
        var baseline = TestFixtures.BuildDemoSchema();
        var reestimated = baseline with
        {
            FetchedAtUtc = baseline.FetchedAtUtc.AddDays(3),
            Tables = baseline.Tables.Select(t => t with { RowEstimate = (t.RowEstimate ?? 0) + 999_999 }).ToArray(),
        };

        var baselineHash = SchemaHasher.ComputeVersionHash(baseline.Tables, baseline.ForeignKeys);
        var reestimatedHash = SchemaHasher.ComputeVersionHash(reestimated.Tables, reestimated.ForeignKeys);

        Assert.Equal(baselineHash, reestimatedHash);
    }
}
