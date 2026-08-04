using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Validator coverage for virtual date tables: MDL001 (name existence/
/// duplicates), MDL002 (undeclared date-table endpoint), MDL003 (endpoint rules:
/// to side must be date_key, from side must be Date/Timestamp, date table never
/// on the from side), MDL015 (inverted range). A proven date_key primary key
/// means no MDL009 warning.
/// </summary>
public class SemanticModelValidatorDateTableTests
{
    private static readonly DateTableDef Dates = new("dates");

    private static ModelDefinition OrdersModel(
        IReadOnlyList<DateTableDef> dateTables, params Relationship[] relationships) =>
        TestFixtures.BuildModel(
            tables: [TestFixtures.BuildModelTable("public", "orders")],
            relationships: relationships) with
        { DateTables = dateTables };

    private static ValidationResult Validate(ModelDefinition model, DatabaseSchema? schema = null) =>
        new SemanticModelValidator().Validate(model, schema ?? TestFixtures.BuildDemoSchema());

    private static ValidationIssue AssertSingleError(ValidationResult result, string code)
    {
        var issue = Assert.Single(result.Errors);
        Assert.Equal(code, issue.Code);
        return issue;
    }

    [Fact]
    public void DateColumnRelationshipToDateTableIsValidWithNoWarnings()
    {
        var model = OrdersModel(
            [Dates],
            TestFixtures.BuildRelationship("public.orders", "order_date", Dates.Key, "date_key"));

        var result = Validate(model);

        Assert.True(result.IsValid);
        Assert.Empty(result.Issues); // esp. no MDL009: date_key is a proven primary key
    }

    [Fact]
    public void TimestampColumnRelationshipToDateTableIsValid()
    {
        var demo = TestFixtures.BuildDemoSchema();
        var schema = demo with
        {
            Tables =
            [
                .. demo.Tables,
                TestFixtures.BuildTable(
                    "public", "events",
                    TestFixtures.BuildColumn("id", 1, NormalizedType.Integer),
                    TestFixtures.BuildColumn("created_at", 2, NormalizedType.Timestamp)),
            ],
        };
        var model = TestFixtures.BuildModel(
            tables: [TestFixtures.BuildModelTable("public", "events")],
            relationships:
            [
                TestFixtures.BuildRelationship("public.events", "created_at", Dates.Key, "date_key"),
            ]) with
        { DateTables = [Dates] };

        var result = Validate(model, schema);

        Assert.True(result.IsValid);
    }

    [Fact]
    public void RelationshipTargetingANonDateKeyColumnIsMdl003()
    {
        var model = OrdersModel(
            [Dates],
            TestFixtures.BuildRelationship("public.orders", "order_date", Dates.Key, "year"));

        var issue = AssertSingleError(Validate(model), "MDL003");
        Assert.Contains("date_key", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void NonDateFromColumnIsMdl003()
    {
        var model = OrdersModel(
            [Dates],
            TestFixtures.BuildRelationship("public.orders", "status", Dates.Key, "date_key"));

        var issue = AssertSingleError(Validate(model), "MDL003");
        Assert.Contains("date or timestamp", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DateTableOnTheFromSideIsMdl003()
    {
        var model = OrdersModel(
            [Dates],
            TestFixtures.BuildRelationship(Dates.Key, "date_key", "public.orders", "order_date"));

        var issue = AssertSingleError(Validate(model), "MDL003");
        Assert.Contains("from side", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RelationshipToAnUndeclaredDateTableIsMdl002()
    {
        var model = OrdersModel(
            [Dates],
            TestFixtures.BuildRelationship("public.orders", "order_date", "#date.nope", "date_key"));

        var issue = AssertSingleError(Validate(model), "MDL002");
        Assert.Contains("#date.nope", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DuplicateDateTableNamesAreMdl001CaseInsensitive()
    {
        var model = OrdersModel([new DateTableDef("dates"), new DateTableDef("Dates")]);

        AssertSingleError(Validate(model), "MDL001");
    }

    [Fact]
    public void EmptyDateTableNameIsMdl001()
    {
        var model = OrdersModel([new DateTableDef("  ")]);

        AssertSingleError(Validate(model), "MDL001");
    }

    [Fact]
    public void InvertedRangeIsMdl015()
    {
        var model = OrdersModel(
            [new DateTableDef("dates", new DateOnly(2027, 1, 1), new DateOnly(2026, 1, 1))]);

        var issue = AssertSingleError(Validate(model), "MDL015");
        Assert.Contains("2027-01-01", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EqualRangeBoundsAreAllowed()
    {
        var oneDay = new DateOnly(2026, 5, 1);
        var model = OrdersModel([new DateTableDef("dates", oneDay, oneDay)]);

        Assert.True(Validate(model).IsValid);
    }
}
