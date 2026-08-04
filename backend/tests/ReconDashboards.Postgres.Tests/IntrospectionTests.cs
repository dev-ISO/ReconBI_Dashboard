using ReconDashboards.Core.Schema;

namespace ReconDashboards.Postgres.Tests;

[Collection("postgres")]
public sealed class IntrospectionTests(PostgresContainerFixture fixture)
{
    private DatabaseSchema Schema => fixture.RawSchema;

    private TableSchema GetTable(string key)
    {
        var table = Schema.FindTable(key);
        Assert.NotNull(table);
        return table;
    }

    private static ColumnSchema GetColumn(TableSchema table, string name)
    {
        var column = table.FindColumn(name);
        Assert.NotNull(column);
        return column;
    }

    [Fact]
    public void Tables_ContainSeededSet()
    {
        Assert.NotNull(Schema.FindTable("public.customers"));
        Assert.NotNull(Schema.FindTable("public.orders"));
        Assert.NotNull(Schema.FindTable("public.calendar"));
        Assert.NotNull(Schema.FindTable("public.slots"));
        Assert.NotNull(Schema.FindTable("public.Weird Name"));
    }

    [Fact]
    public void View_And_MaterializedView_AreClassified()
    {
        Assert.Equal(TableKind.View, GetTable("public.open_orders").Kind);
        Assert.Equal(TableKind.MaterializedView, GetTable("public.region_totals").Kind);
        Assert.Equal(TableKind.Table, GetTable("public.customers").Kind);
    }

    [Fact]
    public void SystemSchemas_AreExcluded()
    {
        Assert.DoesNotContain(Schema.Tables, t => t.Schema == "pg_catalog");
        Assert.DoesNotContain(Schema.Tables, t => t.Schema == "information_schema");
    }

    [Fact]
    public void Customers_Id_IsIntegerPrimaryKey()
    {
        var customers = GetTable("public.customers");
        Assert.Equal(NormalizedType.Integer, GetColumn(customers, "id").Type);
        Assert.Equal(new[] { "id" }, customers.PrimaryKey);
    }

    [Fact]
    public void Customers_Name_IsRequiredTextWithUniqueConstraint()
    {
        var customers = GetTable("public.customers");
        var name = GetColumn(customers, "name");
        Assert.Equal(NormalizedType.Text, name.Type);
        Assert.False(name.IsNullable);

        var unique = Assert.Single(customers.UniqueConstraints);
        Assert.Equal(new[] { "name" }, unique);
    }

    [Fact]
    public void Customers_Region_IsNullableTextWithComment()
    {
        var region = GetColumn(GetTable("public.customers"), "region");
        Assert.Equal(NormalizedType.Text, region.Type);
        Assert.True(region.IsNullable);
        Assert.Equal("Sales region", region.Comment);
    }

    [Fact]
    public void Customers_CreditLimit_DomainResolvesToDecimal()
    {
        Assert.Equal(NormalizedType.Decimal, GetColumn(GetTable("public.customers"), "credit_limit").Type);
    }

    [Fact]
    public void Customers_CreatedAt_IsTimestamp()
    {
        Assert.Equal(NormalizedType.Timestamp, GetColumn(GetTable("public.customers"), "created_at").Type);
    }

    [Fact]
    public void Customers_Table_HasComment()
    {
        Assert.Equal("Customer master", GetTable("public.customers").Comment);
    }

    [Fact]
    public void Orders_ColumnTypes_AreNormalized()
    {
        var orders = GetTable("public.orders");

        Assert.Equal(NormalizedType.Text, GetColumn(orders, "status").Type);

        var orderTotal = GetColumn(orders, "order_total");
        Assert.Equal(NormalizedType.Decimal, orderTotal.Type);
        Assert.Equal("numeric(12,2)", orderTotal.RawType);

        Assert.Equal(NormalizedType.Date, GetColumn(orders, "order_date").Type);
        Assert.Equal(NormalizedType.Json, GetColumn(orders, "payload").Type);
        Assert.Equal(NormalizedType.Other, GetColumn(orders, "attachment").Type);
        Assert.Equal(NormalizedType.Other, GetColumn(orders, "tags").Type);

        var customerId = GetColumn(orders, "customer_id");
        Assert.Equal(NormalizedType.Integer, customerId.Type);
        Assert.True(customerId.IsNullable);
    }

    [Fact]
    public void ForeignKey_OrdersToCustomers_IsSingleColumn()
    {
        var fk = Assert.Single(
            Schema.ForeignKeys,
            f => f.FromTable == "public.orders" && f.ToTable == "public.customers");

        Assert.False(fk.IsComposite);
        Assert.Equal(new[] { "customer_id" }, fk.FromColumns);
        Assert.Equal(new[] { "id" }, fk.ToColumns);
    }

    [Fact]
    public void ForeignKey_SlotsToCalendar_IsCompositeAndOrdered()
    {
        var fk = Assert.Single(
            Schema.ForeignKeys,
            f => f.FromTable == "public.slots" && f.ToTable == "public.calendar");

        Assert.True(fk.IsComposite);
        Assert.Equal(new[] { "year", "week" }, fk.FromColumns);
        Assert.Equal(new[] { "year", "week" }, fk.ToColumns);
    }

    [Fact]
    public void Customers_RowEstimate_ReflectsAnalyze()
    {
        var rowEstimate = GetTable("public.customers").RowEstimate;
        Assert.NotNull(rowEstimate);
        Assert.True(rowEstimate >= 40, $"Expected RowEstimate >= 40 but was {rowEstimate}.");
    }

    [Fact]
    public void QuotedIdentifiers_ArePreserved()
    {
        var weird = GetTable("public.Weird Name");
        Assert.Equal(NormalizedType.Text, GetColumn(weird, "Weird Col").Type);
    }

    [Fact]
    public void RawSchema_HasEmptyVersionHash_AndConnectionName()
    {
        Assert.Equal("", Schema.VersionHash);
        Assert.Equal(PostgresContainerFixture.ConnectionName, Schema.ConnectionName);
    }
}
