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
            using var path = new SKPath();
            path.AddPoly(area.Points.Select(p => new SKPoint((float)p.X, (float)p.Y)).ToArray());
            canvas.DrawPath(path, paint);
        }

        foreach (var bar in layout.Bars)
        {
            using var paint = FillPaint(bar.Fill, bar.Opacity);
            canvas.DrawRect((float)bar.X, (float)bar.Y, (float)bar.Width, (float)bar.Height, paint);
        }

        foreach (var arc in layout.Arcs)
        {
            DrawArc(canvas, arc);
        }

        foreach (var polyline in layout.Lines)
        {
            using var paint = new SKPaint
            {
                Color = ParseColor(polyline.Stroke),
                IsAntialias = true,
                Style = SKPaintStyle.Stroke,
                StrokeWidth = (float)polyline.StrokeWidth,
                StrokeJoin = SKStrokeJoin.Round,
                StrokeCap = SKStrokeCap.Round,
            };
            using var path = new SKPath();
            path.MoveTo((float)polyline.Points[0].X, (float)polyline.Points[0].Y);
            foreach (var point in polyline.Points.Skip(1))
            {
                path.LineTo((float)point.X, (float)point.Y);
            }

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
        using var paint = new SKPaint
        {
            Color = ParseColor(line.Stroke),
            IsAntialias = true,
            Style = SKPaintStyle.Stroke,
            StrokeWidth = (float)line.StrokeWidth,
        };
        canvas.DrawLine((float)line.X1, (float)line.Y1, (float)line.X2, (float)line.Y2, paint);
    }

    private static void DrawArc(SKCanvas canvas, LayoutArc arc)
    {
        // Layout angles: 0° at 12 o'clock, clockwise. Skia arc angles: 0° at
        // 3 o'clock, clockwise — shift by -90°.
        var start = (float)(arc.StartDegrees - 90);
        var sweep = (float)arc.SweepDegrees;
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
    }

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
