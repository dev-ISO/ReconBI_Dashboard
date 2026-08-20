namespace ReconDashboards.Core.Rendering;

// The geometry a chart resolves to before any pixel exists: plain data records
// the painter draws in a fixed order (background → grid → areas → bars → arcs
// → lines → dots → axis lines → guides → swatches → texts) and the unit tests
// assert directly. Coordinates are logical pixels; the painter applies the 2×
// raster scale. Colors are #rrggbb strings.

public readonly record struct LayoutPoint(double X, double Y);

public enum TextAnchor
{
    Start,
    Middle,
    End,
}

/// <summary>Which corners of a rect are rounded — a bar rounds only its VALUE end.</summary>
public enum RectCorners
{
    None,
    All,
    Top,
    Bottom,
    Left,
    Right,
}

/// <summary>
/// Dash patterns for guide/series strokes, in the frontend's units
/// (ChartRenderer strokeDash / guideDash). Null = solid.
/// </summary>
public static class LayoutDash
{
    /// <summary>format.lineStyles 'dashed' (strokeDasharray "8 5").</summary>
    public static readonly IReadOnlyList<double> SeriesDashed = [8, 5];

    /// <summary>format.lineStyles 'dotted' (strokeDasharray "2 4").</summary>
    public static readonly IReadOnlyList<double> SeriesDotted = [2, 4];

    /// <summary>Reference-line / trendline default (strokeDasharray "6 4").</summary>
    public static readonly IReadOnlyList<double> GuideDashed = [6, 4];

    /// <summary>Reference-line / trendline 'dotted' (strokeDasharray "2 3").</summary>
    public static readonly IReadOnlyList<double> GuideDotted = [2, 3];

    /// <summary>Series stroke preset; an unset style is solid.</summary>
    public static IReadOnlyList<double>? Series(string? dash) => dash switch
    {
        "dashed" => SeriesDashed,
        "dotted" => SeriesDotted,
        _ => null,
    };

    /// <summary>Guide stroke preset; UNSET reads as dashed — the conventional guide look.</summary>
    public static IReadOnlyList<double>? Guide(string? dash) => dash switch
    {
        "solid" => null,
        "dotted" => GuideDotted,
        _ => GuideDashed,
    };
}

public sealed record LayoutRect(
    double X, double Y, double Width, double Height, string Fill, double Opacity = 1,
    double CornerRadius = 0, RectCorners Corners = RectCorners.None,
    string? Stroke = null, double StrokeWidth = 0);

public sealed record LayoutLine(
    double X1, double Y1, double X2, double Y2, string Stroke, double StrokeWidth = 1,
    IReadOnlyList<double>? Dash = null);

/// <summary>
/// A stroked path through <paramref name="Points"/>. <paramref name="Curve"/>
/// asks the painter for the monotone cubic the browser draws (recharts
/// type="monotone"); the points themselves stay the plotted data, so the layout
/// record keeps saying exactly where each value sits.
/// </summary>
public sealed record LayoutPolyline(
    IReadOnlyList<LayoutPoint> Points, string Stroke, double StrokeWidth = 2,
    IReadOnlyList<double>? Dash = null, bool Curve = false);

/// <summary>
/// A filled path. <paramref name="CurvePoints"/> is the count of LEADING points
/// that form the smoothed data curve (0 = a plain polygon); the remainder — the
/// baseline corners of an area — always joins with straight segments.
/// </summary>
public sealed record LayoutPolygon(
    IReadOnlyList<LayoutPoint> Points, string Fill, double Opacity = 1, int CurvePoints = 0);

/// <summary>
/// Pie/donut slice: angles in degrees, 0° at 12 o'clock, sweeping clockwise.
/// <paramref name="SweepDegrees"/> is the slice's TRUE share; the painter takes
/// <paramref name="PadDegrees"/> out of it to open the gap between slices
/// (recharts paddingAngle), so the geometry record stays honest about the data.
/// </summary>
public sealed record LayoutArc(
    double CenterX, double CenterY, double OuterRadius, double InnerRadius,
    double StartDegrees, double SweepDegrees, string Fill,
    double PadDegrees = 0, string? Stroke = null, double StrokeWidth = 0);

public sealed record LayoutCircle(
    double CenterX, double CenterY, double Radius, string Fill, double Opacity = 1);

/// <summary>Rotation pivots on (X, Y); the anchor applies along the rotated baseline.</summary>
public sealed record LayoutText(
    double X, double Y, string Text, double FontSize, string Color,
    TextAnchor Anchor = TextAnchor.Start, double RotationDegrees = 0, bool Bold = false);

/// <summary>
/// The whole picture as data. <c>Guides</c> carries reference lines and the
/// gantt today marker — strokes drawn OVER the marks but under the text.
/// </summary>
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
    IReadOnlyList<LayoutText> Texts,
    IReadOnlyList<LayoutLine> Guides);
