using System.Globalization;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using BellTeam.Core;

namespace BellTeam.App;

// 相関図 text: one place measures and draws it, so the wrapped chip a measurer reports is the chip that is drawn (behavior-spec.md "Label").
internal static class WorkGraphText
{
    private static readonly CultureInfo Culture = CultureInfo.GetCultureInfo("ja-JP");
    private static Typeface Face(FontWeight weight) => new(new FontFamily("Yu Gothic UI"), FontStyles.Normal, weight, FontStretches.Normal);
    public static readonly Typeface Name = Face(FontWeights.SemiBold), Detail = Face(FontWeights.Medium), Letter = Face(FontWeights.Bold);
    /// <summary>Mac listDetailFontSize.</summary>
    public const double DetailSize = 14;
    public static readonly Brush Ink = Frozen(0x21, 0x29, 0x3D), Muted = Frozen(0x78, 0x7D, 0x91), Canvas = Frozen(0xF8, 0xF8, 0xFB);

    public static Brush Frozen(byte r, byte g, byte b) { var brush = new SolidColorBrush(Color.FromRgb(r, g, b)); brush.Freeze(); return brush; }

    /// <summary>The text column of a chip: its width minus the envelope and the 22 pt of padding. Measuring and drawing both use this.</summary>
    public static double TextColumn(double tagWidth) => tagWidth - DetailSize - 22;

    // Measuring runs every frame for every chip and name; the text and its size only change with the string, the column and the DPI.
    private static readonly Dictionary<(string, double, double), FormattedText> Labels = [];
    private static readonly Dictionary<(string, double), double> NameWidths = [];

    /// <summary>A chip's text: 14 pt medium, lines exactly 16 pt high, wrapped at <paramref name="column"/> and never truncated.</summary>
    public static FormattedText Label(string text, double column, double dpi)
    {
        if (Labels.TryGetValue((text, column, dpi), out var known)) return known;
        if (Labels.Count > 512) Labels.Clear();
        return Labels[(text, column, dpi)] = new FormattedText(text, Culture, FlowDirection.LeftToRight, Detail, DetailSize, Ink, dpi)
        { MaxTextWidth = Math.Max(1, column), LineHeight = WorkGraphSimulation.ChipLineHeight, Trimming = TextTrimming.None };
    }

    /// <summary>The whole chip box for a text wrapped at most <paramref name="maxWidth"/> wide: widest line + envelope + padding by the wrapped height + padding.</summary>
    public static GraphSize ChipSize(string text, double maxWidth, double dpi)
    {
        var column = TextColumn(maxWidth);
        var label = Label(text, column, dpi);
        return new(Math.Min(Math.Ceiling(label.Width), column) + DetailSize + 22, Math.Max(Math.Ceiling(label.Height), DetailSize) + 10);
    }

    /// <summary>The width of a name on one line at 16 pt semibold (the model clamps it to the name slot).</summary>
    public static double NameWidth(string name, double dpi)
    {
        if (NameWidths.TryGetValue((name, dpi), out var known)) return known;
        if (NameWidths.Count > 512) NameWidths.Clear();
        return NameWidths[(name, dpi)] = new FormattedText(name, Culture, FlowDirection.LeftToRight, Name, WorkGraphSimulation.NameFontSize, Ink, dpi).Width;
    }

    /// <summary>A name on one line, centred in <paramref name="width"/> and shortened with an ellipsis (behavior-spec.md "Sizes").</summary>
    public static FormattedText Line(string text, Typeface face, double size, Brush brush, double width, double dpi) =>
        new(text, Culture, FlowDirection.LeftToRight, face, size, brush, dpi) { MaxTextWidth = Math.Max(1, width), MaxLineCount = 1, Trimming = TextTrimming.CharacterEllipsis, TextAlignment = TextAlignment.Center };
}

internal static class WorkGraphColors
{
    /// <summary>The line colour: the requester's tone made darker so it holds on a bright background.</summary>
    public static Color Wire(Color tone) => Shade(tone, 1.15, 0.85);
    /// <summary>The light running through a line: the same hue, brighter.</summary>
    public static Color Spark(Color tone) => Shade(tone, 0.45, 1.3);
    public static Color Alpha(Color color, double alpha) => Color.FromArgb((byte)Math.Round(255 * alpha), color.R, color.G, color.B);

    /// <summary>Nodes of a lost stream keep their hue but lose 60 % of the colour (Mac: saturation 0.4).</summary>
    public static Color Dim(Color color)
    {
        var gray = 0.299 * color.R + 0.587 * color.G + 0.114 * color.B;
        byte Mix(byte v) => (byte)Math.Round(gray + (v - gray) * 0.4);
        return Color.FromArgb(color.A, Mix(color.R), Mix(color.G), Mix(color.B));
    }

    private static Color Shade(Color color, double saturation, double brightness)
    {
        var (h, s, v) = ToHsv(color);
        return FromHsv(h, Math.Min(1, s * saturation), Math.Min(1, v * brightness));
    }

    private static (double H, double S, double V) ToHsv(Color color)
    {
        double r = color.R / 255.0, g = color.G / 255.0, b = color.B / 255.0;
        var max = Math.Max(r, Math.Max(g, b)); var delta = max - Math.Min(r, Math.Min(g, b));
        var hue = delta == 0 ? 0 : max == r ? ((g - b) / delta % 6 + 6) % 6 : max == g ? (b - r) / delta + 2 : (r - g) / delta + 4;
        return (hue / 6, max == 0 ? 0 : delta / max, max);
    }

    private static Color FromHsv(double h, double s, double v)
    {
        double Channel(double n) { var k = (n + h * 6) % 6; return v - v * s * Math.Max(0, Math.Min(Math.Min(k, 4 - k), 1)); }
        return Color.FromRgb((byte)Math.Round(Channel(5) * 255), (byte)Math.Round(Channel(3) * 255), (byte)Math.Round(Channel(1) * 255));
    }

    /// <summary>The avatar's representative colour (Mac AvatarTone): vivid pixels weighted by saturation, at a fixed brightness. Null for a grey or empty picture.</summary>
    public static Color? Representative(BitmapSource image)
    {
        var scaled = new FormatConvertedBitmap(new TransformedBitmap(image, new ScaleTransform(24.0 / image.PixelWidth, 24.0 / image.PixelHeight)), PixelFormats.Bgra32, null, 0);
        var pixels = new byte[scaled.PixelWidth * scaled.PixelHeight * 4];
        scaled.CopyPixels(pixels, scaled.PixelWidth * 4, 0);
        double red = 0, green = 0, blue = 0, total = 0;
        for (var i = 0; i < pixels.Length; i += 4)
        {
            double b = pixels[i], g = pixels[i + 1], r = pixels[i + 2];
            var max = Math.Max(r, Math.Max(g, b)); var min = Math.Min(r, Math.Min(g, b));
            if (pixels[i + 3] < 128 || (max > 235 && min > 200) || max < 40) continue;
            var weight = 0.15 + (max - min) / max;
            red += r * weight; green += g * weight; blue += b * weight; total += weight;
        }
        if (total == 0) return null;
        var (hue, saturation, _) = ToHsv(Color.FromRgb((byte)Math.Round(red / total), (byte)Math.Round(green / total), (byte)Math.Round(blue / total)));
        return saturation > 0.05 ? FromHsv(hue, Math.Max(0.55, Math.Min(0.8, saturation)), 0.78) : null;
    }
}
