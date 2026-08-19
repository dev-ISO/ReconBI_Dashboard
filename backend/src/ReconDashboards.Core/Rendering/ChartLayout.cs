namespace ReconDashboards.Core.Rendering;

// The geometry a chart resolves to before any pixel exists: plain data records
// the painter draws in a fixed order (background → grid → areas → bars → arcs
// → lines → dots → axis lines → swatches → texts) and the unit tests assert
// directly. Coordinates are logical pixels; the painter applies the 2× raster
// scale. Colors are #rrggbb strings.

public readonly record struct LayoutPoint(double X, double Y);

public enum TextAnchor
{
    Start,
    Middle,
    End,
}

public sealed record LayoutRect(
    double X, double Y, double Width, double Height, string Fill, double Opacity = 1);

public sealed record LayoutLine(
    double X1, double Y1, double X2, double Y2, string Stroke, double StrokeWidth = 1);

public sealed record LayoutPolyline(
    IReadOnlyList<LayoutPoint> Points, string Stroke, double StrokeWidth = 2);

public sealed record LayoutPolygon(
    IReadOnlyList<LayoutPoint> Points, string Fill, double Opacity = 1);

/// <summary>Pie/donut slice: angles in degrees, 0° at 12 o'clock, sweeping clockwise.</summary>
public sealed record LayoutArc(
    double CenterX, double CenterY, double OuterRadius, double InnerRadius,
    double StartDegrees, double SweepDegrees, string Fill);

public sealed record LayoutCircle(
    double CenterX, double CenterY, double Radius, string Fill, double Opacity = 1);

/// <summary>Rotation pivots on (X, Y); the anchor applies along the rotated baseline.</summary>
public sealed record LayoutText(
    double X, double Y, string Text, double FontSize, string Color,
    TextAnchor Anchor = TextAnchor.Start, double RotationDegrees = 0, bool Bold = false);

public sealed record ChartLayout(
    int Width,
    int Height,
    string Background,
    IReadOnlyList<LayoutLine> GridLines,
    IReadOnlyList<LayoutLine> AxisLines,
    IReadOnlyList<LayoutRect> Bars,
    IReadOnlyList<LayoutPolygon> Areas,
    IReadOnlyList<LayoutPolyline> Lines,
    IReadOnlyList<LayoutArc> Arcs,
    IReadOnlyList<LayoutCircle> Dots,
    IReadOnlyList<LayoutRect> Swatches,
    IReadOnlyList<LayoutText> Texts);
