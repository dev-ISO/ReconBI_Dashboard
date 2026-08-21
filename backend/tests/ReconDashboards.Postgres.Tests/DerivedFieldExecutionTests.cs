using System.Text.Json;
using Npgsql;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Postgres.Tests;

/// <summary>
/// THE OWNER'S CASE, over real Postgres.
///
/// <c>public.reviews.edms_uploaded</c> holds either a keyword or a date per row,
/// plus blanks — the shape of five of their live columns. Grouped by the raw
/// column it yields SIX bars (Yes, three dates, '' and NULL). Both authoring
/// paths must yield exactly TWO: 4 non-blank as "Yes", 3 blank as "No".
///
/// Also pinned here: a predicate on a derived column filters by the LABEL, the
/// distinct-values endpoint lists labels, and — the security regression — the
/// derived dimension's table still receives its row filters.
/// </summary>
[Collection("postgres")]
public sealed class DerivedFieldExecutionTests(PostgresContainerFixture fixture)
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static readonly ExecutionOptions Options = new(MaxRows: 100, TimeoutSeconds: 30);

    private static readonly Guid FieldId = Guid.Parse("11111111-2222-3333-4444-555555555555");

    private const string FieldName = "EDMS Uploaded?";

    /// <summary>The owner's rule, spelled as a formula.</summary>
    private const string OwnerExpression = "IF(ISBLANK(public.reviews.edms_uploaded), \"No\", \"Yes\")";

    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);

    private static readonly RcdLimits Limits = new();

    private static DerivedField OwnerField() =>
        new(FieldId, FieldName, "public.reviews", OwnerExpression, DerivedField.TextDataType);

    /// <summary>The owner's rule, authored with no formula at all: blank -> "No", everything else -> "Yes".</summary>
    private static GroupingRule OwnerGrouping() =>
        new([new GroupingBucket("No", MatchBlank: true)], OtherLabel: "Yes");

    private static ModelDefinition Model(IReadOnlyList<DerivedField>? fields = null) => new(
        ModelDefinition.CurrentVersion,
        Tables: [new ModelTable("public", "reviews")],
        Relationships: [],
        Measures: [],
        DateTables: null,
        DerivedFields: fields);

    /// <summary>
    /// ONE executor for the whole class. Each call used to build a fresh
    /// NpgsqlDataSource, and a data source owns a POOL that is never disposed —
    /// so every test in this class left idle connections open for the rest of
    /// the run. Adding four tests pushed the total past the container's
    /// max_connections and broke the CONCURRENCY test in another class with
    /// "sorry, too many clients already": a failure with nothing to do with the
    /// test that reported it. Caching keeps this class to a single pool.
    /// </summary>
    private static IQueryExecutor? cachedExecutor;

    private IQueryExecutor Executor()
    {
        if (cachedExecutor is not null) return cachedExecutor;
        // Each call builds its OWN NpgsqlDataSource, so each brings its own
        // pool. Left at the default that is dozens of idle connections across
        // this class, and the container's max_connections is shared with the
        // concurrency tests — which then fail with "sorry, too many clients
        // already" for reasons that have nothing to do with them.
        var connectionString = new NpgsqlConnectionStringBuilder(fixture.DataSource.ConnectionString)
        {
            Password = "postgres",
            MaxPoolSize = 2,
        }.ConnectionString;

        var options = new ReconDashboardsOptions();
        options.AddPostgresDataSource("derived-demo", o =>
        {
            o.ConnectionString = connectionString;
            o.EnforceReadOnlySession = true;
        });
        var registry = new DataSourceRegistry(options, new NullServices());
        Assert.True(registry.TryGet("derived-demo", out var source));
        cachedExecutor = source.Executor!;
        return cachedExecutor;
    }

    private sealed class NullServices : IServiceProvider
    {
        public object? GetService(Type serviceType) => null;
    }

    private static ChartQuerySpec Spec(
        DimensionSpec dimension,
        IReadOnlyList<FilterSpec>? filters = null,
        IReadOnlyList<DerivedField>? derivedFields = null) =>
        new(1,
            [dimension],
            [new MeasureSpec(null, "public.reviews", null, Aggregation.Count, null)],
            filters ?? [],
            [new SortSpec(new SortTarget(SortTargetKind.Dimension, 0), SortDirection.Asc)],
            null, null, DerivedFields: derivedFields);

    private CompiledQuery Compile(
        ChartQuerySpec spec,
        ModelDefinition? model = null,
        IReadOnlyDictionary<string, IReadOnlyList<RowFilter>>? rowFilters = null)
    {
        var effective = MeasureOverlay.Merge(model ?? Model(), spec.Definitions, spec.DerivedFields, Limits);
        var prepared = Compiler.Prepare(spec, effective, fixture.RawSchema, Limits);
        return Compiler.Emit(prepared, spec, rowFilters ?? NoRowFilters, Limits, new DataSourceOptions());
    }

    private async Task<(string? Label, long Count)[]> RunAsync(CompiledQuery compiled)
    {
        var result = await Executor().ExecuteAsync(compiled, Options, CancellationToken.None);
        return [.. result.Rows.Select(r => (r[0] as string, Convert.ToInt64(r[1])))];
    }

    // ---------- the baseline the owner is complaining about ----------

    [Fact]
    public async Task TheRawColumnProducesOneBarPerDistinctValue()
    {
        // "Right now I am forced to have yes, (Blank), 02/03/2026, ..." — five
        // distinct non-null values plus the NULL bucket.
        var rows = await RunAsync(Compile(Spec(new DimensionSpec("public.reviews", "edms_uploaded", null))));
        Assert.Equal(6, rows.Length);
    }

    // ---------- path 1: the value grouping (no formula) ----------

    [Fact]
    public async Task TheGroupingRuleProducesExactlyTwoBars()
    {
        var rows = await RunAsync(
            Compile(Spec(new DimensionSpec("public.reviews", "edms_uploaded", null, OwnerGrouping()))));

        Assert.Equal([("No", 3L), ("Yes", 4L)], rows);
    }

    [Fact]
    public async Task GroupingCanNameTheBlankBucketAnythingAndListValuesExplicitly()
    {
        var grouping = new GroupingRule(
            [
                new GroupingBucket("Not uploaded", MatchBlank: true),
                new GroupingBucket("Keyword", [Json("Yes")]),
            ],
            OtherLabel: "Dated");

        var rows = await RunAsync(
            Compile(Spec(new DimensionSpec("public.reviews", "edms_uploaded", null, grouping))));

        Assert.Equal([("Dated", 3L), ("Keyword", 1L), ("Not uploaded", 3L)], rows);
    }

    // ---------- path 2: the derived field (reusable, named) ----------

    [Fact]
    public async Task TheDerivedFieldProducesExactlyTwoBars()
    {
        var rows = await RunAsync(
            Compile(Spec(new DimensionSpec("public.reviews", FieldName, null)), Model([OwnerField()])));

        Assert.Equal([("No", 3L), ("Yes", 4L)], rows);
    }

    [Fact]
    public async Task TheDerivedFieldOnTheQueryWireProducesTheSameTwoBars()
    {
        // Dashboard- and personal-scoped fields arrive this way; they must
        // behave identically to a model-held one.
        var rows = await RunAsync(
            Compile(Spec(new DimensionSpec("public.reviews", FieldName, null), derivedFields: [OwnerField()])));

        Assert.Equal([("No", 3L), ("Yes", 4L)], rows);
    }

    [Fact]
    public async Task TheIsNotNullFormAgreesWithTheIsBlankFormExceptOnTheEmptyString()
    {
        // The distinction is real in their data: one row holds '' rather than
        // NULL, so IS NOT NULL counts it as uploaded and ISBLANK does not.
        var field = OwnerField() with
        {
            Expression = "IF(public.reviews.edms_uploaded IS NOT NULL, \"Yes\", \"No\")",
        };
        var rows = await RunAsync(
            Compile(Spec(new DimensionSpec("public.reviews", FieldName, null)), Model([field])));

        Assert.Equal([("No", 2L), ("Yes", 5L)], rows);
    }

    [Fact]
    public async Task ADerivedFieldCanCombineColumnsOfItsOwnTable()
    {
        var field = OwnerField() with
        {
            Expression =
                "IF(NOT ISBLANK(public.reviews.edms_uploaded) AND public.reviews.region = \"West\", \"West uploaded\", \"Other\")",
        };
        var rows = await RunAsync(
            Compile(Spec(new DimensionSpec("public.reviews", FieldName, null)), Model([field])));

        Assert.Equal([("Other", 5L), ("West uploaded", 2L)], rows);
    }

    // ---------- G1: the literal never reaches the statement ----------

    [Fact]
    public async Task AHostileLabelIsBoundAndComesBackVerbatim()
    {
        // If it were emitted rather than bound, this statement would not run at
        // all — and if it were escaped by hand, the value would come back
        // mangled. Bound, it round-trips exactly.
        const string hostile = "'); DROP TABLE reviews; --";
        var field = OwnerField() with
        {
            Expression = $"IF(ISBLANK(public.reviews.edms_uploaded), \"{hostile}\", \"Yes\")",
        };

        var compiled = Compile(Spec(new DimensionSpec("public.reviews", FieldName, null)), Model([field]));
        Assert.DoesNotContain("DROP", compiled.Sql, StringComparison.OrdinalIgnoreCase);

        var rows = await RunAsync(compiled);
        Assert.Equal([(hostile, 3L), ("Yes", 4L)], rows);

        // And the table is still there.
        await using var command = fixture.DataSource.CreateCommand("SELECT count(*) FROM reviews");
        Assert.Equal(7L, Convert.ToInt64(await command.ExecuteScalarAsync()));
    }

    // ---------- G4: predicates, drill-down and distinct values ----------

    [Fact]
    public async Task DrillingIntoADerivedBarFiltersByItsLabel()
    {
        // Exactly the clause drill-down, cross-filter and see-records send:
        // eq on the dimension's column with the clicked axis value.
        var rows = await RunAsync(Compile(
            Spec(
                new DimensionSpec("public.reviews", "region", null),
                [new FilterSpec("public.reviews", FieldName, FilterOperator.Eq, [Json("Yes")])]),
            Model([OwnerField()])));

        Assert.Equal([("East", 2L), ("West", 2L)], rows);
    }

    [Fact]
    public async Task AnIsNullDrillClauseOnADerivedColumnRunsAndMatchesNothing()
    {
        // The blank bar's label is "No", never NULL — the CASE always returns a
        // label — so the isNull form is empty rather than broken.
        var rows = await RunAsync(Compile(
            Spec(
                new DimensionSpec("public.reviews", "region", null),
                [new FilterSpec("public.reviews", FieldName, FilterOperator.IsNull, [])]),
            Model([OwnerField()])));

        Assert.Empty(rows);
    }

    [Fact]
    public async Task DistinctValuesOfADerivedColumnAreItsLabels()
    {
        var spec = new DistinctValuesSpec(
            1, "public.reviews", FieldName, null, [], null, DerivedFields: [OwnerField()]);
        var effective = MeasureOverlay.Merge(Model(), definitions: null, spec.DerivedFields, Limits);
        var prepared = Compiler.PrepareDistinct(spec, effective, fixture.RawSchema, Limits);
        var compiled = Compiler.EmitDistinct(prepared, NoRowFilters);

        var result = await Executor().ExecuteAsync(compiled, Options, CancellationToken.None);
        Assert.Equal(["No", "Yes"], result.Rows.Select(r => r[0] as string).ToArray());
    }

    [Fact]
    public async Task DistinctValuesSearchNarrowsADerivedColumn()
    {
        var spec = new DistinctValuesSpec(
            1, "public.reviews", FieldName, "ye", [], null, DerivedFields: [OwnerField()]);
        var effective = MeasureOverlay.Merge(Model(), definitions: null, spec.DerivedFields, Limits);
        var prepared = Compiler.PrepareDistinct(spec, effective, fixture.RawSchema, Limits);

        var result = await Executor().ExecuteAsync(
            Compiler.EmitDistinct(prepared, NoRowFilters), Options, CancellationToken.None);
        Assert.Equal(["Yes"], result.Rows.Select(r => r[0] as string).ToArray());
    }

    // ---------- THE SECURITY REGRESSION ----------

    [Fact]
    public async Task ADerivedDimensionsTableStillReceivesItsRowFilters()
    {
        // A derived field is same-table by construction, so its table is in the
        // join plan because the DIMENSION named it — and therefore it is one of
        // the tables ChartQueryService collects row filters for. This test fails
        // loudly if a future refactor resolves derived columns anywhere other
        // than before the plan is built.
        var spec = Spec(new DimensionSpec("public.reviews", FieldName, null), derivedFields: [OwnerField()]);
        var effective = MeasureOverlay.Merge(Model(), spec.Definitions, spec.DerivedFields, Limits);
        var prepared = Compiler.Prepare(spec, effective, fixture.RawSchema, Limits);

        Assert.Contains("public.reviews", prepared.Plan.Tables);

        var rowFilters = new Dictionary<string, IReadOnlyList<RowFilter>>
        {
            ["public.reviews"] = [new RowFilter("region", RowFilterOperator.Equals, ["West"])],
        };

        var filtered = await RunAsync(
            Compiler.Emit(prepared, spec, rowFilters, Limits, new DataSourceOptions()));
        var unfiltered = await RunAsync(
            Compiler.Emit(prepared, spec, NoRowFilters, Limits, new DataSourceOptions()));

        // West holds 3 rows: 'Yes', a date, and a NULL.
        Assert.Equal([("No", 1L), ("Yes", 2L)], filtered);
        Assert.Equal([("No", 3L), ("Yes", 4L)], unfiltered);
    }

    [Fact]
    public async Task AGroupedDimensionsTableStillReceivesItsRowFilters()
    {
        var spec = Spec(new DimensionSpec("public.reviews", "edms_uploaded", null, OwnerGrouping()));
        var prepared = Compiler.Prepare(spec, Model(), fixture.RawSchema, Limits);

        var rowFilters = new Dictionary<string, IReadOnlyList<RowFilter>>
        {
            ["public.reviews"] = [new RowFilter("region", RowFilterOperator.Equals, ["West"])],
        };

        var filtered = await RunAsync(
            Compiler.Emit(prepared, spec, rowFilters, Limits, new DataSourceOptions()));
        Assert.Equal([("No", 1L), ("Yes", 2L)], filtered);
    }

    // ---------- G5: the result plan ----------

    [Fact]
    public void ADerivedDimensionReportsTextAndItsSyntheticSource()
    {
        var compiled = Compile(
            Spec(new DimensionSpec("public.reviews", FieldName, null)), Model([OwnerField()]));

        Assert.Equal(NormalizedType.Text, compiled.Columns[0].Type);
        Assert.Equal($"#derived.{FieldId}", compiled.Columns[0].Source);
    }
    // ---------- the bar and the drill must agree ----------

    /// <summary>Total rows surviving a filter, summed over an ungrouped split.</summary>
    private async Task<long> TotalAsync(FilterSpec filter)
    {
        var rows = await RunAsync(
            Compile(Spec(new DimensionSpec("public.reviews", "region", null), [filter])));
        return rows.Sum(r => r.Count);
    }

    private static FilterSpec On(FilterOperator op) =>
        new("public.reviews", "edms_uploaded", op, []);

    /// <summary>
    /// THE REGRESSION THIS PAIR OF OPERATORS EXISTS FOR.
    ///
    /// A grouping folds NULL *and* the empty string into the blank bucket, so
    /// the "No" bar counts 3. Clicking it must return those same 3 rows. With
    /// IsNull it returned 2 — the bar said one number and the drill showed
    /// another, which reads as lost data. FilterClause has no OR, so the union
    /// cannot be spelled as a clause list; it has to be one operator.
    /// </summary>
    [Fact]
    public async Task DrillingIntoABlankBarReturnsEveryRowThatBarCounted()
    {
        var bars = await RunAsync(
            Compile(Spec(new DimensionSpec("public.reviews", "edms_uploaded", null, OwnerGrouping()))));
        var no = bars.Single(b => b.Label == "No").Count;
        var yes = bars.Single(b => b.Label == "Yes").Count;

        Assert.Equal(no, await TotalAsync(On(FilterOperator.IsBlank)));
        Assert.Equal(yes, await TotalAsync(On(FilterOperator.NotBlank)));

        // And together they are the whole table: the two drills partition it,
        // with no row counted twice and none unreachable.
        Assert.Equal(7L, no + yes);
    }

    /// <summary>
    /// Pins WHY the null operators cannot stand in, so a future simplification
    /// that "collapses the duplicate pair" fails here instead of in a report.
    /// The empty-string row is the whole difference: IsNull misses it (the bar
    /// over-reports) and NotNull swallows it (the bar under-reports, showing an
    /// EDMS upload that never happened).
    /// </summary>
    [Fact]
    public async Task TheNullOperatorsAreOffByTheEmptyStringRowInBothDirections()
    {
        Assert.Equal(2L, await TotalAsync(On(FilterOperator.IsNull)));
        Assert.Equal(3L, await TotalAsync(On(FilterOperator.IsBlank)));

        Assert.Equal(5L, await TotalAsync(On(FilterOperator.NotNull)));
        Assert.Equal(4L, await TotalAsync(On(FilterOperator.NotBlank)));
    }

    /// <summary>A blank drill on a DERIVED column filters the expression, not the raw column.</summary>
    [Fact]
    public async Task ABlankFilterAlsoWorksThroughADerivedColumn()
    {
        var rows = await RunAsync(Compile(
            Spec(new DimensionSpec("public.reviews", "region", null),
                 [new FilterSpec("public.reviews", FieldName, FilterOperator.NotBlank, [])],
                 [OwnerField()])));

        // Every label the field produces is non-blank, so nothing is filtered out.
        Assert.Equal(7L, rows.Sum(r => r.Count));
    }

    // ---------- Excel-style grouping RULES, over real data ----------

    private static GroupingRule ContainsGrouping(string needle, string label) =>
        new([new GroupingBucket(label, Rules: [new GroupingMatchRule(GroupingMatchOperator.Contains, Json(needle))])],
            OtherLabel: "Other");

    [Fact]
    public async Task AContainsRuleMatchesEveryRowThePatternFits()
    {
        // 'st' ends both West and East — one pattern, two values, no list.
        var rows = await RunAsync(Compile(Spec(
            new DimensionSpec("public.reviews", "region", null, ContainsGrouping("st", "Has st")))));

        Assert.Equal([("Has st", 7L)], rows);
    }

    [Fact]
    public async Task TextRulesAreCaseInsensitiveLikeASpreadsheet()
    {
        var rows = await RunAsync(Compile(Spec(
            new DimensionSpec("public.reviews", "region", null, ContainsGrouping("WEST", "West-ish")))));

        Assert.Contains(rows, r => r.Label == "West-ish" && r.Count == 3);
    }

    /// <summary>
    /// THE WHOLE REASON RULES EXIST: a value that did not exist when the author
    /// wrote the rule still lands in the right group, with no edit to the chart.
    /// A bucket built from listed values cannot do this — it would need the new
    /// value adding by hand.
    /// </summary>
    [Fact]
    public async Task AValueThatArrivesLATERJoinsTheGroupOnItsOwn()
    {
        var listed = new GroupingRule(
            [new GroupingBucket("Westish", Values: [Json("West")])], OtherLabel: "Other");
        var ruled = ContainsGrouping("West", "Westish");

        var before = await RunAsync(Compile(Spec(
            new DimensionSpec("public.reviews", "region", null, ruled))));
        Assert.Contains(before, r => r.Label == "Westish" && r.Count == 3);

        await using var insert = fixture.DataSource.CreateCommand(
            "INSERT INTO reviews (region, edms_uploaded) VALUES ('Westlake', 'Yes')");
        await insert.ExecuteNonQueryAsync();
        try
        {
            var byRule = await RunAsync(Compile(Spec(
                new DimensionSpec("public.reviews", "region", null, ruled))));
            // The rule picked the new row up without being touched.
            Assert.Contains(byRule, r => r.Label == "Westish" && r.Count == 4);

            var byList = await RunAsync(Compile(Spec(
                new DimensionSpec("public.reviews", "region", null, listed))));
            // The listed bucket did not — it still knows only the old value.
            Assert.Contains(byList, r => r.Label == "Westish" && r.Count == 3);
        }
        finally
        {
            await using var cleanup = fixture.DataSource.CreateCommand(
                "DELETE FROM reviews WHERE region = 'Westlake'");
            await cleanup.ExecuteNonQueryAsync();
        }
    }

    [Fact]
    public async Task ALikeMetacharacterInTheAuthorsTextMatchesLITERALLY()
    {
        // '%' is a wildcard in LIKE. Escaped, it matches a literal per-cent
        // sign — so this rule finds nothing rather than everything.
        var rows = await RunAsync(Compile(Spec(
            new DimensionSpec("public.reviews", "region", null, ContainsGrouping("%", "Percent")))));

        Assert.DoesNotContain(rows, r => r.Label == "Percent");
    }

}
