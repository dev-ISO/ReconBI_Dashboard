using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

public class JoinPathResolverTests
{
    /// <summary>Deterministic relationship ids so ordering by id is under test control.</summary>
    private static Guid Id(int n) => Guid.Parse($"00000000-0000-0000-0000-{n:D12}");

    private static Relationship Rel(int id, string fromTable, string toTable, bool isActive = true) =>
        new(Id(id), fromTable, "fk", toTable, "id", Cardinality.ManyToOne, isActive);

    [Fact]
    public void ChainResolvesIntermediateStepsInOrderWithSequentialAliases()
    {
        // a - b - c; only c is required from base a.
        var rels = new[] { Rel(1, "b", "a"), Rel(2, "c", "b") };

        var plan = JoinPathResolver.Resolve("a", ["c"], rels, maxJoins: 8);

        Assert.Equal("a", plan.BaseTable);
        Assert.Equal(2, plan.Steps.Count);
        Assert.Equal("b", plan.Steps[0].TableKey);
        Assert.Equal("a", plan.Steps[0].ParentTableKey);
        Assert.Equal("c", plan.Steps[1].TableKey);
        Assert.Equal("b", plan.Steps[1].ParentTableKey);
        Assert.Equal("t0", plan.AliasByTable["a"]);
        Assert.Equal("t1", plan.AliasByTable["b"]);
        Assert.Equal("t2", plan.AliasByTable["c"]);
    }

    [Fact]
    public void StarSchemaJoinsEveryDimensionDirectlyOntoTheFact()
    {
        var rels = new[] { Rel(1, "fact", "dim1"), Rel(2, "fact", "dim2"), Rel(3, "fact", "dim3") };

        var plan = JoinPathResolver.Resolve("fact", ["dim1", "dim2", "dim3"], rels, maxJoins: 8);

        Assert.Equal(3, plan.Steps.Count);
        Assert.All(plan.Steps, s => Assert.Equal("fact", s.ParentTableKey));
        Assert.Equal(new[] { "dim1", "dim2", "dim3" }, plan.Steps.Select(s => s.TableKey).ToArray());
        Assert.Equal("t0", plan.AliasByTable["fact"]);
        Assert.Equal("t1", plan.AliasByTable["dim1"]);
        Assert.Equal("t2", plan.AliasByTable["dim2"]);
        Assert.Equal("t3", plan.AliasByTable["dim3"]);
    }

    [Fact]
    public void BridgeTableIsIncludedWhenOnlyEndpointsAreRequired()
    {
        // Path a - b - c: b is not required but is the only way to reach c.
        var rels = new[] { Rel(1, "b", "a"), Rel(2, "c", "b") };

        var plan = JoinPathResolver.Resolve("a", ["a", "c"], rels, maxJoins: 8);

        Assert.Contains("b", plan.Tables);
        Assert.Equal(new[] { "b", "c" }, plan.Steps.Select(s => s.TableKey).ToArray());
        Assert.Equal("t1", plan.AliasByTable["b"]);
        Assert.Equal("t2", plan.AliasByTable["c"]);
    }

    [Fact]
    public void DisconnectedTableThrowsQryDisconnected()
    {
        var rels = new[] { Rel(1, "b", "a") };

        var ex = Assert.Throws<QueryCompilationException>(
            () => JoinPathResolver.Resolve("a", ["z"], rels, maxJoins: 8));

        Assert.Equal("QRY_DISCONNECTED", ex.Code);
    }

    [Fact]
    public void DiamondWithEqualLengthPathsThrowsQryAmbiguousPath()
    {
        // a - b - d and a - c - d: two shortest paths of equal length to d.
        var rels = new[] { Rel(1, "b", "a"), Rel(2, "c", "a"), Rel(3, "d", "b"), Rel(4, "d", "c") };

        var ex = Assert.Throws<QueryCompilationException>(
            () => JoinPathResolver.Resolve("a", ["d"], rels, maxJoins: 8));

        Assert.Equal("QRY_AMBIGUOUS_PATH", ex.Code);
    }

    [Fact]
    public void PathOnlyViaInactiveRelationshipIsDisconnected()
    {
        // The engine feeds only IsActive relationships to the resolver
        // (QueryCompiler.Prepare filters), so an inactive-only path is a
        // disconnection. Exercised through Prepare to cover that contract.
        var model = TestFixtures.BuildModel(
            tables:
            [
                TestFixtures.BuildModelTable("public", "customers"),
                TestFixtures.BuildModelTable("public", "orders"),
            ],
            relationships:
            [
                TestFixtures.BuildRelationship("public.orders", "customer_id", "public.customers", "id", isActive: false),
            ]);
        var spec = new ChartQuerySpec(
            ModelId: 1,
            Dimensions: [new DimensionSpec("public.customers", "region", null)],
            Measures: [new MeasureSpec(null, "public.orders", "order_total", Aggregation.Sum, null)],
            Filters: [],
            Sort: [],
            TopN: null,
            Limit: null);
        var compiler = new QueryCompiler(new PostgresSqlDialect());

        var ex = Assert.Throws<QueryCompilationException>(
            () => compiler.Prepare(spec, model, TestFixtures.BuildDemoSchema(), new RcdLimits()));

        Assert.Equal("QRY_DISCONNECTED", ex.Code);
    }

    [Fact]
    public void ExceedingMaxJoinsThrowsQryTooManyJoins()
    {
        var rels = new[] { Rel(1, "b", "a"), Rel(2, "c", "b") };

        var ex = Assert.Throws<QueryCompilationException>(
            () => JoinPathResolver.Resolve("a", ["c"], rels, maxJoins: 1));

        Assert.Equal("QRY_TOO_MANY_JOINS", ex.Code);
    }

    [Fact]
    public void ParallelRelationshipsResolveViaLowestRelationshipIdEveryTime()
    {
        // Two equal-length alternatives (parallel edges a-b). Same parent, so
        // not ambiguous; the winner must be the lower relationship id no matter
        // how the input list is ordered.
        var preferred = Rel(1, "b", "a");
        var other = Rel(2, "b", "a");

        for (var run = 0; run < 10; run++)
        {
            var rels = run % 2 == 0
                ? new[] { other, preferred }
                : new[] { preferred, other };

            var plan = JoinPathResolver.Resolve("a", ["b"], rels, maxJoins: 8);

            var step = Assert.Single(plan.Steps);
            Assert.Equal(preferred.Id, step.Via.Id);
        }
    }
}
