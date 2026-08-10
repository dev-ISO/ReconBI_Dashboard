using ReconDashboards.Core.Modeling;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Wire-format coverage for the measure metadata fields (description,
/// displayFolder, formatString) and date-table calendar settings
/// (fiscalYearStartMonth, weekStartDay). All optional-with-defaults so
/// pre-feature documents keep parsing under strict (Disallow) deserialization,
/// while unknown fields still fail loudly.
/// </summary>
public class ModelJsonMetadataTests
{
    [Fact]
    public void MeasureMetadataRoundTrips()
    {
        var demo = TestFixtures.BuildValidDemoModel();
        var styled = new Measure(
            Guid.NewGuid(), "Revenue", "public.orders", Aggregation.Sum, "order_total",
            FormatHint: "currency", Filters: null, Expression: null,
            Description: "Total invoiced revenue.",
            DisplayFolder: "Finance\\Core",
            FormatString: "$#,##0.00;($#,##0.00)");
        var original = demo with { Measures = [.. demo.Measures, styled] };

        var json = ModelJson.Serialize(original);
        var reloaded = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(error);
        Assert.NotNull(reloaded);
        var measure = reloaded.Measures.Single(m => m.Name == "Revenue");
        Assert.Equal("Total invoiced revenue.", measure.Description);
        Assert.Equal("Finance\\Core", measure.DisplayFolder);
        Assert.Equal("$#,##0.00;($#,##0.00)", measure.FormatString);

        Assert.Contains("\"description\":", json, StringComparison.Ordinal);
        Assert.Contains("\"displayFolder\":", json, StringComparison.Ordinal);
        Assert.Contains("\"formatString\":", json, StringComparison.Ordinal);
    }

    [Fact]
    public void NullMetadataIsOmittedFromTheDocument()
    {
        var json = ModelJson.Serialize(TestFixtures.BuildValidDemoModel());

        // WhenWritingNull: absent, not null — old engines reading v1 docs
        // never see the new fields unless they are set.
        Assert.DoesNotContain("description", json, StringComparison.Ordinal);
        Assert.DoesNotContain("displayFolder", json, StringComparison.Ordinal);
        Assert.DoesNotContain("formatString", json, StringComparison.Ordinal);
    }

    [Fact]
    public void DateTableCalendarSettingsRoundTrip()
    {
        var model = TestFixtures.BuildModel() with
        {
            DateTables =
            [
                new DateTableDef(
                    "fiscal", new DateOnly(2024, 7, 1), new DateOnly(2027, 6, 30),
                    FiscalYearStartMonth: 7, WeekStartDay: WeekStartDay.Sunday),
                new DateTableDef("plain"),
            ],
        };

        var json = ModelJson.Serialize(model);
        Assert.Contains("\"fiscalYearStartMonth\":7", json, StringComparison.Ordinal);
        Assert.Contains("\"weekStartDay\":\"sunday\"", json, StringComparison.Ordinal);

        var reloaded = ModelJson.TryDeserialize(json, out var error);
        Assert.Null(error);
        Assert.NotNull(reloaded);

        var fiscal = reloaded.FindDateTable("#date.fiscal");
        Assert.NotNull(fiscal);
        Assert.Equal(7, fiscal.FiscalYearStartMonth);
        Assert.Equal(WeekStartDay.Sunday, fiscal.WeekStartDay);
        Assert.False(fiscal.WeekStartsMonday);

        var plain = reloaded.FindDateTable("#date.plain");
        Assert.NotNull(plain);
        Assert.Null(plain.FiscalYearStartMonth);
        Assert.Null(plain.WeekStartDay);
        Assert.Equal(1, plain.EffectiveFiscalYearStartMonth);
        Assert.True(plain.WeekStartsMonday);
    }

    [Fact]
    public void MetadataFieldsParseFromCamelCaseJson()
    {
        const string json = """
            {
              "version": 1,
              "tables": [{"schema":"public","name":"orders"}],
              "relationships": [],
              "measures": [
                {
                  "id":"7e0f2f4e-8a45-4bcb-9a3f-333333333333",
                  "name":"Revenue","table":"public.orders","aggregation":"sum","column":"order_total",
                  "description":"Docs","displayFolder":"KPIs","formatString":"#,##0"
                }
              ],
              "dateTables": [{"name":"dates","fiscalYearStartMonth":10,"weekStartDay":"monday"}]
            }
            """;

        var definition = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(error);
        Assert.NotNull(definition);
        var measure = Assert.Single(definition.Measures);
        Assert.Equal("Docs", measure.Description);
        Assert.Equal("KPIs", measure.DisplayFolder);
        Assert.Equal("#,##0", measure.FormatString);
        var dateTable = Assert.Single(definition.DateTableDefs);
        Assert.Equal(10, dateTable.FiscalYearStartMonth);
        Assert.Equal(WeekStartDay.Monday, dateTable.WeekStartDay);
    }

    [Fact]
    public void UnknownMeasureFieldIsRejectedLoudly()
    {
        const string json = """
            {
              "version": 1,
              "tables": [{"schema":"public","name":"orders"}],
              "relationships": [],
              "measures": [
                {"id":"7e0f2f4e-8a45-4bcb-9a3f-444444444444","name":"X","table":"public.orders","aggregation":"sum","column":"order_total","bogusField":true}
              ]
            }
            """;

        var definition = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(definition);
        Assert.NotNull(error);
        Assert.Contains("bogusField", error, StringComparison.Ordinal);
    }

    [Fact]
    public void UnknownWeekStartDayValueIsRejectedLoudly()
    {
        const string json = """
            {
              "version": 1,
              "tables": [],
              "relationships": [],
              "measures": [],
              "dateTables": [{"name":"dates","weekStartDay":"saturday"}]
            }
            """;

        var definition = ModelJson.TryDeserialize(json, out var error);

        Assert.Null(definition);
        Assert.NotNull(error);
    }
}
