using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Scheduling;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// MDL017 — the model editor's copy of the compiler's derived-field rules, so
/// an author sees the mistake while typing rather than when a chart runs. Plus
/// the layout-document passthrough that keeps a dashboard-scoped derived field
/// alive through a scheduled email.
/// </summary>
public class SemanticModelValidatorDerivedFieldTests
{
    private static readonly SemanticModelValidator Validator = new();

    private static ModelDefinition Model(params DerivedField[] fields) =>
        TestFixtures.BuildValidDemoModel() with { DerivedFields = fields };

    private static DerivedField Field(string expression, string name = "Shipped?") =>
        new(Guid.NewGuid(), name, "public.orders", expression, DerivedField.TextDataType);

    private static ValidationResult Validate(ModelDefinition model) =>
        Validator.Validate(model, TestFixtures.BuildDemoSchema());

    private static ValidationIssue Mdl017(ModelDefinition model) =>
        Assert.Single(Validate(model).Issues, i => i.Code == "MDL017");

    [Fact]
    public void AValidDerivedFieldPassesValidation()
    {
        var result = Validate(Model(Field("IF(ISBLANK(public.orders.status), \"No\", \"Yes\")")));
        Assert.True(result.IsValid);
        Assert.DoesNotContain(result.Issues, i => i.Code == "MDL017");
    }

    [Fact]
    public void AModelWithNoDerivedFieldsIsUnaffected() =>
        Assert.True(Validate(TestFixtures.BuildValidDemoModel()).IsValid);

    [Fact]
    public void AnUnparseableExpressionIsMdl017OnTheExpressionPath()
    {
        var issue = Mdl017(Model(Field("this is not an expression")));
        Assert.Equal("derivedFields[0].expression", issue.Path);
    }

    [Fact]
    public void AnAggregateInADerivedFieldIsMdl017()
    {
        var issue = Mdl017(Model(Field("IF(sum(public.orders.order_total) > 0, \"a\", \"b\")")));
        Assert.Contains("aggregate", issue.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ACrossTableReferenceIsMdl017()
    {
        // Checked here too because it is a SECURITY rule, not a style rule: a
        // derived field that could read another table would be a table the join
        // plan — and therefore row-filter collection — never saw.
        var issue = Mdl017(Model(Field("IF(ISBLANK(public.customers.region), \"No\", \"Yes\")")));
        Assert.Contains("may only use that table's columns", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnUnknownColumnIsMdl017()
    {
        var issue = Mdl017(Model(Field("IF(ISBLANK(public.orders.nope), \"No\", \"Yes\")")));
        Assert.Contains("does not exist", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnUnusableColumnTypeIsMdl017()
    {
        var issue = Mdl017(Model(Field("IF(ISBLANK(public.orders.payload), \"No\", \"Yes\")")));
        Assert.Contains("cannot be used in an expression", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ANameThatShadowsARealColumnIsMdl017()
    {
        var issue = Mdl017(Model(Field("IF(ISBLANK(public.orders.status), \"No\", \"Yes\")", name: "status")));
        Assert.Equal("derivedFields[0].name", issue.Path);
        Assert.Contains("shadow", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TwoDerivedFieldsWithTheSameNameOnOneTableIsMdl017()
    {
        const string expression = "IF(ISBLANK(public.orders.status), \"No\", \"Yes\")";
        var issue = Mdl017(Model(Field(expression), Field(expression)));
        Assert.Equal("derivedFields[1].name", issue.Path);
    }

    [Fact]
    public void TheSameNameOnTwoTablesIsFine()
    {
        var onOrders = Field("IF(ISBLANK(public.orders.status), \"No\", \"Yes\")");
        var onCustomers = new DerivedField(
            Guid.NewGuid(), onOrders.Name, "public.customers",
            "IF(ISBLANK(public.customers.region), \"No\", \"Yes\")");

        Assert.DoesNotContain(Validate(Model(onOrders, onCustomers)).Issues, i => i.Code == "MDL017");
    }

    [Fact]
    public void ATableOutsideTheModelIsMdl017()
    {
        var field = new DerivedField(
            Guid.NewGuid(), "X", "public.inspections", "IF(ISBLANK(public.inspections.result), \"No\", \"Yes\")");
        var issue = Mdl017(Model(field));
        Assert.Equal("derivedFields[0].table", issue.Path);
    }

    [Fact]
    public void ANonTextDataTypeIsMdl017()
    {
        var field = Field("IF(ISBLANK(public.orders.status), \"No\", \"Yes\")") with { DataType = "integer" };
        var issue = Mdl017(Model(field));
        Assert.Contains("only 'text' is supported", issue.Message, StringComparison.Ordinal);
    }

    // ---------- the scheduled-email passthrough ----------

    [Fact]
    public void ALayoutDocumentsDerivedFieldsTravelWithTheTileThatUsesThem()
    {
        // Without this the doc holds the definition, the parser drops it, and
        // every scheduled send of that tile fails with QRY_UNKNOWN_COLUMN.
        const string layout = """
            {
              "derivedFields": [
                { "id": "11111111-2222-3333-4444-555555555555", "name": "Shipped?",
                  "table": "public.orders", "expression": "IF(ISBLANK(public.orders.status), \"No\", \"Yes\")",
                  "dataType": "text" },
                { "id": "99999999-9999-9999-9999-999999999999", "name": "Unused",
                  "table": "public.orders", "expression": "public.orders.status", "dataType": "text" }
              ],
              "tiles": [
                { "id": "t1", "kind": "chart",
                  "chart": { "type": "column", "title": "By upload",
                    "query": { "axis": { "table": "public.orders", "column": "Shipped?" },
                               "measures": [{ "table": "public.orders", "aggregation": "count" }] } } }
              ]
            }
            """;

        var tile = Assert.Single(Assert.Single(LayoutSnapshotParser.Parse(layout, modelId: 7)).Tiles);
        var field = Assert.Single(tile.Spec.DerivedFields!);

        Assert.Equal("Shipped?", field.Name);
        Assert.Equal("public.orders", field.Table);
    }

    [Fact]
    public void ALayoutWithoutDerivedFieldsCarriesNone()
    {
        const string layout = """
            {
              "tiles": [
                { "id": "t1", "kind": "chart",
                  "chart": { "type": "column",
                    "query": { "axis": { "table": "public.orders", "column": "status" },
                               "measures": [{ "table": "public.orders", "aggregation": "count" }] } } }
              ]
            }
            """;

        var tile = Assert.Single(Assert.Single(LayoutSnapshotParser.Parse(layout, modelId: 7)).Tiles);
        Assert.Null(tile.Spec.DerivedFields);
    }

    [Fact]
    public void AMalformedDerivedFieldInTheDocumentDoesNotFailTheDocument()
    {
        const string layout = """
            {
              "derivedFields": [ 42, { "id": "not-a-guid" } ],
              "tiles": [
                { "id": "t1", "kind": "chart",
                  "chart": { "type": "column",
                    "query": { "axis": { "table": "public.orders", "column": "status" },
                               "measures": [{ "table": "public.orders", "aggregation": "count" }] } } }
              ]
            }
            """;

        Assert.Single(Assert.Single(LayoutSnapshotParser.Parse(layout, modelId: 7)).Tiles);
        Assert.Empty(LayoutSnapshotParser.ParseDerivedFields(layout));
    }
}
