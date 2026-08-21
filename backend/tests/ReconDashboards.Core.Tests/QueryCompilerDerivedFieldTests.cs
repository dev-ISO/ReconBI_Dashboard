using System.Text.Json;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// The derived-field engine at the compiler level: what the two authoring paths
/// emit, what they refuse, and — the load-bearing one — that NO AUTHOR TEXT
/// EVER REACHES THE STATEMENT.
///
/// The catalog here is the owner's real shape: <c>public.reviews.edms_uploaded</c>
/// holds either a keyword or a date per row, plus blanks.
/// </summary>
public class QueryCompilerDerivedFieldTests
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static readonly Guid FieldId = Guid.Parse("11111111-2222-3333-4444-555555555555");

    private const string OwnerExpression = "IF(ISBLANK(public.reviews.edms_uploaded), \"No\", \"Yes\")";

    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);

    private static DatabaseSchema Schema() => new(
        TestFixtures.DemoConnectionName,
        FetchedAtUtc: new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
        VersionHash: "fixture-hash",
        Tables:
        [
            TestFixtures.BuildTable(
                "public", "reviews",
                TestFixtures.BuildColumn("id", 1, NormalizedType.Integer),
                TestFixtures.BuildColumn("region", 2, NormalizedType.Text),
                TestFixtures.BuildColumn("edms_uploaded", 3, NormalizedType.Text, isNullable: true),
                TestFixtures.BuildColumn("reviewed_on", 4, NormalizedType.Date, isNullable: true)),
            TestFixtures.BuildCustomersTable(),
        ],
        ForeignKeys: []);

    private static DerivedField OwnerField(string? expression = null, string name = "EDMS Uploaded?") =>
        new(FieldId, name, "public.reviews", expression ?? OwnerExpression, DerivedField.TextDataType);

    private static ModelDefinition Model(params DerivedField[] fields) => new(
        ModelDefinition.CurrentVersion,
        Tables: [TestFixtures.BuildModelTable("public", "reviews"), TestFixtures.BuildModelTable("public", "customers")],
        Relationships: [],
        Measures: [],
        DateTables: null,
        DerivedFields: fields.Length == 0 ? null : fields);

    private static MeasureSpec CountReviews() => new(null, "public.reviews", null, Aggregation.Count, null);

    private static ChartQuerySpec Spec(
        IReadOnlyList<DimensionSpec>? dimensions = null,
        IReadOnlyList<FilterSpec>? filters = null,
        IReadOnlyList<DerivedField>? derivedFields = null) =>
        new(1, dimensions ?? [], [CountReviews()], filters ?? [], [], null, null,
            DerivedFields: derivedFields);

    private static CompiledQuery Compile(
        ChartQuerySpec spec,
        ModelDefinition? model = null,
        IReadOnlyDictionary<string, IReadOnlyList<RowFilter>>? rowFilters = null)
    {
        var limits = new RcdLimits();
        var effective = MeasureOverlay.Merge(model ?? Model(), spec.Definitions, spec.DerivedFields, limits);
        var prepared = Compiler.Prepare(spec, effective, Schema(), limits);
        return Compiler.Emit(prepared, spec, rowFilters ?? NoRowFilters, limits, new DataSourceOptions());
    }

    private static QueryCompilationException CompileError(
        ChartQuerySpec spec, ModelDefinition? model = null) =>
        Assert.Throws<QueryCompilationException>(() => Compile(spec, model));

    // ---------- G3: what a derived field emits ----------

    [Fact]
    public void DerivedFieldEmitsItsCaseExpressionInSelectAndGroupBy()
    {
        var compiled = Compile(
            Spec([new DimensionSpec("public.reviews", "EDMS Uploaded?", null)]),
            Model(OwnerField()));

        const string expected =
            "CASE WHEN (\"t0\".\"edms_uploaded\" IS NULL OR CAST(\"t0\".\"edms_uploaded\" AS text) = @p0) THEN @p1 ELSE @p2 END";

        Assert.Equal(
            $"""
             SELECT {expected} AS "dim0",
                    COUNT(*) AS "meas0"
             FROM "public"."reviews" AS "t0"
             GROUP BY {expected}
             ORDER BY {expected} ASC NULLS LAST
             LIMIT @p3
             """.ReplaceLineEndings("\n"),
            compiled.Sql);

        Assert.Equal(["", "No", "Yes", 5_001L], compiled.Parameters.Select(p => p.Value).ToArray());
    }

    [Fact]
    public void DerivedFieldIsAddressableByIdAsWellAsName()
    {
        var byId = Compile(
            Spec([new DimensionSpec("public.reviews", FieldId.ToString(), null)]), Model(OwnerField()));
        var byName = Compile(
            Spec([new DimensionSpec("public.reviews", "EDMS Uploaded?", null)]), Model(OwnerField()));

        Assert.Equal(byName.Sql, byId.Sql);
    }

    // ---------- G1/G3: THE INJECTION BAR ----------

    [Fact]
    public void NoLiteralTextFromTheAuthorReachesTheStatement()
    {
        // The renderer emits validated digits, whitelisted operators and
        // resolved catalog identifiers. String literals are the FIRST category
        // of author text it could output — and it must not.
        const string hostile = "'); DROP TABLE reviews; --";
        var field = OwnerField(
            $"IF(ISBLANK(public.reviews.edms_uploaded), \"{hostile}\", \"Yes\")");

        var compiled = Compile(
            Spec([new DimensionSpec("public.reviews", "EDMS Uploaded?", null)]), Model(field));

        Assert.DoesNotContain("DROP", compiled.Sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("--", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("Yes", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("'", compiled.Sql, StringComparison.Ordinal);

        // It is present exactly once, as DATA, on a bound parameter.
        Assert.Single(compiled.Parameters, p => Equals(p.Value, hostile));
        Assert.Contains(compiled.Parameters, p => Equals(p.Value, "Yes"));
    }

    [Fact]
    public void NoGroupingLabelOrMatchValueReachesTheStatement()
    {
        const string hostile = "West' OR 1=1 --";
        var grouping = new GroupingRule(
            [
                new GroupingBucket("No", MatchBlank: true),
                new GroupingBucket(hostile, [Json(hostile)]),
            ],
            OtherLabel: "Yes");

        var compiled = Compile(Spec([new DimensionSpec("public.reviews", "edms_uploaded", null, grouping)]));

        Assert.DoesNotContain("OR 1=1", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("--", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("West", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("'", compiled.Sql, StringComparison.Ordinal);
        Assert.Contains(compiled.Parameters, p => Equals(p.Value, hostile));
    }

    // ---------- G3: the grouping rule ----------

    [Fact]
    public void GroupingEmitsABoundCaseAndReusesItInGroupBy()
    {
        // The owner's literal ask, authored without a formula: blank -> "No",
        // everything else -> "Yes".
        var grouping = new GroupingRule([new GroupingBucket("No", MatchBlank: true)], OtherLabel: "Yes");
        var compiled = Compile(Spec([new DimensionSpec("public.reviews", "edms_uploaded", null, grouping)]));

        const string expected =
            "CASE WHEN \"t0\".\"edms_uploaded\" IS NULL OR CAST(\"t0\".\"edms_uploaded\" AS text) = @p0 THEN @p1 ELSE @p2 END";

        Assert.Contains($"{expected} AS \"dim0\"", compiled.Sql, StringComparison.Ordinal);
        Assert.Contains($"GROUP BY {expected}", compiled.Sql, StringComparison.Ordinal);
        Assert.Equal(["", "No", "Yes", 5_001L], compiled.Parameters.Select(p => p.Value).ToArray());
    }

    [Fact]
    public void GroupingWithMatchedValuesBindsThemAsAnArray()
    {
        var grouping = new GroupingRule(
            [new GroupingBucket("Coastal", [Json("West"), Json("East")])], OtherLabel: "Inland");
        var compiled = Compile(Spec([new DimensionSpec("public.reviews", "region", null, grouping)]));

        Assert.Contains(
            "CASE WHEN \"t0\".\"region\" = ANY(@p0) THEN @p1 ELSE @p2 END",
            compiled.Sql,
            StringComparison.Ordinal);
        var array = Assert.Single(compiled.Parameters, p => p.IsArray);
        Assert.Equal(["West", "East"], ((IReadOnlyList<object?>)array.Value!).ToArray());
    }

    [Fact]
    public void GroupingWithoutAnOtherLabelKeepsUnmatchedValuesAsTheirOwnText()
    {
        var grouping = new GroupingRule([new GroupingBucket("(none)", MatchBlank: true)]);
        var compiled = Compile(Spec([new DimensionSpec("public.reviews", "region", null, grouping)]));

        Assert.Contains("ELSE CAST(\"t0\".\"region\" AS text) END", compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void GroupingComposesOverADerivedColumn()
    {
        var grouping = new GroupingRule([new GroupingBucket("Not uploaded", [Json("No")])], OtherLabel: "Uploaded");
        var compiled = Compile(
            Spec([new DimensionSpec("public.reviews", "EDMS Uploaded?", null, grouping)]),
            Model(OwnerField()));

        // The grouping CASE wraps the derived CASE — one seam, composed.
        Assert.Contains(
            "CASE WHEN CASE WHEN (\"t0\".\"edms_uploaded\" IS NULL",
            compiled.Sql,
            StringComparison.Ordinal);
    }

    [Fact]
    public void GroupingComposesOverADateBucket()
    {
        var grouping = new GroupingRule([new GroupingBucket("(none)", MatchBlank: true)], OtherLabel: "Reviewed");
        var compiled = Compile(
            Spec([new DimensionSpec("public.reviews", "reviewed_on", DateBucket.Month, grouping)]));

        Assert.Contains(
            "CASE WHEN date_trunc('month', \"t0\".\"reviewed_on\") IS NULL",
            compiled.Sql,
            StringComparison.Ordinal);

        // …but the RESULT no longer claims to be a date bucket. The renderer
        // formats a bucket as a date, and the layout engine drops the blank
        // bucket of a date axis — which would delete the very bar the grouping
        // was created to produce.
        Assert.Null(compiled.Columns[0].DateBucket);
        Assert.Equal(NormalizedType.Text, compiled.Columns[0].Type);
    }

    [Fact]
    public void AGroupedAxisIsNotDensifiedByAWindowCalc()
    {
        // Densification generates a date series and LEFT JOINs the base onto
        // it; against a text axis that is nonsense, so a prior-period calc on a
        // grouped axis is refused rather than silently mis-shaped.
        var grouping = new GroupingRule([new GroupingBucket("(none)", MatchBlank: true)], OtherLabel: "Reviewed");
        var spec = new ChartQuerySpec(
            1,
            [new DimensionSpec("public.reviews", "reviewed_on", DateBucket.Month, grouping)],
            [CountReviews() with { Calc = new MeasureCalcSpec(MeasureCalcKind.PriorPeriod) }],
            [], [], null, null);

        var ex = CompileError(spec);
        Assert.Equal("QRY_CALC_NEEDS_DATE_AXIS", ex.Code);
    }

    [Theory]
    [InlineData(0, null, "defines no groups")]
    [InlineData(1, "", "needs a label")]
    public void MalformedGroupingIsRejected(int groups, string? label, string expected)
    {
        var grouping = new GroupingRule(
            groups == 0 ? [] : [new GroupingBucket(label!, MatchBlank: true)]);
        var ex = CompileError(Spec([new DimensionSpec("public.reviews", "region", null, grouping)]));
        Assert.Equal("QRY_BAD_GROUPING", ex.Code);
        Assert.Contains(expected, ex.Message, StringComparison.Ordinal);
        Assert.Equal("dimensions[0]", ex.Path);
    }

    [Fact]
    public void GroupThatMatchesNothingIsRejected()
    {
        var grouping = new GroupingRule([new GroupingBucket("Empty")]);
        var ex = CompileError(Spec([new DimensionSpec("public.reviews", "region", null, grouping)]));
        Assert.Equal("QRY_BAD_GROUPING", ex.Code);
        Assert.Contains("matches nothing", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TooManyGroupsAreRejected()
    {
        var grouping = new GroupingRule(
            [.. Enumerable.Range(0, QueryCompiler.MaxGroupingBuckets + 1)
                .Select(i => new GroupingBucket($"g{i}", [Json($"v{i}")]))]);
        var ex = CompileError(Spec([new DimensionSpec("public.reviews", "region", null, grouping)]));
        Assert.Equal("QRY_BAD_GROUPING", ex.Code);
    }

    // ---------- G2: same-table is a security property ----------

    [Fact]
    public void ADerivedFieldMayNotReferenceAnotherTable()
    {
        var field = OwnerField("IF(ISBLANK(public.customers.region), \"No\", \"Yes\")");
        var ex = CompileError(
            Spec([new DimensionSpec("public.reviews", "EDMS Uploaded?", null)]), Model(field));

        Assert.Equal("QRY_DERIVED_CROSS_TABLE", ex.Code);
        Assert.Contains("may only use that table's columns", ex.Message, StringComparison.Ordinal);
        Assert.Equal("dimensions[0]", ex.Path);
    }

    [Fact]
    public void ADerivedFieldMayNotReferenceAnUnknownColumnOfItsOwnTable()
    {
        var field = OwnerField("IF(ISBLANK(public.reviews.nope), \"No\", \"Yes\")");
        var ex = CompileError(
            Spec([new DimensionSpec("public.reviews", "EDMS Uploaded?", null)]), Model(field));
        Assert.Equal("QRY_UNKNOWN_COLUMN", ex.Code);
    }

    [Fact]
    public void ADerivedFieldMayNotShadowARealColumn()
    {
        // THE SHADOWING GUARD. A row-level security filter names its column by
        // string; if a derived field could take that name, the host's filter
        // would silently start filtering an author-written expression.
        var field = OwnerField(name: "region");
        var ex = Assert.Throws<QueryCompilationException>(
            () => Compile(Spec([new DimensionSpec("public.reviews", "region", null)]), Model(field)));

        Assert.Equal("QRY_DERIVED_NAME_CONFLICT", ex.Code);
        Assert.Contains("never shadow a real column", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ADerivedFieldMayNotReferenceAnotherDerivedField()
    {
        var first = OwnerField();
        var second = new DerivedField(
            Guid.NewGuid(), "Second", "public.reviews",
            "IF(ISBLANK(public.reviews.\"EDMS Uploaded?\"), \"a\", \"b\")");

        // The quoted form does not even parse — identifiers are bare — so the
        // reachable shape is the bare one, which resolves to the derived column.
        var bare = second with { Expression = "IF(public.reviews.Uploaded = \"Yes\", \"a\", \"b\")" };
        var model = Model(first with { Name = "Uploaded" }, bare);

        var ex = CompileError(Spec([new DimensionSpec("public.reviews", "Second", null)]), model);
        Assert.Equal("QRY_BAD_DERIVED", ex.Code);
        Assert.Contains("may only use physical columns", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ABrokenExpressionFailsWithTheWellsPath()
    {
        var ex = CompileError(
            Spec([new DimensionSpec("public.reviews", "EDMS Uploaded?", null)]),
            Model(OwnerField("sum(public.reviews.id)")));

        Assert.Equal("QRY_BAD_DERIVED", ex.Code);
        Assert.Equal("dimensions[0]", ex.Path);
    }

    [Fact]
    public void AnUnusedBrokenDerivedFieldCostsNothing()
    {
        // Structural checks run at injection; expressions are parsed only when
        // something references them.
        var compiled = Compile(
            Spec([new DimensionSpec("public.reviews", "region", null)]),
            Model(OwnerField("this is not an expression")));

        Assert.Contains("\"t0\".\"region\"", compiled.Sql, StringComparison.Ordinal);
    }

    // ---------- G3: a derived column is already text ----------

    [Fact]
    public void DateBucketOnADerivedColumnIsRefused()
    {
        var ex = CompileError(
            Spec([new DimensionSpec("public.reviews", "EDMS Uploaded?", DateBucket.Month)]), Model(OwnerField()));

        Assert.Equal("QRY_BAD_BUCKET", ex.Code);
        Assert.Contains("is a derived field", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AggregatingADerivedColumnIsRefused()
    {
        var spec = new ChartQuerySpec(
            1, [], [new MeasureSpec(null, "public.reviews", "EDMS Uploaded?", Aggregation.CountDistinct, null)],
            [], [], null, null);
        var ex = CompileError(spec, Model(OwnerField()));

        Assert.Equal("QRY_BAD_MEASURE", ex.Code);
        Assert.Contains("not a value to aggregate", ex.Message, StringComparison.Ordinal);
    }

    // ---------- G4: predicates against the expression ----------

    [Fact]
    public void AFilterOnADerivedColumnCompilesAgainstTheExpression()
    {
        // This is the shape drill-down, cross-filter, see-records and header
        // filters all send: an eq clause naming the column.
        var compiled = Compile(
            Spec(
                [new DimensionSpec("public.reviews", "region", null)],
                [new FilterSpec("public.reviews", "EDMS Uploaded?", FilterOperator.Eq, [Json("Yes")])]),
            Model(OwnerField()));

        Assert.Contains(
            "WHERE CASE WHEN (\"t0\".\"edms_uploaded\" IS NULL OR CAST(\"t0\".\"edms_uploaded\" AS text) = @p0) THEN @p1 ELSE @p2 END = @p3",
            compiled.Sql,
            StringComparison.Ordinal);
        Assert.Contains(compiled.Parameters, p => Equals(p.Value, "Yes"));
    }

    [Fact]
    public void AnInFilterOnADerivedColumnCompilesAgainstTheExpression()
    {
        var compiled = Compile(
            Spec(
                [new DimensionSpec("public.reviews", "region", null)],
                [new FilterSpec("public.reviews", "EDMS Uploaded?", FilterOperator.In, [Json("Yes"), Json("No")])]),
            Model(OwnerField()));

        Assert.Contains("END = ANY(@p3)", compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void DistinctValuesOfADerivedColumnSelectTheExpression()
    {
        var limits = new RcdLimits();
        var spec = new DistinctValuesSpec(
            1, "public.reviews", "EDMS Uploaded?", null, [], null, DerivedFields: [OwnerField()]);
        var effective = MeasureOverlay.Merge(Model(), definitions: null, spec.DerivedFields, limits);
        var prepared = Compiler.PrepareDistinct(spec, effective, Schema(), limits);
        var compiled = Compiler.EmitDistinct(prepared, NoRowFilters);

        Assert.Contains("SELECT DISTINCT CASE WHEN", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("\"EDMS Uploaded?\"", compiled.Sql, StringComparison.Ordinal);
        Assert.Equal("#derived." + FieldId, compiled.Columns[0].Source);
    }

    // ---------- G5: result plans ----------

    [Fact]
    public void ADerivedDimensionDeclaresTextAndASyntheticStableSource()
    {
        var compiled = Compile(
            Spec([new DimensionSpec("public.reviews", "EDMS Uploaded?", null)]), Model(OwnerField()));

        var column = compiled.Columns[0];
        Assert.Equal(NormalizedType.Text, column.Type);
        Assert.Equal($"#derived.{FieldId}", column.Source);
        Assert.Null(column.DateBucket);
        Assert.Equal("EDMS Uploaded?", column.Label);
    }

    [Fact]
    public void AGroupedDimensionDeclaresTextAndItsOwnSource()
    {
        // NOT null (the table renderer treats null as a wildcard and would
        // highlight the wrong cell) and NOT the raw column (a grouped column
        // and its ungrouped twin are different series).
        var grouping = new GroupingRule([new GroupingBucket("No", MatchBlank: true)], OtherLabel: "Yes");
        var compiled = Compile(
            Spec(
                [
                    new DimensionSpec("public.reviews", "edms_uploaded", null, grouping),
                    new DimensionSpec("public.reviews", "edms_uploaded", null),
                ]));

        Assert.Equal(NormalizedType.Text, compiled.Columns[0].Type);
        Assert.Equal("#group.public.reviews.edms_uploaded", compiled.Columns[0].Source);
        Assert.Equal("public.reviews.edms_uploaded", compiled.Columns[1].Source);
    }

    // ---------- G2/G6: RLS ----------

    [Fact]
    public void ADerivedDimensionsTableStillReceivesItsRowFilters()
    {
        // *** THE SECURITY REGRESSION. *** A derived field is same-table by
        // construction, so the table it reads is the one the dimension already
        // put in the join plan — and therefore the one CollectRowFiltersAsync
        // consults and AppendRowFilterPredicates constrains.
        var limits = new RcdLimits();
        var spec = Spec([new DimensionSpec("public.reviews", "EDMS Uploaded?", null)], derivedFields: [OwnerField()]);
        var effective = MeasureOverlay.Merge(Model(), spec.Definitions, spec.DerivedFields, limits);
        var prepared = Compiler.Prepare(spec, effective, Schema(), limits);

        Assert.Contains("public.reviews", prepared.Plan.Tables);

        var rowFilters = new Dictionary<string, IReadOnlyList<RowFilter>>
        {
            ["public.reviews"] = [new RowFilter("region", RowFilterOperator.Equals, ["West"])],
        };
        var filtered = Compiler.Emit(prepared, spec, rowFilters, limits, new DataSourceOptions());
        var unfiltered = Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions());

        Assert.Contains("\"t0\".\"region\" = @", filtered.Sql, StringComparison.Ordinal);
        Assert.Contains(filtered.Parameters, p => Equals(p.Value, "West"));
        Assert.DoesNotContain("\"region\"", unfiltered.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void ADerivedFieldNeverWidensTheJoinPlan()
    {
        // The counterpart of the measure-overlay rule: because a derived field
        // cannot name another table, it can never pull one into the plan — so
        // there is no table it could read that row filters would miss.
        var limits = new RcdLimits();
        var spec = Spec([new DimensionSpec("public.reviews", "EDMS Uploaded?", null)], derivedFields: [OwnerField()]);
        var effective = MeasureOverlay.Merge(Model(), spec.Definitions, spec.DerivedFields, limits);
        var prepared = Compiler.Prepare(spec, effective, Schema(), limits);

        Assert.Equal(["public.reviews"], prepared.Plan.Tables.ToArray());
    }

    // ---------- G6: the definitions channel ----------

    [Fact]
    public void ADerivedFieldOnTheQueryWireResolvesLikeAModelOne()
    {
        var onWire = Compile(
            Spec([new DimensionSpec("public.reviews", "EDMS Uploaded?", null)], derivedFields: [OwnerField()]));
        var inModel = Compile(
            Spec([new DimensionSpec("public.reviews", "EDMS Uploaded?", null)]), Model(OwnerField()));

        Assert.Equal(inModel.Sql, onWire.Sql);
    }

    [Fact]
    public void AWireDerivedFieldCollidingWithAModelOneIsRejected()
    {
        var limits = new RcdLimits();
        var ex = Assert.Throws<QueryCompilationException>(
            () => MeasureOverlay.Merge(Model(OwnerField()), null, [OwnerField()], limits));
        Assert.Equal("QRY_DUPLICATE_DERIVED_ID", ex.Code);
    }

    [Fact]
    public void AWireDerivedFieldCollidingByNameOnTheSameTableIsRejected()
    {
        var limits = new RcdLimits();
        var other = OwnerField() with { Id = Guid.NewGuid() };
        var ex = Assert.Throws<QueryCompilationException>(
            () => MeasureOverlay.Merge(Model(OwnerField()), null, [other], limits));
        Assert.Equal("QRY_DUPLICATE_DERIVED_NAME", ex.Code);
    }

    [Fact]
    public void TheSameNameOnADifferentTableIsFine()
    {
        var limits = new RcdLimits();
        var other = OwnerField() with { Id = Guid.NewGuid(), Table = "public.customers" };
        var merged = MeasureOverlay.Merge(Model(OwnerField()), null, [other], limits);
        Assert.Equal(2, merged.DerivedFieldDefs.Count);
    }

    [Fact]
    public void TooManyWireDerivedFieldsAreRejected()
    {
        var limits = new RcdLimits { MaxQueryDerivedFieldDefinitions = 2 };
        var fields = Enumerable.Range(0, 3)
            .Select(i => new DerivedField(Guid.NewGuid(), $"f{i}", "public.reviews", OwnerExpression))
            .ToArray();
        var ex = Assert.Throws<QueryCompilationException>(
            () => MeasureOverlay.Merge(Model(), null, fields, limits));
        Assert.Equal("QRY_TOO_MANY_DERIVED_FIELDS", ex.Code);
    }

    [Fact]
    public void OversizeWireDerivedFieldsAreRejected()
    {
        var limits = new RcdLimits { MaxQueryDerivedFieldBytes = 32 };
        var ex = Assert.Throws<QueryCompilationException>(
            () => MeasureOverlay.Merge(Model(), null, [OwnerField()], limits));
        Assert.Equal("QRY_DERIVED_FIELDS_TOO_LARGE", ex.Code);
    }

    [Fact]
    public void AWireDerivedFieldWithoutAnIdIsRejected()
    {
        var limits = new RcdLimits();
        var ex = Assert.Throws<QueryCompilationException>(
            () => MeasureOverlay.Merge(Model(), null, [OwnerField() with { Id = Guid.Empty }], limits));
        Assert.Equal("QRY_BAD_DERIVED", ex.Code);
    }

    [Fact]
    public void ANonTextDerivedDataTypeIsRejected()
    {
        var ex = CompileError(
            Spec([new DimensionSpec("public.reviews", "EDMS Uploaded?", null)]),
            Model(OwnerField() with { DataType = "integer" }));
        Assert.Equal("QRY_BAD_DERIVED", ex.Code);
    }

    // ---------- the wire shape the frontend builds to ----------

    [Fact]
    public void TheWireBindsGroupingAndDerivedFieldsFromCamelCaseJson()
    {
        // Bound exactly as QueryController binds a request body. This is the
        // shared contract with the chart builder; drift here is a silently
        // ignored field, not a compile error.
        const string json = """
            {
              "modelId": 1,
              "dimensions": [
                { "table": "public.reviews", "column": "edms_uploaded",
                  "grouping": { "groups": [{ "label": "No", "matchBlank": true },
                                           { "label": "Keyword", "values": ["Yes"] }],
                                "otherLabel": "Dated" } }
              ],
              "measures": [{ "table": "public.reviews", "aggregation": "count" }],
              "filters": [], "sort": [], "topN": null, "limit": null,
              "derivedFields": [
                { "id": "11111111-2222-3333-4444-555555555555", "name": "EDMS Uploaded?",
                  "table": "public.reviews",
                  "expression": "IF(ISBLANK(public.reviews.edms_uploaded), 'No', 'Yes')",
                  "dataType": "text" }
              ]
            }
            """;

        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var spec = JsonSerializer.Deserialize<ChartQuerySpec>(json, options)!;

        var grouping = spec.Dimensions[0].Grouping!;
        Assert.Equal("Dated", grouping.OtherLabel);
        Assert.True(grouping.Groups[0].MatchBlank);
        Assert.Equal("Yes", grouping.Groups[1].MatchValues[0].GetString());

        var field = Assert.Single(spec.DerivedFields!);
        Assert.Equal(FieldId, field.Id);
        Assert.Equal(DerivedField.TextDataType, field.DataType);

        // And it compiles.
        Assert.Contains("CASE WHEN", Compile(spec).Sql, StringComparison.Ordinal);
    }

    // ---------- nothing else changed ----------

    [Fact]
    public void APlainDimensionEmitsExactlyWhatItAlwaysDid()
    {
        var withFields = Compile(
            Spec([new DimensionSpec("public.reviews", "region", null)]), Model(OwnerField()));
        var without = Compile(Spec([new DimensionSpec("public.reviews", "region", null)]));

        Assert.Equal(without.Sql, withFields.Sql);
        Assert.Contains("\"t0\".\"region\" AS \"dim0\"", without.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void AnUnderlyingExportStaysPhysicalColumnsOnly()
    {
        var limits = new RcdLimits();
        var spec = Spec();
        var effective = MeasureOverlay.Merge(Model(OwnerField()), null, null, limits);
        var prepared = Compiler.PrepareUnderlying(spec, effective, Schema(), limits);
        var compiled = Compiler.EmitUnderlying(prepared, NoRowFilters, 100);

        Assert.DoesNotContain("CASE", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain(compiled.Columns, c => c.Name == "EDMS Uploaded?");
        Assert.Equal(4, compiled.Columns.Count);
    }
    // ---------- Excel-style grouping RULES ----------

    private static GroupingRule RuleGrouping(
        GroupingMatchOperator op,
        object? value,
        GroupingRuleMode mode = GroupingRuleMode.Any,
        params (GroupingMatchOperator Op, object? Value)[] extra)
    {
        var rules = new List<GroupingMatchRule>
        {
            new(op, value is null ? null : Json(value)),
        };
        rules.AddRange(extra.Select(e => new GroupingMatchRule(e.Op, e.Value is null ? null : Json(e.Value))));
        return new GroupingRule(
            [new GroupingBucket("Westlake", Rules: rules, RuleMode: mode)],
            OtherLabel: "Other");
    }

    /// <summary>
    /// THE POINT OF RULES: a bucket that names values only ever holds the values
    /// that existed when the author picked them. A rule is evaluated in SQL, so
    /// a value that shows up tomorrow joins its group with no edit.
    /// </summary>
    [Fact]
    public void AContainsRuleCompilesToACaseInsensitiveLike()
    {
        var compiled = Compile(Spec([
            new DimensionSpec("public.reviews", "region", null,
                RuleGrouping(GroupingMatchOperator.Contains, "west")),
        ]));

        Assert.Contains("ILIKE", compiled.Sql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(compiled.Parameters, p => Equals(p.Value, "%west%"));
    }

    [Fact]
    public void RuleOperandsAreBoundAndNeverEmitted()
    {
        const string hostile = "%' OR 1=1 --";
        var compiled = Compile(Spec([
            new DimensionSpec("public.reviews", "region", null,
                RuleGrouping(GroupingMatchOperator.Contains, hostile)),
        ]));

        Assert.DoesNotContain("OR 1=1", compiled.Sql, StringComparison.Ordinal);
        // A LIKE predicate carries the dialect's own ESCAPE clause, which is a
        // fixed constant and the ONE quoted literal the renderer emits. Strip
        // it, then hold the same line as everywhere else: no author text.
        // Every quote character in the statement must belong to one of those
        // ESCAPE clauses — two apiece. Anything else would be emitted text.
        var escapeClauses = compiled.Sql.Split("ESCAPE ").Length - 1;
        Assert.True(escapeClauses > 0, "a LIKE predicate should carry an ESCAPE clause");
        Assert.Equal(escapeClauses * 2, compiled.Sql.Count(c => c == '\''));
        // And the LIKE metacharacter the author typed is ESCAPED, so it matches
        // literally instead of silently becoming a wildcard.
        Assert.Contains(compiled.Parameters, p => p.Value is string s && s.Contains(@"\%", StringComparison.Ordinal));
    }

    [Fact]
    public void EveryOperatorCompiles()
    {
        foreach (var op in Enum.GetValues<GroupingMatchOperator>())
        {
            var needsValue = op is not (GroupingMatchOperator.IsBlank or GroupingMatchOperator.NotBlank);
            var compiled = Compile(Spec([
                new DimensionSpec("public.reviews", "region", null,
                    RuleGrouping(op, needsValue ? "West" : null)),
            ]));
            Assert.Contains("CASE", compiled.Sql, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void AllModeAndsTheRulesAndParenthesisesThem()
    {
        var compiled = Compile(Spec([
            new DimensionSpec("public.reviews", "region", null,
                RuleGrouping(
                    GroupingMatchOperator.StartsWith, "W",
                    GroupingRuleMode.All,
                    (GroupingMatchOperator.EndsWith, "t"))),
        ]));

        Assert.Contains(" AND ", compiled.Sql, StringComparison.Ordinal);
        Assert.Contains(compiled.Parameters, p => Equals(p.Value, "W%"));
        Assert.Contains(compiled.Parameters, p => Equals(p.Value, "%t"));
    }

    [Fact]
    public void ARuleWithoutItsValueIsRefusedWithTheOperatorNamed()
    {
        var error = Assert.Throws<QueryCompilationException>(() => Compile(Spec([
            new DimensionSpec("public.reviews", "region", null,
                RuleGrouping(GroupingMatchOperator.Contains, null)),
        ])));

        Assert.Equal("QRY_BAD_GROUPING", error.Code);
        Assert.Contains("Contains", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ABucketWithOnlyRulesIsValid()
    {
        // The old validation demanded values or the blank flag, which would
        // have rejected every rule-only bucket before it reached the emitter.
        var compiled = Compile(Spec([
            new DimensionSpec("public.reviews", "region", null,
                RuleGrouping(GroupingMatchOperator.NotBlank, null)),
        ]));
        Assert.Contains("CASE", compiled.Sql, StringComparison.Ordinal);
    }

}
