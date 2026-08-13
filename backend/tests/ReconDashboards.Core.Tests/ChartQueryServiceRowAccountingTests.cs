using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Execution;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Row/flag accounting the query service applies to raw executor output: the
/// RowLimit + 1 probe ROW trim, and the Top-N-with-calcs "__rcd_truncated"
/// probe COLUMN (finding 5: the window base holds exactly n rows, so
/// truncation must ride a trailing constant column instead of an extra row).
/// </summary>
public class ChartQueryServiceRowAccountingTests
{
    private static CompiledQuery Compiled(int? rowLimit = null, bool probe = false) =>
        new("SELECT 1", [], [], [], RowLimit: rowLimit, HasTruncationProbe: probe);

    [Fact]
    public void RowLimitProbeRow_IsTrimmedAndReportsTruncation()
    {
        var rows = new object?[][] { ["a", 1], ["b", 2], ["c", 3] };

        var (kept, truncated) = ChartQueryService.ApplyRowAccounting(Compiled(rowLimit: 2), rows, truncated: false);

        Assert.Equal(2, kept.Count);
        Assert.True(truncated);
    }

    [Fact]
    public void RowsWithinRowLimit_PassThroughUntruncated()
    {
        var rows = new object?[][] { ["a", 1], ["b", 2] };

        var (kept, truncated) = ChartQueryService.ApplyRowAccounting(Compiled(rowLimit: 2), rows, truncated: false);

        Assert.Equal(2, kept.Count);
        Assert.False(truncated);
    }

    [Fact]
    public void TruncationProbeColumn_TrueSideOfTheEdge_StripsCellAndRaisesFlag()
    {
        var rows = new object?[][] { ["a", 1, true], ["b", 2, true] };

        var (kept, truncated) = ChartQueryService.ApplyRowAccounting(
            Compiled(rowLimit: 5000, probe: true), rows, truncated: false);

        Assert.True(truncated);
        Assert.All(kept, r => Assert.Equal(2, r.Length));
        Assert.Equal(new object?[] { "a", 1 }, kept[0]);
        Assert.Equal(new object?[] { "b", 2 }, kept[1]);
    }

    [Fact]
    public void TruncationProbeColumn_FalseSideOfTheEdge_StripsCellOnly()
    {
        var rows = new object?[][] { ["a", 1, false], ["b", 2, false] };

        var (kept, truncated) = ChartQueryService.ApplyRowAccounting(
            Compiled(rowLimit: 5000, probe: true), rows, truncated: false);

        Assert.False(truncated);
        Assert.All(kept, r => Assert.Equal(2, r.Length));
    }

    [Fact]
    public void TruncationProbeColumn_EmptyResult_StaysUntruncated()
    {
        var (kept, truncated) = ChartQueryService.ApplyRowAccounting(
            Compiled(rowLimit: 5000, probe: true), [], truncated: false);

        Assert.Empty(kept);
        Assert.False(truncated);
    }

    [Fact]
    public void ExecutorTruncation_IsNeverLost()
    {
        var rows = new object?[][] { ["a", 1, false] };

        var (_, truncated) = ChartQueryService.ApplyRowAccounting(
            Compiled(rowLimit: 5000, probe: true), rows, truncated: true);

        Assert.True(truncated);
    }
}
