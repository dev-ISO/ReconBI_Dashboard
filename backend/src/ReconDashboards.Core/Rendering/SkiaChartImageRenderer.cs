using SkiaSharp;

namespace ReconDashboards.Core.Rendering;

/// <summary>
/// Thin SkiaSharp painter over <see cref="ChartLayoutEngine"/> geometry —
/// rasterizes at 2× so the email image stays crisp on high-DPI screens
/// (EMAIL-CONTENT-DESIGN). It draws the layout primitives verbatim and never
/// re-measures text.
///
/// Fonts load by FILE PATH with SKTypeface.Default as the last resort — no
/// fontconfig: the tracker's Linux container installs fonts-liberation, dev
/// boxes fall through to Arial or the Skia default, and a machine with none
/// of the candidates still renders (metrics shift slightly; nothing throws).
/// </summary>
public sealed class SkiaChartImageRenderer : IChartImageRenderer
{
    public const float Scale = 2f;

    private static readonly string[] RegularFontCandidates =
    [
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        @"C:\Windows\Fonts\arial.ttf",
    ];

    private static readonly string[] BoldFontCandidates =
    [
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        @"C:\Windows\Fonts\arialbd.ttf",
    ];

    private static readonly Lazy<SKTypeface> RegularTypeface = new(() => LoadTypeface(RegularFontCandidates));
    private static readonly Lazy<SKTypeface> BoldTypeface = new(() => LoadTypeface(BoldFontCandidates));

    private static SKTypeface LoadTypeface(string[] candidates)
    {
        foreach (var path in candidates)
        {
            try
            {
                if (File.Exists(path) && SKTypeface.FromFile(path) is { } typeface)
                {
                    return typeface;
                }
            }
            catch (Exception)
            {
                // A corrupt font file must never take chart rendering down.
            }
        }

        return SKTypeface.Default;
    }

    public byte[] RenderPng(ChartLayout layout)
    {
        var info = new SKImageInfo(
            (int)Math.Round(layout.Width * Scale), (int)Math.Round(layout.Height * Scale));
        using var surface = SKSurface.Create(info);
        var canvas = surface.Canvas;
        canvas.Scale(Scale);
        canvas.Clear(ParseColor(layout.Background));

        // Fixed paint order — the same order the layout contract documents.
        foreach (var line in layout.GridLines)
        {
            DrawLine(canvas, line);
        }

        foreach (var area in layout.Areas)
        {
            using var paint = FillPaint(area.Fill, area.Opacity);
            using var path = BuildPath(area.Points, area.CurvePoints);
            path.Close();
            canvas.DrawPath(path, paint);
        }

        foreach (var bar in layout.Bars)
        {
            DrawBar(canvas, bar);
        }

        foreach (var arc in layout.Arcs)
        {
            DrawArc(canvas, arc);
        }

        foreach (var polyline in layout.Lines)
        {
            using var dash = DashEffect(polyline.Dash);
            using var paint = new SKPaint
            {
                Color = ParseColor(polyline.Stroke),
                IsAntialias = true,
                Style = SKPaintStyle.Stroke,
                StrokeWidth = (float)polyline.StrokeWidth,
                StrokeJoin = SKStrokeJoin.Round,
                StrokeCap = SKStrokeCap.Round,
                PathEffect = dash,
            };
            using var path = BuildPath(polyline.Points, polyline.Curve ? polyline.Points.Count : 0);
            canvas.DrawPath(path, paint);
        }

        foreach (var dot in layout.Dots)
        {
            using var paint = FillPaint(dot.Fill, dot.Opacity);
            canvas.DrawCircle((float)dot.CenterX, (float)dot.CenterY, (float)dot.Radius, paint);
        }

        foreach (var line in layout.AxisLines)
        {
            DrawLine(canvas, line);
        }

        foreach (var guide in layout.Guides)
        {
            DrawLine(canvas, guide);
        }

        foreach (var swatch in layout.Swatches)
        {
            using var paint = FillPaint(swatch.Fill, swatch.Opacity);
            canvas.DrawRect((float)swatch.X, (float)swatch.Y, (float)swatch.Width, (float)swatch.Height, paint);
        }

        foreach (var text in layout.Texts)
        {
            DrawText(canvas, text);
        }

        canvas.Flush();
        using var image = surface.Snapshot();
        using var data = image.Encode(SKEncodedImageFormat.Png, quality: 100);
        return data.ToArray();
    }

    private static void DrawLine(SKCanvas canvas, LayoutLine line)
    {
        using var dash = DashEffect(line.Dash);
        using var paint = new SKPaint
        {
            Color = ParseColor(line.Stroke),
            IsAntialias = true,
            Style = SKPaintStyle.Stroke,
            StrokeWidth = (float)line.StrokeWidth,
            PathEffect = dash,
        };
        canvas.DrawLine((float)line.X1, (float)line.Y1, (float)line.X2, (float)line.Y2, paint);
    }

    private static void DrawBar(SKCanvas canvas, LayoutRect bar)
    {
        using var paint = FillPaint(bar.Fill, bar.Opacity);
        var rect = SKRect.Create((float)bar.X, (float)bar.Y, (float)bar.Width, (float)bar.Height);
        if (bar.CornerRadius > 0 && bar.Corners != RectCorners.None)
        {
            // Radii larger than half the short side pinch the rect into a lens.
            var r = (float)Math.Min(bar.CornerRadius, Math.Min(bar.Width, bar.Height) / 2);
            var zero = new SKPoint(0, 0);
            var round = new SKPoint(r, r);
            var (topLeft, topRight, bottomRight, bottomLeft) = bar.Corners switch
            {
                RectCorners.All => (round, round, round, round),
                RectCorners.Top => (round, round, zero, zero),
                RectCorners.Bottom => (zero, zero, round, round),
                RectCorners.Left => (round, zero, zero, round),
                _ => (zero, round, round, zero), // Right
            };
            using var rounded = new SKRoundRect();
            rounded.SetRectRadii(rect, [topLeft, topRight, bottomRight, bottomLeft]);
            canvas.DrawRoundRect(rounded, paint);
            if (bar.Stroke is not null && bar.StrokeWidth > 0)
            {
                using var stroke = StrokePaint(bar.Stroke, bar.StrokeWidth);
                canvas.DrawRoundRect(rounded, stroke);
            }

            return;
        }

        canvas.DrawRect(rect, paint);
        if (bar.Stroke is not null && bar.StrokeWidth > 0)
        {
            using var stroke = StrokePaint(bar.Stroke, bar.StrokeWidth);
            canvas.DrawRect(rect, stroke);
        }
    }

    private static void DrawArc(SKCanvas canvas, LayoutArc arc)
    {
        // Layout angles: 0° at 12 o'clock, clockwise. Skia arc angles: 0° at
        // 3 o'clock, clockwise — shift by -90°. The pad is taken out of the
        // slice symmetrically, which is what recharts' paddingAngle looks like.
        var pad = Math.Min(arc.PadDegrees, Math.Max(0, arc.SweepDegrees - 0.5));
        var start = (float)(arc.StartDegrees - 90 + (pad / 2));
        var sweep = (float)(arc.SweepDegrees - pad);
        if (sweep <= 0)
        {
            return;
        }

        var cx = (float)arc.CenterX;
        var cy = (float)arc.CenterY;
        var outer = SKRect.Create(
            cx - (float)arc.OuterRadius, cy - (float)arc.OuterRadius,
            (float)arc.OuterRadius * 2, (float)arc.OuterRadius * 2);

        using var paint = FillPaint(arc.Fill, 1);
        using var path = new SKPath();
        if (arc.InnerRadius <= 0)
        {
            path.MoveTo(cx, cy);
            path.ArcTo(outer, start, sweep, forceMoveTo: false);
            path.Close();
        }
        else
        {
            var inner = SKRect.Create(
                cx - (float)arc.InnerRadius, cy - (float)arc.InnerRadius,
                (float)arc.InnerRadius * 2, (float)arc.InnerRadius * 2);
            path.ArcTo(outer, start, sweep, forceMoveTo: true);
            path.ArcTo(inner, start + sweep, -sweep, forceMoveTo: false);
            path.Close();
        }

        canvas.DrawPath(path, paint);
        if (arc.Stroke is not null && arc.StrokeWidth > 0)
        {
            using var stroke = StrokePaint(arc.Stroke, arc.StrokeWidth);
            canvas.DrawPath(path, stroke);
        }
    }

    /// <summary>
    /// A path through <paramref name="points"/> whose first
    /// <paramref name="curvePoints"/> members join with the MONOTONE cubic the
    /// browser draws (recharts type="monotone" = Fritsch–Carlson tangents, which
    /// never overshoot the data); the rest join with straight segments.
    /// </summary>
    private static SKPath BuildPath(IReadOnlyList<LayoutPoint> points, int curvePoints)
    {
        var path = new SKPath();
        if (points.Count == 0)
        {
            return path;
        }

        path.MoveTo((float)points[0].X, (float)points[0].Y);
        var smooth = Math.Min(curvePoints, points.Count);
        if (smooth >= 3)
        {
            var tangents = MonotoneTangents(points, smooth);
            for (var i = 1; i < smooth; i++)
            {
                var dx = points[i].X - points[i - 1].X;
                path.CubicTo(
                    (float)(points[i - 1].X + (dx / 3)), (float)(points[i - 1].Y + (tangents[i - 1] * dx / 3)),
                    (float)(points[i].X - (dx / 3)), (float)(points[i].Y - (tangents[i] * dx / 3)),
                    (float)points[i].X, (float)points[i].Y);
            }
        }
        else
        {
            smooth = 1;
        }

        for (var i = Math.Max(1, smooth); i < points.Count; i++)
        {
            path.LineTo((float)points[i].X, (float)points[i].Y);
        }

        return path;
    }

    /// <summary>Fritsch–Carlson slopes: shape-preserving, so a smoothed line never invents a peak.</summary>
    private static double[] MonotoneTangents(IReadOnlyList<LayoutPoint> points, int count)
    {
        var secants = new double[count - 1];
        for (var i = 0; i < count - 1; i++)
        {
            var dx = points[i + 1].X - points[i].X;
            secants[i] = Math.Abs(dx) < 1e-9 ? 0 : (points[i + 1].Y - points[i].Y) / dx;
        }

        var tangents = new double[count];
        tangents[0] = secants[0];
        tangents[count - 1] = secants[count - 2];
        for (var i = 1; i < count - 1; i++)
        {
            tangents[i] = secants[i - 1] * secants[i] <= 0
                ? 0 // a local extremum: flatten so the curve cannot overshoot
                : (secants[i - 1] + secants[i]) / 2;
        }

        for (var i = 0; i < count - 1; i++)
        {
            if (Math.Abs(secants[i]) < 1e-12)
            {
                tangents[i] = 0;
                tangents[i + 1] = 0;
                continue;
            }

            var alpha = tangents[i] / secants[i];
            var beta = tangents[i + 1] / secants[i];
            var norm = Math.Sqrt((alpha * alpha) + (beta * beta));
            if (norm > 3)
            {
                tangents[i] = 3 * alpha / norm * secants[i];
                tangents[i + 1] = 3 * beta / norm * secants[i];
            }
        }

        return tangents;
    }

    private static SKPathEffect? DashEffect(IReadOnlyList<double>? dash) =>
        dash is { Count: > 1 }
            ? SKPathEffect.CreateDash([.. dash.Select(d => (float)d)], 0)
            : null;

    private static SKPaint StrokePaint(string color, double width) => new()
    {
        Color = ParseColor(color),
        IsAntialias = true,
        Style = SKPaintStyle.Stroke,
        StrokeWidth = (float)width,
    };

    private static void DrawText(SKCanvas canvas, LayoutText text)
    {
        using var font = new SKFont(
            text.Bold ? BoldTypeface.Value : RegularTypeface.Value, (float)text.FontSize);
        using var paint = new SKPaint { Color = ParseColor(text.Color), IsAntialias = true };
        var align = text.Anchor switch
        {
            TextAnchor.Middle => SKTextAlign.Center,
            TextAnchor.End => SKTextAlign.Right,
            _ => SKTextAlign.Left,
        };

        if (text.RotationDegrees != 0)
        {
            canvas.Save();
            canvas.Translate((float)text.X, (float)text.Y);
            canvas.RotateDegrees((float)text.RotationDegrees);
            canvas.DrawText(text.Text, 0, 0, align, font, paint);
            canvas.Restore();
        }
        else
        {
            canvas.DrawText(text.Text, (float)text.X, (float)text.Y, align, font, paint);
        }
    }

    private static SKPaint FillPaint(string color, double opacity)
    {
        var parsed = ParseColor(color);
        if (opacity < 1)
        {
            parsed = parsed.WithAlpha((byte)Math.Clamp(opacity * 255, 0, 255));
        }

        return new SKPaint { Color = parsed, IsAntialias = true, Style = SKPaintStyle.Fill };
    }

    private static SKColor ParseColor(string color) =>
        SKColor.TryParse(color, out var parsed) ? parsed : SKColors.Black;
}
