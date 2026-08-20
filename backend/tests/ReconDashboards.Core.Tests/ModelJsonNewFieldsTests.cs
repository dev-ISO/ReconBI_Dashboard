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

    /// <summary>
    /// ModelColumn.DisplayFolders — the field list's "Category" grouping. It is
    /// additive and optional, so an older document still parses; the pair of
    /// assertions below is what makes the library upgrade safe to ship BEFORE
    /// any host starts emitting it.
    /// </summary>
    [Fact]
    public void ColumnDisplayFoldersRoundTripAndAreOmittedWhenNull()
    {
        var demo = TestFixtures.BuildValidDemoModel();
        var table = demo.Tables[0];
        var original = demo with
        {
            Tables =
            [
                table with
                {
                    Columns =
                    [
                        // Many-to-many is the whole point: one column, several folders.
                        new ModelColumn("region", "Region",
                            DisplayFolders: ["Finance\\Core", "Mitigation"]),
                        // No folders at all — must serialize exactly as before.
                        new ModelColumn("name", "Customer"),
                    ],
                },
                .. demo.Tables.Skip(1),
            ],
        };

        var json = ModelJson.Serialize(original);
        var reloaded = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(error);
        Assert.NotNull(reloaded);
        var columns = reloaded.Tables[0].ColumnOverrides;
        var foldered = columns.Single(c => c.Name == "region");
        Assert.Equal(new[] { "Finance\\Core", "Mitigation" }, foldered.DisplayFolders);
        var unfoldered = columns.Single(c => c.Name == "name");
        Assert.Null(unfoldered.DisplayFolders);

        Assert.Contains(
            "\"displayFolders\":[\"Finance\\\\Core\",\"Mitigation\"]",
            json,
            StringComparison.Ordinal);
        // WhenWritingNull: a column that sets no folders emits no key at all,
        // so it is byte-identical to one written before the field existed.
        Assert.Contains(
            "{\"name\":\"name\",\"friendlyName\":\"Customer\",\"hidden\":false}",
            json,
            StringComparison.Ordinal);
    }

    /// <summary>
    /// The other half of the compatibility story: a document written by an
    /// OLDER engine (no displayFolders anywhere) still loads here, and a column
    /// folder list read from raw JSON lands where the field list expects it.
    /// </summary>
    [Fact]
    public void LegacyColumnsWithoutDisplayFoldersStillParse()
    {
        const string json = """
            {
              "version": 1,
              "tables": [
                {"schema":"public","name":"orders","columns":[
                  {"name":"order_total","friendlyName":"Total"},
                  {"name":"status","displayFolders":["Ops","Ops\\Detail"]}
                ]}
              ],
              "relationships": [],
              "measures": []
            }
            """;

        var definition = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(error);
        Assert.NotNull(definition);
        var columns = definition.Tables[0].ColumnOverrides;
        Assert.Null(columns.Single(c => c.Name == "order_total").DisplayFolders);
        Assert.Equal(
            new[] { "Ops", "Ops\\Detail" },
            columns.Single(c => c.Name == "status").DisplayFolders);
    }

    /// <summary>
    /// THE DISALLOW CONTRACT, stated as a test: adding displayFolders did not
    /// loosen strictness. An unknown member is still a hard failure, which is
    /// exactly why a host must not emit a new field speculatively.
    /// </summary>
    [Fact]
    public void UnknownColumnMemberIsStillRejected()
    {
        const string json = """
            {
              "version": 1,
              "tables": [
                {"schema":"public","name":"orders","columns":[{"name":"status","displayFolder":"Ops"}]}
              ],
              "relationships": [],
              "measures": []
            }
            """;

        var definition = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(definition);
        Assert.NotNull(error);
        Assert.Contains("displayFolder", error, StringComparison.Ordinal);
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

    [Fact]
    public void DerivedFieldsRoundTripAndAreOmittedWhenAbsent()
    {
        const string json = """
            {
              "version": 1,
              "tables": [{"schema":"public","name":"orders"}],
              "relationships": [],
              "measures": [],
              "derivedFields": [
                {"id":"11111111-2222-3333-4444-555555555555","name":"Shipped?","table":"public.orders",
                 "expression":"IF(ISBLANK(public.orders.status), 'No', 'Yes')","dataType":"text"}
              ]
            }
            """;

        var definition = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(error);
        Assert.NotNull(definition);
        var field = Assert.Single(definition.DerivedFieldDefs);
        Assert.Equal("Shipped?", field.Name);
        Assert.Equal("public.orders", field.Table);
        Assert.True(field.IsTextTyped);

        // Re-serializing keeps it, and a model WITHOUT derived fields stays
        // byte-identical to one written before the field existed — which is
        // what lets this ship ahead of any host that populates it.
        Assert.Contains("derivedFields", ModelJson.Serialize(definition), StringComparison.Ordinal);
        Assert.DoesNotContain(
            "derivedFields",
            ModelJson.Serialize(definition with { DerivedFields = null }),
            StringComparison.Ordinal);
    }
}
