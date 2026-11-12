using Avalonia;
using Avalonia.Controls;
using Shapes = Avalonia.Controls.Shapes;
using Avalonia.Media;

namespace BellTeam.Linux;

// Colours of windows/BellTeam.App/BellTheme.xaml and MacUi, as shared frozen brushes.
public static class BellTheme
{
    private static IBrush Solid(string hex) => new Avalonia.Media.Immutable.ImmutableSolidColorBrush(Color.Parse(hex));
    public static readonly IBrush Ink = Solid("#21293D"), Muted = Solid("#787D91"), Secondary = Solid("#8A8A8E"), Violet = Solid("#6147D4"), ProminentFill = Solid("#5642C9"),
        Mint = Solid("#2EB39E"), Red = Solid("#FF3B30"), Line = Solid("#E5E3F0"), Canvas = Solid("#F8F8FB"), ButtonFill = Solid("#E4E3E8"), SidebarFill = Solid("#F1EDFC"), BandFill = Solid("#E9E7E6"), QueueFill = Solid("#A6E8E0FF");
    public static readonly IBrush ConversationBackground = new LinearGradientBrush
    {
        StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative), EndPoint = new RelativePoint(1, 1, RelativeUnit.Relative),
        GradientStops = [new GradientStop(Color.Parse("#F1ECFF"), 0), new GradientStop(Color.Parse("#F8F8FB"), .55), new GradientStop(Colors.White, 1)]
    };
    // Fonts the Linux desktop is expected to have; sans-serif is the fallback when Noto is missing.
    public static readonly FontFamily Font = new("Noto Sans CJK JP, sans-serif");
    public static readonly FontFamily Mono = new("Noto Sans Mono CJK JP, DejaVu Sans Mono, monospace");

    public static TextBlock Text(string text, double size, IBrush? color = null, FontWeight weight = FontWeight.Normal, Thickness? margin = null)
        => new() { Text = text, FontSize = size, Foreground = color ?? Ink, FontWeight = weight, TextWrapping = TextWrapping.Wrap, Margin = margin ?? default };
}

// Segoe icon glyphs do not exist on Linux: small stroked vector icons on a 24x24 canvas.
public static class Icons
{
    public const string Search = "M10.5,4 a6.5,6.5 0 1 0 0.01,0 Z M15.5,15.5 L21,21";
    public const string PlusCircle = "M12,3 a9,9 0 1 0 0.01,0 Z M12,7.5 V16.5 M7.5,12 H16.5";
    public const string ChevronDown = "M6,9 L12,15 L18,9";
    public const string ChevronRight = "M9,6 L15,12 L9,18";
    public const string Calendar = "M4,6 H20 V20 H4 Z M4,10.5 H20 M8,3.5 V7.5 M16,3.5 V7.5";
    public const string Target = "M12,3 a9,9 0 1 0 0.01,0 Z M12,7 a5,5 0 1 0 0.01,0 Z M12,11 a1,1 0 1 0 0.01,0 Z";
    public const string Paperclip = "M20,11.5 L12,19.5 a5,5 0 0 1 -7.1,-7.1 L13,4.3 a3.3,3.3 0 0 1 4.7,4.7 L9.7,17 a1.6,1.6 0 0 1 -2.3,-2.3 L14.5,7.6";
    public const string Send = "M12,20 V5 M5.5,11.5 L12,5 L18.5,11.5";
    public const string Close = "M6,6 L18,18 M18,6 L6,18";
    public const string Export = "M12,15 V3.5 M7.5,8 L12,3.5 L16.5,8 M5,12 V20 H19 V12";
    public const string Warning = "M12,3.5 L22,20.5 H2 Z M12,10 V15 M12,17.6 V18";
    public const string Check = "M5,12.5 L10,17.5 L19,7";
    public const string Image = "M4,5 H20 V19 H4 Z M4,15.5 L9,10.5 L14,15.5 L16.5,13 L20,16.5 M15.5,9 a1,1 0 1 0 0.01,0";
    public const string Branch = "M6,21 L6,12 L1.5,6 M6,12 L10.5,6";
    public const string Link = "M10,14 a4,4 0 0 0 5.7,0 l3.5,-3.5 a4,4 0 0 0 -5.7,-5.7 L12.5,5.8 M14,10 a4,4 0 0 0 -5.7,0 L4.8,13.5 a4,4 0 0 0 5.7,5.7 L11.5,18.2";
    public const string Sparkle = "M12,1.5 L14.3,9.7 L22.5,12 L14.3,14.3 L12,22.5 L9.7,14.3 L1.5,12 L9.7,9.7 Z";
    public const string Lock = "M6,11 H18 V20 H6 Z M8.5,11 V8 a3.5,3.5 0 0 1 7,0 V11";
    public const string Chat = "M4,5 H20 V16 H11 L6,20.5 V16 H4 Z";
    public const string Book = "M12,6 C9,4.5 6,4.5 3,5.5 V19 C6,18 9,18 12,19.5 C15,18 18,18 21,19 V5.5 C18,4.5 15,4.5 12,6 Z M12,6 V19.5";

    // A gear drawn from a ring and eight teeth; computed so the data stays readable.
    public static readonly string Gear = "M12,9 a3,3 0 1 0 0.01,0 Z " + string.Concat(Enumerable.Range(0, 8).Select(index =>
    {
        var angle = index * Math.PI / 4; var (sin, cos) = Math.SinCos(angle);
        return FormattableString.Invariant($"M{12 + 6.2 * cos:0.##},{12 + 6.2 * sin:0.##} L{12 + 9 * cos:0.##},{12 + 9 * sin:0.##} ");
    })) + "M12,6.5 a5.5,5.5 0 1 0 0.01,0 Z";

    // Whether the shapes are drawn as outline (stroke) or solid (fill).
    public static Control Draw(string data, double size, IBrush? stroke = null, bool filled = false, double thickness = 1.8)
    {
        var path = new Shapes.Path { Data = StreamGeometry.Parse(data), StrokeThickness = thickness, StrokeLineCap = PenLineCap.Round, StrokeJoin = PenLineJoin.Round };
        if (filled) path.Fill = stroke ?? BellTheme.Ink; else path.Stroke = stroke ?? BellTheme.Ink;
        return new Viewbox { Width = size, Height = size, VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center, IsHitTestVisible = false, Child = new Canvas { Width = 24, Height = 24, Children = { path } } };
    }

    internal static string RoundedRect(double x, double y, double width, double height, double radius) => FormattableString.Invariant(
        $"M{x + radius},{y} H{x + width - radius} A{radius},{radius} 0 0 1 {x + width},{y + radius} V{y + height - radius} A{radius},{radius} 0 0 1 {x + width - radius},{y + height} H{x + radius} A{radius},{radius} 0 0 1 {x},{y + height - radius} V{y + radius} A{radius},{radius} 0 0 1 {x + radius},{y} Z ");
    internal static string Disc(double cx, double cy, double radius) => FormattableString.Invariant($"M{cx - radius},{cy} A{radius},{radius} 0 1 0 {cx + radius},{cy} A{radius},{radius} 0 1 0 {cx - radius},{cy} Z ");
}
