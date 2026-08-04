using ReconDashboards.Core.Options;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Postgres.Tests;

[Collection("postgres")]
public sealed class SchemaFilterIntegrationTests(PostgresContainerFixture fixture)
{
    [Fact]
    public void DefaultOptions_KeepPublicTables()
    {
        var filtered = SchemaFilter.Apply(fixture.RawSchema, new DataSourceOptions());

        Assert.NotNull(filtered.FindTable("public.customers"));
        Assert.NotNull(filtered.FindTable("public.orders"));
        Assert.NotNull(filtered.FindTable("public.calendar"));
        Assert.NotNull(filtered.FindTable("public.slots"));
    }

    [Fact]
    public void DeniedTables_RemoveTableAndItsForeignKeys()
    {
        var options = new DataSourceOptions { DeniedTables = { "public.customers" } };

        var filtered = SchemaFilter.Apply(fixture.RawSchema, options);

        Assert.Null(filtered.FindTable("public.customers"));
        Assert.NotNull(filtered.FindTable("public.orders"));
        Assert.DoesNotContain(filtered.ForeignKeys, fk => fk.ToTable == "public.customers");
        Assert.DoesNotContain(filtered.ForeignKeys, fk => fk.FromTable == "public.customers");

        // Unrelated foreign keys survive.
        Assert.Contains(filtered.ForeignKeys, fk => fk.FromTable == "public.slots" && fk.ToTable == "public.calendar");
    }

    [Fact]
    public void AllowedTables_RestrictToListedTables()
    {
        var options = new DataSourceOptions { AllowedTables = { "public.orders" } };

        var filtered = SchemaFilter.Apply(fixture.RawSchema, options);

        var table = Assert.Single(filtered.Tables);
        Assert.Equal("public.orders", table.Key);
        Assert.Empty(filtered.ForeignKeys);
    }

    [Fact]
    public async Task VersionHash_IsStableAcrossSuccessiveIntrospections()
    {
        var first = await fixture.Introspector.IntrospectAsync(CancellationToken.None);
        var second = await fixture.Introspector.IntrospectAsync(CancellationToken.None);

        var firstHash = SchemaHasher.ComputeVersionHash(first.Tables, first.ForeignKeys);
        var secondHash = SchemaHasher.ComputeVersionHash(second.Tables, second.ForeignKeys);

        Assert.NotEmpty(firstHash);
        Assert.Equal(firstHash, secondHash);
    }
}
