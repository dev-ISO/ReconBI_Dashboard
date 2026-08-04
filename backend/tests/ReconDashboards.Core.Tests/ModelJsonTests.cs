using System.Text.Json;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.Core.Tests;

public class ModelJsonTests
{
    [Fact]
    public void RoundTripPreservesTablesRelationshipsAndMeasures()
    {
        using var statusValue = JsonDocument.Parse("\"paid\"");
        var original = TestFixtures.BuildModel(
            tables:
            [
                TestFixtures.BuildModelTable(
                    "public", "customers",
                    friendlyName: "Customers",
                    position: new CanvasPosition(12.5, 40),
                    columns: [new ModelColumn("credit_limit", FriendlyName: "Credit Limit", DefaultAggregation: Aggregation.Sum)]),
                TestFixtures.BuildModelTable("public", "orders", position: new CanvasPosition(320, 80)),
            ],
            relationships:
            [
                TestFixtures.BuildRelationship(
                    "public.orders", "customer_id", "public.customers", "id",
                    source: RelationshipSource.Fk),
                TestFixtures.BuildRelationship(
                    "public.orders", "id", "public.customers", "id",
                    cardinality: Cardinality.OneToOne, isActive: false, source: RelationshipSource.Manual),
            ],
            measures:
            [
                TestFixtures.BuildMeasure(
                    "Paid Order Total", "public.orders", Aggregation.Sum, "order_total",
                    filters:
                    [
                        new FilterSpec("public.orders", "status", FilterOperator.Eq, [statusValue.RootElement.Clone()]),
                    ]),
            ]);

        var json = ModelJson.Serialize(original);
        var reloaded = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(error);
        Assert.NotNull(reloaded);

        Assert.Equal(2, reloaded.Tables.Count);
        var customers = reloaded.FindTable("public.customers");
        Assert.NotNull(customers);
        Assert.Equal("Customers", customers.FriendlyName);
        Assert.NotNull(customers.Position);
        Assert.Equal(12.5, customers.Position.X);
        Assert.Equal(40, customers.Position.Y);
        var creditLimitOverride = Assert.Single(customers.ColumnOverrides);
        Assert.Equal("credit_limit", creditLimitOverride.Name);
        Assert.Equal("Credit Limit", creditLimitOverride.FriendlyName);
        Assert.Equal(Aggregation.Sum, creditLimitOverride.DefaultAggregation);

        Assert.Equal(2, reloaded.Relationships.Count);
        Assert.Equal(original.Relationships[0].Id, reloaded.Relationships[0].Id);
        Assert.Equal(RelationshipSource.Fk, reloaded.Relationships[0].Source);
        Assert.True(reloaded.Relationships[0].IsActive);
        Assert.Equal(RelationshipSource.Manual, reloaded.Relationships[1].Source);
        Assert.Equal(Cardinality.OneToOne, reloaded.Relationships[1].Cardinality);
        Assert.False(reloaded.Relationships[1].IsActive);

        var measure = Assert.Single(reloaded.Measures);
        Assert.Equal("Paid Order Total", measure.Name);
        Assert.Equal(Aggregation.Sum, measure.Aggregation);
        Assert.Equal("order_total", measure.Column);
        var filter = Assert.Single(measure.MeasureFilters);
        Assert.Equal(FilterOperator.Eq, filter.Operator);
        Assert.Equal("paid", filter.Values[0].GetString());
    }

    [Fact]
    public void SerializedJsonUsesCamelCaseStringsForRelationshipSource()
    {
        var definition = TestFixtures.BuildModel(
            relationships:
            [
                TestFixtures.BuildRelationship(
                    "public.orders", "customer_id", "public.customers", "id",
                    source: RelationshipSource.Fk),
                TestFixtures.BuildRelationship(
                    "public.orders", "id", "public.customers", "id",
                    isActive: false, source: RelationshipSource.Manual),
            ]);

        var json = ModelJson.Serialize(definition);

        Assert.Contains("\"source\":\"fk\"", json);
        Assert.Contains("\"source\":\"manual\"", json);
    }

    [Fact]
    public void SerializedJsonUsesCamelCaseStringsForStatisticalAggregations()
    {
        // These exact wire names are mirrored by the frontend Aggregation union.
        var definition = TestFixtures.BuildModel(
            measures:
            [
                TestFixtures.BuildMeasure("Std", "public.orders", Aggregation.StdDev, "order_total"),
                TestFixtures.BuildMeasure("Var", "public.orders", Aggregation.Variance, "order_total"),
                TestFixtures.BuildMeasure("Med", "public.orders", Aggregation.Median, "order_total"),
            ]);

        var json = ModelJson.Serialize(definition);

        Assert.Contains("\"aggregation\":\"stdDev\"", json);
        Assert.Contains("\"aggregation\":\"variance\"", json);
        Assert.Contains("\"aggregation\":\"median\"", json);

        var reloaded = ModelJson.TryDeserialize(json, out var error);
        Assert.Null(error);
        Assert.NotNull(reloaded);
        Assert.Equal(
            [Aggregation.StdDev, Aggregation.Variance, Aggregation.Median],
            reloaded.Measures.Select(m => m.Aggregation).ToArray());
    }

    [Fact]
    public void UnknownTopLevelPropertyIsRejectedWithError()
    {
        const string json = """{"version":1,"tables":[],"relationships":[],"measures":[],"surprise":true}""";

        var definition = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(definition);
        Assert.NotNull(error);
        Assert.Contains("Invalid model definition JSON", error);
    }

    [Fact]
    public void UnknownNestedPropertyIsRejectedWithError()
    {
        const string json = """{"version":1,"tables":[{"schema":"public","name":"customers","sneaky":1}],"relationships":[],"measures":[]}""";

        var definition = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(definition);
        Assert.NotNull(error);
        Assert.Contains("Invalid model definition JSON", error);
    }

    [Fact]
    public void VersionTwoDocumentIsRejected()
    {
        const string json = """{"version":2,"tables":[],"relationships":[],"measures":[]}""";

        var definition = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(definition);
        Assert.NotNull(error);
        Assert.Contains("version 2", error);
    }

    [Fact]
    public void MissingArraysAreToleratedAsEmptyLists()
    {
        const string json = """{"version":1}""";

        var definition = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(error);
        Assert.NotNull(definition);
        Assert.NotNull(definition.Tables);
        Assert.Empty(definition.Tables);
        Assert.NotNull(definition.Relationships);
        Assert.Empty(definition.Relationships);
        Assert.NotNull(definition.Measures);
        Assert.Empty(definition.Measures);
    }
}
