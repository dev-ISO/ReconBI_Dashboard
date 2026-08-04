using ReconDashboards.Core.Modeling;

namespace ReconDashboards.Core.Tests;

public class SemanticModelValidatorTests
{
    private static ValidationResult Validate(ModelDefinition definition) =>
        new SemanticModelValidator().Validate(definition, TestFixtures.BuildDemoSchema());

    private static ModelDefinition CustomersAndOrders(
        IReadOnlyList<Relationship>? relationships = null,
        IReadOnlyList<Measure>? measures = null) =>
        TestFixtures.BuildModel(
            tables:
            [
                TestFixtures.BuildModelTable("public", "customers"),
                TestFixtures.BuildModelTable("public", "orders"),
            ],
            relationships: relationships,
            measures: measures);

    [Fact]
    public void FullyValidModelProducesNoIssues()
    {
        var result = Validate(TestFixtures.BuildValidDemoModel());

        Assert.True(result.IsValid);
        Assert.Empty(result.Issues);
    }

    [Fact]
    public void TableMissingFromCatalogReportsTableExistenceError()
    {
        var definition = TestFixtures.BuildModel(
            tables: [TestFixtures.BuildModelTable("public", "does_not_exist")]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL001" && e.Message.Contains("public.does_not_exist"));
    }

    [Fact]
    public void DuplicateTableEntryReportsTableExistenceError()
    {
        var definition = TestFixtures.BuildModel(
            tables:
            [
                TestFixtures.BuildModelTable("public", "customers"),
                TestFixtures.BuildModelTable("public", "customers"),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL001" && e.Message.Contains("more than once"));
    }

    [Fact]
    public void ColumnOverrideForMissingColumnReportsColumnExistenceError()
    {
        var definition = TestFixtures.BuildModel(
            tables:
            [
                TestFixtures.BuildModelTable(
                    "public", "customers",
                    columns: [new ModelColumn("no_such_column", FriendlyName: "Nope")]),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL002" && e.Message.Contains("no_such_column"));
    }

    [Fact]
    public void RelationshipEndpointTableNotInModelReportsError()
    {
        var definition = TestFixtures.BuildModel(
            tables: [TestFixtures.BuildModelTable("public", "customers")],
            relationships:
            [
                TestFixtures.BuildRelationship("public.orders", "customer_id", "public.customers", "id"),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL002" && e.Message.Contains("not part of the model"));
    }

    [Fact]
    public void RelationshipEndpointColumnMissingReportsError()
    {
        var definition = CustomersAndOrders(
            relationships:
            [
                TestFixtures.BuildRelationship("public.orders", "no_such_column", "public.customers", "id"),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL002" && e.Message.Contains("no_such_column"));
    }

    [Fact]
    public void MeasureTableNotInModelReportsError()
    {
        var definition = TestFixtures.BuildModel(
            tables: [TestFixtures.BuildModelTable("public", "customers")],
            measures:
            [
                TestFixtures.BuildMeasure("Order Count", "public.orders", Aggregation.Count),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL002" && e.Message.Contains("not part of the model"));
    }

    [Fact]
    public void MeasureColumnMissingReportsError()
    {
        var definition = CustomersAndOrders(
            measures:
            [
                TestFixtures.BuildMeasure("Bad Sum", "public.orders", Aggregation.Sum, "no_such_column"),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL002" && e.Message.Contains("no_such_column"));
    }

    [Fact]
    public void MeasureFilterColumnMissingReportsError()
    {
        var definition = CustomersAndOrders(
            measures:
            [
                TestFixtures.BuildMeasure(
                    "Filtered Count", "public.orders", Aggregation.Count,
                    filters: [TestFixtures.BuildMeasureFilter("public.orders", "no_such_column")]),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e =>
            e.Code == "MDL002" && e.Path == "measures[0].filters[0]" && e.Message.Contains("no_such_column"));
    }

    [Fact]
    public void TextToIntegerRelationshipEndpointsReportIncompatibleTypeError()
    {
        var definition = CustomersAndOrders(
            relationships:
            [
                TestFixtures.BuildRelationship("public.orders", "status", "public.customers", "id"),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL003");
    }

    [Fact]
    public void IntegerToDecimalRelationshipEndpointsAreJoinCompatible()
    {
        var definition = CustomersAndOrders(
            relationships:
            [
                TestFixtures.BuildRelationship("public.orders", "customer_id", "public.customers", "credit_limit"),
            ]);

        var result = Validate(definition);

        Assert.True(result.IsValid);
        Assert.DoesNotContain(result.Issues, i => i.Code == "MDL003");
    }

    [Fact]
    public void TwoActiveRelationshipsBetweenSameTablePairReportError()
    {
        var definition = CustomersAndOrders(
            relationships:
            [
                TestFixtures.BuildRelationship("public.orders", "customer_id", "public.customers", "id"),
                TestFixtures.BuildRelationship("public.orders", "id", "public.customers", "id"),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL004");
    }

    [Fact]
    public void ActivePlusInactiveRelationshipBetweenSameTablePairPasses()
    {
        var definition = CustomersAndOrders(
            relationships:
            [
                TestFixtures.BuildRelationship("public.orders", "customer_id", "public.customers", "id"),
                TestFixtures.BuildRelationship("public.orders", "id", "public.customers", "id", isActive: false),
            ]);

        var result = Validate(definition);

        Assert.True(result.IsValid);
        Assert.DoesNotContain(result.Issues, i => i.Code == "MDL004");
    }

    [Fact]
    public void SelfRelationshipReportsError()
    {
        var definition = TestFixtures.BuildModel(
            tables: [TestFixtures.BuildModelTable("public", "customers")],
            relationships:
            [
                TestFixtures.BuildRelationship("public.customers", "id", "public.customers", "name"),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL005");
    }

    [Fact]
    public void DuplicateRelationshipEndpointsReportWarning()
    {
        var definition = CustomersAndOrders(
            relationships:
            [
                TestFixtures.BuildRelationship("public.orders", "customer_id", "public.customers", "id"),
                TestFixtures.BuildRelationship("public.orders", "customer_id", "public.customers", "id", isActive: false),
            ]);

        var result = Validate(definition);

        Assert.True(result.IsValid);
        Assert.Contains(result.Warnings, w => w.Code == "MDL006");
    }

    [Fact]
    public void DuplicateRelationshipEndpointsInReversedDirectionReportWarning()
    {
        var definition = CustomersAndOrders(
            relationships:
            [
                TestFixtures.BuildRelationship("public.orders", "customer_id", "public.customers", "id"),
                TestFixtures.BuildRelationship("public.customers", "id", "public.orders", "customer_id", isActive: false),
            ]);

        var result = Validate(definition);

        Assert.True(result.IsValid);
        Assert.Contains(result.Warnings, w => w.Code == "MDL006");
    }

    [Fact]
    public void ThreeTableActiveCycleReportsError()
    {
        var definition = TestFixtures.BuildModel(
            tables:
            [
                TestFixtures.BuildModelTable("public", "customers"),
                TestFixtures.BuildModelTable("public", "orders"),
                TestFixtures.BuildModelTable("public", "inspections"),
            ],
            relationships:
            [
                TestFixtures.BuildRelationship("public.orders", "customer_id", "public.customers", "id"),
                TestFixtures.BuildRelationship("public.inspections", "order_id", "public.orders", "id"),
                TestFixtures.BuildRelationship("public.inspections", "id", "public.customers", "id"),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL007");
    }

    [Fact]
    public void SumOverTextColumnReportsAggregationError()
    {
        var definition = CustomersAndOrders(
            measures:
            [
                TestFixtures.BuildMeasure("Status Sum", "public.orders", Aggregation.Sum, "status"),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL008");
    }

    [Fact]
    public void CountWithoutColumnIsAllowed()
    {
        var definition = CustomersAndOrders(
            measures:
            [
                TestFixtures.BuildMeasure("Order Count", "public.orders", Aggregation.Count),
            ]);

        var result = Validate(definition);

        Assert.True(result.IsValid);
        Assert.Empty(result.Issues);
    }

    [Fact]
    public void SumWithoutColumnReportsAggregationError()
    {
        var definition = CustomersAndOrders(
            measures:
            [
                TestFixtures.BuildMeasure("Column-less Sum", "public.orders", Aggregation.Sum),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL008" && e.Message.Contains("no source column"));
    }

    [Theory]
    [InlineData(Aggregation.StdDev)]
    [InlineData(Aggregation.Variance)]
    [InlineData(Aggregation.Median)]
    public void StatisticalAggregationOverTextColumnReportsAggregationError(Aggregation aggregation)
    {
        var definition = CustomersAndOrders(
            measures:
            [
                TestFixtures.BuildMeasure("Bad Stat", "public.orders", aggregation, "status"),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL008");
    }

    [Fact]
    public void MedianOverDateColumnReportsAggregationError()
    {
        var definition = CustomersAndOrders(
            measures:
            [
                TestFixtures.BuildMeasure("Median Date", "public.orders", Aggregation.Median, "order_date"),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL008");
    }

    [Theory]
    [InlineData(Aggregation.StdDev)]
    [InlineData(Aggregation.Variance)]
    [InlineData(Aggregation.Median)]
    public void StatisticalAggregationOverNumericColumnIsAllowed(Aggregation aggregation)
    {
        var definition = CustomersAndOrders(
            measures:
            [
                TestFixtures.BuildMeasure("Stat Total", "public.orders", aggregation, "order_total"),
                TestFixtures.BuildMeasure("Stat Id", "public.orders", aggregation, "customer_id"),
            ]);

        var result = Validate(definition);

        Assert.True(result.IsValid);
        Assert.Empty(result.Issues);
    }

    [Fact]
    public void MinOverDateColumnIsAllowed()
    {
        var definition = CustomersAndOrders(
            measures:
            [
                TestFixtures.BuildMeasure("First Order Date", "public.orders", Aggregation.Min, "order_date"),
            ]);

        var result = Validate(definition);

        Assert.True(result.IsValid);
        Assert.Empty(result.Issues);
    }

    [Fact]
    public void ManyToOneOntoNonUniqueToColumnReportsWarning()
    {
        var definition = CustomersAndOrders(
            relationships:
            [
                TestFixtures.BuildRelationship("public.orders", "customer_id", "public.customers", "credit_limit"),
            ]);

        var result = Validate(definition);

        Assert.True(result.IsValid);
        Assert.Contains(result.Warnings, w => w.Code == "MDL009");
    }

    [Fact]
    public void ManyToOneOntoPrimaryKeyProducesNoCardinalityWarning()
    {
        var definition = CustomersAndOrders(
            relationships:
            [
                TestFixtures.BuildRelationship("public.orders", "customer_id", "public.customers", "id"),
            ]);

        var result = Validate(definition);

        Assert.True(result.IsValid);
        Assert.DoesNotContain(result.Issues, i => i.Code == "MDL009");
    }

    [Fact]
    public void DuplicateTableFriendlyNamesReportWarning()
    {
        var definition = TestFixtures.BuildModel(
            tables:
            [
                TestFixtures.BuildModelTable("public", "customers", friendlyName: "Shared Name"),
                TestFixtures.BuildModelTable("public", "orders", friendlyName: "shared name"),
            ]);

        var result = Validate(definition);

        Assert.True(result.IsValid);
        Assert.Contains(result.Warnings, w => w.Code == "MDL010");
    }

    [Fact]
    public void DuplicateMeasureNamesReportWarning()
    {
        var definition = CustomersAndOrders(
            measures:
            [
                TestFixtures.BuildMeasure("Total", "public.orders", Aggregation.Sum, "order_total"),
                TestFixtures.BuildMeasure("total", "public.orders", Aggregation.Count),
            ]);

        var result = Validate(definition);

        Assert.True(result.IsValid);
        Assert.Contains(result.Warnings, w => w.Code == "MDL010");
    }

    [Fact]
    public void JsonRelationshipEndpointReportsUnusableTypeError()
    {
        var definition = CustomersAndOrders(
            relationships:
            [
                TestFixtures.BuildRelationship("public.orders", "payload", "public.customers", "id"),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL011" && e.Message.Contains("payload"));
    }

    [Fact]
    public void OtherRelationshipEndpointReportsUnusableTypeError()
    {
        var definition = CustomersAndOrders(
            relationships:
            [
                TestFixtures.BuildRelationship("public.orders", "blob", "public.customers", "id"),
            ]);

        var result = Validate(definition);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.Code == "MDL011" && e.Message.Contains("blob"));
    }
}
