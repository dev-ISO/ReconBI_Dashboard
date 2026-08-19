namespace ReconDashboards.Core.Rendering;

/// <summary>
/// Paints a resolved <see cref="ChartLayout"/> to a PNG. The seam exists so
/// SnapshotComposer tests run against a fake — every content decision (which
/// tiles become images, cid wiring, table suppression) is provable without a
/// raster library in the loop.
/// </summary>
public interface IChartImageRenderer
{
    byte[] RenderPng(ChartLayout layout);
}
