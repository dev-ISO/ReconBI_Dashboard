using ReconDashboards.Core.Modeling;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Wire-format coverage for the v1 additive fields: measure expressions and
/// date tables. Both are optional-with-defaults, so documents saved before the
/// features existed still parse under strict (Disallow) deserialization.
/// </summary>
public class ModelJsonNewFieldsTests
{
    [Fact]
    public void RoundTripPreservesExpressionAndDateTables()
    {
        var demo = TestFixtures.BuildValidDemoModel();
        var expression = new Measure(
            Guid.NewGuid(), "Avg Order Value", "public.orders", Aggregation.Sum,
            Column: null, FormatHint: "0.00", Filters: null,
            Expression: "[Total Order Value] / count(*)");
        var original = demo with
        {
            Measures = [.. demo.Measures, expression],
            DateTables =
            [
                new DateTableDef("dates", new DateOnly(2020, 1, 1), new DateOnly(2030, 12, 31)),
                new DateTableDef("fiscal"),
            ],
        };

        var json = ModelJson.Serialize(original);
        var reloaded = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(error);
        Assert.NotNull(reloaded);

        var reloadedExpression = reloaded.Measures.Single(m => m.Name == "Avg Order Value");
        Assert.Equal("[Total Order Value] / count(*)", reloadedExpression.Expression);
        Assert.Null(reloadedExpression.Column);

        Assert.Equal(2, reloaded.DateTableDefs.Count);
        var bounded = reloaded.FindDateTable("#date.dates");
        Assert.NotNull(bounded);
        Assert.Equal(new DateOnly(2020, 1, 1), bounded.RangeStart);
        Assert.Equal(new DateOnly(2030, 12, 31), bounded.RangeEnd);
        var open = reloaded.FindDateTable("#date.fiscal");
        Assert.NotNull(open);
        Assert.Null(open.RangeStart);
        Assert.Null(open.RangeEnd);
    }

    [Fact]
    public void DateRangesSerializeAsIsoDates()
    {
        var model = TestFixtures.BuildModel() with
        {
            DateTables = [new DateTableDef("dates", new DateOnly(2026, 1, 1), null)],
        };

        var json = ModelJson.Serialize(model);

        Assert.Contains("\"rangeStart\":\"2026-01-01\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("rangeEnd", json, StringComparison.Ordinal); // WhenWritingNull
    }

    [Fact]
    public void LegacyDocumentWithoutNewFieldsStillParses()
    {
        // A pre-feature stored document: no "expression" on measures, no "dateTables".
        const string json = """
            {
              "version": 1,
              "tables": [{"schema":"public","name":"orders"}],
              "relationships": [],
              "measures": [
                {"id":"7e0f2f4e-8a45-4bcb-9a3f-111111111111","name":"Total","table":"public.orders","aggregation":"sum","column":"order_total"}
              ]
            }
            """;

        var definition = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(error);
        Assert.NotNull(definition);
        var measure = Assert.Single(definition.Measures);
        Assert.Null(measure.Expression);
        Assert.Empty(definition.DateTableDefs);
    }

    [Fact]
    public void ExpressionMeasureJsonWithCamelCaseFieldsParses()
    {
        const string json = """
            {
              "version": 1,
              "tables": [{"schema":"public","name":"orders"}],
              "relationships": [],
              "measures": [
                {"id":"7e0f2f4e-8a45-4bcb-9a3f-222222222222","name":"AOV","table":"public.orders","aggregation":"sum","expression":"[Total] / count(*)"}
              ],
              "dateTables": [{"name":"dates","rangeStart":"2026-01-01"}]
            }
            """;

        var definition = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(error);
        Assert.NotNull(definition);
        Assert.Equal("[Total] / count(*)", Assert.Single(definition.Measures).Expression);
        var dateTable = Assert.Single(definition.DateTableDefs);
        Assert.Equal("#date.dates", dateTable.Key);
        Assert.Equal(new DateOnly(2026, 1, 1), dateTable.RangeStart);
        Assert.Null(dateTable.RangeEnd);
    }
}
