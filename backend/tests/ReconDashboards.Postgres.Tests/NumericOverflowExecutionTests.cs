using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Querying.Compilation;

namespace ReconDashboards.Postgres.Tests;

/// <summary>
/// Numeric-overflow hardening. A Postgres <c>numeric</c> carries far more range
/// than System.Decimal, and the reader's default materialization throws
/// OverflowException on such a value — which used to fail the WHOLE query, so
/// one unlucky aggregate (an unbounded division measure being the usual source)
/// turned into a dead chart. These run the real Npgsql path deliberately: a
/// stubbed DbDataReader would only re-assert the assumption under test.
/// </summary>
[Collection("postgres")]
public sealed class NumericOverflowExecutionTests(PostgresContainerFixture fixture)
{
    /// <summary>Raw SQL straight to the executor; Columns/Warnings are unused by it.</summary>
    private static CompiledQuery Raw(string sql) => new(sql, [], [], []);

    private Task<ExecutedQuery> ExecuteAsync(string sql) =>
        new PostgresQueryExecutor(fixture.DataSource)
            .ExecuteAsync(Raw(sql), new ExecutionOptions(1000, TimeoutSeconds: 30), CancellationToken.None);

    [Fact]
    public async Task Numeric_wider_than_decimal_comes_back_as_a_double()
    {
        var result = await ExecuteAsync("SELECT 1e40::numeric AS wide");

        var value = Assert.Single(result.Rows)[0];
        Assert.Equal(1e40, Assert.IsType<double>(value), precision: 10);
    }

    [Fact]
    public async Task An_overflowing_cell_never_costs_the_rest_of_its_row()
    {
        var result = await ExecuteAsync("SELECT 7::int AS ok, 1e40::numeric AS wide, 'label'::text AS name");

        var row = Assert.Single(result.Rows);
        Assert.Equal(7, row[0]);
        Assert.IsType<double>(row[1]);
        Assert.Equal("label", row[2]);
    }

    [Fact]
    public async Task An_overflowing_cell_never_costs_the_other_rows()
    {
        var result = await ExecuteAsync(
            "SELECT 1::numeric AS v UNION ALL SELECT 1e40::numeric UNION ALL SELECT 2::numeric");

        Assert.Equal(3, result.Rows.Count);
        Assert.Contains(result.Rows, r => r[0] is decimal d && d == 1m);
        Assert.Contains(result.Rows, r => r[0] is double);
        Assert.Contains(result.Rows, r => r[0] is decimal d && d == 2m);
    }

    [Fact]
    public async Task Values_decimal_can_hold_are_still_decimals()
    {
        var result = await ExecuteAsync("SELECT 123.456::numeric AS v");

        Assert.Equal(123.456m, Assert.IsType<decimal>(Assert.Single(result.Rows)[0]));
    }

    [Fact]
    public async Task Nulls_stay_null()
    {
        var result = await ExecuteAsync("SELECT NULL::numeric AS v");

        Assert.Null(Assert.Single(result.Rows)[0]);
    }

    /// <summary>
    /// NaN is a legal Postgres numeric that no decimal can hold, and JSON has no
    /// way to express it either — so it degrades to null instead of failing the
    /// query or emitting a token the client cannot parse.
    /// </summary>
    [Fact]
    public async Task Numeric_nan_degrades_to_null_rather_than_failing()
    {
        var result = await ExecuteAsync("SELECT 'NaN'::numeric AS v");

        Assert.Null(Assert.Single(result.Rows)[0]);
    }
}
