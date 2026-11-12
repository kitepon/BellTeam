using System.Globalization;
using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Media.Immutable;
using Avalonia.Platform;
using BellTeam.Core;

namespace BellTeam.Linux;

// 相関図 text: one place measures and draws it, so the wrapped chip a measurer reports is the chip that is drawn (behavior-spec.md "Label").
internal static class WorkGraphText
{
    private static readonly CultureInfo Culture = CultureInfo.GetCultureInfo("ja-JP");
    private static Typeface Face(FontWeight weight) => new(BellTheme.Font, FontStyle.Normal, weight);
    public static readonly Typeface Name = Face(FontWeight.SemiBold), Detail = Face(FontWeight.Medium), Letter = Face(FontWeight.Bold);
    /// <summary>Mac listDetailFontSize.</summary>
    public const double DetailSize = 14;
    public static readonly IBrush Ink = Frozen(0x21, 0x29, 0x3D), Muted = Frozen(0x78, 0x7D, 0x91), Canvas = Frozen(0xF8, 0xF8, 0xFB);

    public static IBrush Frozen(byte r, byte g, byte b) => new ImmutableSolidColorBrush(Color.FromRgb(r, g, b));

    /// <summary>The text column of a chip: its width minus the envelope and the 22 pt of padding. Measuring and drawing both use this.</summary>
    public static double TextColumn(double tagWidth) => tagWidth - DetailSize - 22;

    // Measuring runs every frame for every chip and name; the text and its size only change with the string and the column.
    private static readonly Dictionary<(string, double), FormattedText> Labels = [];
    private static readonly Dictionary<string, double> NameWidths = [];

    /// <summary>A chip's text: 14 pt medium, lines exactly 16 pt high, wrapped at <paramref name="column"/> and never truncated.</summary>
    public static FormattedText Label(string text, double column)
    {
        if (Labels.TryGetValue((text, column), out var known)) return known;
        if (Labels.Count > 512) Labels.Clear();
        return Labels[(text, column)] = new FormattedText(text, Culture, FlowDirection.LeftToRight, Detail, DetailSize, Ink)
        { MaxTextWidth = Math.Max(1, column), LineHeight = WorkGraphSimulation.ChipLineHeight, Trimming = TextTrimming.None };
    }

    /// <summary>The whole chip box for a text wrapped at most <paramref name="maxWidth"/> wide: widest line + envelope + padding by the wrapped height + padding.</summary>
    public static GraphSize ChipSize(string text, double maxWidth)
    {
        var column = TextColumn(maxWidth);
        var label = Label(text, column);
        return new(Math.Min(Math.Ceiling(label.Width), column) + DetailSize + 22, Math.Max(Math.Ceiling(label.Height), DetailSize) + 10);
    }

    /// <summary>The width of a name on one line at 16 pt semibold (the model clamps it to the name slot).</summary>
    public static double NameWidth(string name)
    {
        if (NameWidths.TryGetValue(name, out var known)) return known;
        if (NameWidths.Count > 512) NameWidths.Clear();
        return NameWidths[name] = new FormattedText(name, Culture, FlowDirection.LeftToRight, Name, WorkGraphSimulation.NameFontSize, Ink).Width;
    }

    /// <summary>A name on one line, centred in <paramref name="width"/> and shortened with an ellipsis (behavior-spec.md "Sizes").</summary>
    public static FormattedText Line(string text, Typeface face, double size, IBrush brush, double width) =>
        new(text, Culture, FlowDirection.LeftToRight, face, size, brush) { MaxTextWidth = Math.Max(1, width), MaxLineCount = 1, Trimming = TextTrimming.CharacterEllipsis, TextAlignment = TextAlignment.Center };

    /// <summary>A one-line caption in the regular weight (the empty graph).</summary>
    public static FormattedText Caption(string text, double size, IBrush brush) => new(text, Culture, FlowDirection.LeftToRight, new Typeface(BellTheme.Font), size, brush);
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
    public static Color? Representative(Bitmap image)
    {
        // The picture is scaled to 24x24 and read back as BGRA, whatever format the decoder produced.
        using var scaled = image.CreateScaledBitmap(new PixelSize(24, 24));
        using var target = new WriteableBitmap(new PixelSize(24, 24), new Vector(96, 96), PixelFormat.Bgra8888, AlphaFormat.Unpremul);
        var pixels = new byte[24 * 24 * 4];
        using (var buffer = target.Lock())
        {
            scaled.CopyPixels(buffer);
            for (var row = 0; row < 24; row++) Marshal.Copy(buffer.Address + row * buffer.RowBytes, pixels, row * 24 * 4, 24 * 4);
        }
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
