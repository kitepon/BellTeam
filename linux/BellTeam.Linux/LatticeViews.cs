using System.Globalization;
using Avalonia;
using Avalonia.Animation;
using Avalonia.Controls;
using Avalonia.Controls.Shapes;
using Path = Avalonia.Controls.Shapes.Path;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Immutable;
using Avalonia.Media.Imaging;
using Avalonia.Styling;
using Avalonia.Automation;
using BellTeam.Core;

namespace BellTeam.Linux;

/// <summary>Colors, shapes and small parts of the 工程表 window (screen-spec.md "Colors", "Card states"). Light only, like the rest of this app.</summary>
internal static class LatticeLook
{
    public static readonly Color Ink = Color.FromRgb(0x21, 0x29, 0x3D), Muted = Color.FromRgb(0x78, 0x7D, 0x91), Line = Color.FromRgb(0xE5, 0xE3, 0xF0),
        Violet = Color.FromRgb(0x61, 0x47, 0xD4), Red = Color.FromRgb(0xE0, 0x53, 0x3D), Done = Color.FromRgb(0x5E, 0x8F, 0x7E), Amber = Color.FromRgb(0xB8, 0x6E, 0x00), Slate = Color.FromRgb(0x4A, 0x5B, 0x70);
    public static IBrush Brush(Color color, byte alpha = 255) => new ImmutableSolidColorBrush(Color.FromArgb(alpha, color.R, color.G, color.B));
    public static Color Accent(string? color) => BellColors.Accent(color);
    // Linux has no system-wide "animations off" setting to read, so motion is on except for the render modes (screenshots are taken at a fixed clock).
    public static bool Motion { get; set; } = true;

    // Vector icons (24x24 canvas, like Icons): the Segoe glyphs of the Windows window have no Linux font.
    private const string ChevronLeft = "M15,6 L9,12 L15,18", Plus = "M12,5 V19 M5,12 H19", Play = "M8,5 L19,12 L8,19 Z",
        SealCheck = "M12,3 a9,9 0 1 0 0.01,0 Z M7.5,12.5 L10.5,15.5 L16.5,9", Archive = "M3.5,5 H20.5 V9 H3.5 Z M5,9 V19 H19 V9 M10,13 H14",
        Info = "M12,3 a9,9 0 1 0 0.01,0 Z M12,11 V16.5 M12,7.8 V8.2", Forward = "M5,12 H19 M13,6 L19,12 L13,18";
    // The 工程表 sidebar entry: a bulleted list.
    public const string ListGlyph = "M9,6 H20 M9,12 H20 M9,18 H20 M4.5,6 H5 M4.5,12 H5 M4.5,18 H5";
    public const string ChatGlyph = Icons.Chat, ForwardGlyph = Forward;
    public static Control Icon(string data, double size, Color color, bool filled = false) => Icons.Draw(data, size, Brush(color), filled, 2);
    public static Control BackIcon(double size, Color color) => Icon(ChevronLeft, size, color);
    public static Control PlusIcon(double size, Color color) => Icon(Plus, size, color);
    public static Control DownIcon(double size, Color color) => Icon(Icons.ChevronDown, size, color);
    public static Control RightIcon(double size, Color color) => Icon(Icons.ChevronRight, size, color);
    public static Control CloseIcon(double size, Color color) => Icon(Icons.Close, size, color);
    public static Control WarningIcon(double size, Color color) => Icon(Icons.Warning, size, color);
    public static Control InfoIcon(double size, Color color) => Icon(Info, size, color);

    /// <summary>Frosted glass over the window backdrop: a translucent white sheet with a light rim and a soft shadow.</summary>
    public static Border Glass(Control? child = null, double radius = 16, Thickness? padding = null, byte alpha = 0xD9) => new()
    {
        Child = child, CornerRadius = new CornerRadius(radius), Padding = padding ?? new Thickness(14), Background = Brush(Colors.White, alpha),
        BorderBrush = Brush(Colors.White, 0xF0), BorderThickness = new Thickness(1),
        BoxShadow = new BoxShadows(new BoxShadow { OffsetY = 6, Blur = 22, Color = Color.FromArgb(18, Ink.R, Ink.G, Ink.B) })
    };
    public static TextBlock Text(string text, double size = 14, Color? color = null, FontWeight weight = FontWeight.Normal, bool wrap = false) => new()
    {
        Text = text, FontSize = size, Foreground = Brush(color ?? Ink), FontWeight = weight, TextWrapping = wrap ? TextWrapping.Wrap : TextWrapping.NoWrap,
        TextTrimming = wrap ? TextTrimming.None : TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center
    };
    public static Border Pill(Control child, Color tint, byte alpha = 0x1F, Thickness? padding = null) => new() { Child = child, Background = Brush(tint, alpha), CornerRadius = new CornerRadius(99), Padding = padding ?? new Thickness(10, 4, 10, 4), VerticalAlignment = VerticalAlignment.Center };
    public static StackPanel Row(params Control[] children) { var row = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center }; row.Children.AddRange(children); return row; }
    // The Windows button shows a Segoe glyph from its Tag before the label; here it is a vector icon.
    public static Button Action(string label, string? icon = null, bool primary = false)
    {
        var tone = primary ? Colors.White : Violet;
        var button = new Button { Classes = { "plain" }, FontSize = 13, Padding = new Thickness(11, 6), Margin = new Thickness(0, 0, 8, 0), Foreground = Brush(tone), Background = Brush(primary ? Violet : Colors.White), BorderBrush = Brush(Line), BorderThickness = new Thickness(primary ? 0 : 1) };
        button.Content = icon is null ? label : Row(Icon(icon, 14, tone), Spaced(new TextBlock { Text = label, VerticalAlignment = VerticalAlignment.Center }, 7));
        AutomationProperties.SetName(button, label); return button;
    }
    /// <summary>A button that draws only its content (cards, rail items, list cards): keyboard focus, Enter/Space and the accessibility name come from Button.</summary>
    public static Button Plain(Control content, string name)
    {
        var button = new Button { Classes = { "plain" }, Content = content, Padding = default, Margin = default, Background = Brushes.Transparent, BorderThickness = default, HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };
        AutomationProperties.SetName(button, name);
        return button;
    }

    public static Geometry CrownGeometry { get; } = Geometry.Parse("M1,11 L2.6,3.6 L6.6,7.2 L10,1.4 L13.4,7.2 L17.4,3.6 L19,11 Z M1.6,12.6 H18.4 V14.6 H1.6 Z");
    public static Geometry HourglassGeometry { get; } = Geometry.Parse("M0,0 H10 V1.6 L6.4,5 L10,8.4 V10 H0 V8.4 L3.6,5 L0,1.6 Z");
    public static Geometry OctagonGeometry { get; } = Geometry.Parse("M4.1,0 H9.9 L14,4.1 V9.9 L9.9,14 H4.1 L0,9.9 V4.1 Z");
    public static Path Shape(Geometry geometry, double size, Color color) => new() { Data = geometry, Fill = Brush(color), Width = size, Height = size, Stretch = Stretch.Uniform, VerticalAlignment = VerticalAlignment.Center };
    public static Control Crown(double size = 15) => Shape(CrownGeometry, size, Color.FromRgb(0xD9, 0x9A, 0x1E));
    public static Border CoordinatorBadge() => Pill(Row(Crown(13), Spaced(Text("統括", 12, Color.FromRgb(0x9A, 0x63, 0x00), FontWeight.SemiBold), 5)), Color.FromRgb(0xF5, 0xB7, 0x2E), 0x2E, new Thickness(8, 3, 9, 3));
    public static T Spaced<T>(T element, double left) where T : Control { element.Margin = new Thickness(left, 0, 0, 0); return element; }

    /// <summary>Runs an animation while the control is on screen and stops it when it leaves, so a rebuilt page leaves no running loop behind.</summary>
    public static void Loop(Control host, Animation animation)
    {
        if (!Motion) return;
        CancellationTokenSource? source = null;
        host.AttachedToVisualTree += (_, _) => { source?.Cancel(); source = new CancellationTokenSource(); _ = animation.RunAsync(host, source.Token); };
        host.DetachedFromVisualTree += (_, _) => { source?.Cancel(); source = null; };
    }
    public static Animation Pulse(double from, double to, TimeSpan duration) => new()
    {
        Duration = duration, IterationCount = IterationCount.Infinite, PlaybackDirection = PlaybackDirection.Alternate,
        Children = { new KeyFrame { Cue = new Cue(0), Setters = { new Setter(Visual.OpacityProperty, from) } }, new KeyFrame { Cue = new Cue(1), Setters = { new Setter(Visual.OpacityProperty, to) } } }
    };

    /// <summary>State glyph: dashed circle, play, working arc, octagon exclamation, seal check, archive. Color never carries a state alone: the badge text is always beside it.</summary>
    public static Control StateGlyph(string state, double size, Color accent)
    {
        switch (state)
        {
            case "ready": return Icon(Play, size * .8, accent, filled: true);
            case "in-progress": return Arc(size, accent, 1.8);
            case "blocked":
                var octagon = new Grid { Width = size, Height = size, VerticalAlignment = VerticalAlignment.Center };
                octagon.Children.Add(Shape(OctagonGeometry, size, Red));
                octagon.Children.Add(new TextBlock { Text = "!", FontSize = size * .72, FontWeight = FontWeight.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, -size * .08, 0, 0) });
                Loop(octagon, Pulse(1, .45, TimeSpan.FromMilliseconds(900)));
                return octagon;
            case "done": return Icon(SealCheck, size * .9, Done);
            case "retired": return Icon(Archive, size * .8, Muted);
            default: return new Ellipse { Width = size * .82, Height = size * .82, Stroke = Brush(Muted), StrokeThickness = 1.4, StrokeDashArray = [2, 1.6], VerticalAlignment = VerticalAlignment.Center };
        }
    }
    /// <summary>The working arc: a quarter-open ring turning once every 8 s (still when motion is off).</summary>
    public static Control Arc(double size, Color color, double thickness)
    {
        var radius = (size - thickness) / 2; var center = size / 2;
        var track = new Ellipse { Width = size, Height = size, Stroke = Brush(color, 0x33), StrokeThickness = thickness };
        var arc = new Path
        {
            Data = StreamGeometry.Parse(FormattableString.Invariant($"M{center},{center - radius} A{radius},{radius} 0 1 1 {center - radius},{center}")),
            Stroke = Brush(color), StrokeThickness = thickness, StrokeLineCap = PenLineCap.Round, Width = size, Height = size, RenderTransformOrigin = RelativePoint.Center
        };
        Loop(arc, new Animation
        {
            Duration = TimeSpan.FromSeconds(8), IterationCount = IterationCount.Infinite,
            Children = { new KeyFrame { Cue = new Cue(0), Setters = { new Setter(RotateTransform.AngleProperty, 0d) } }, new KeyFrame { Cue = new Cue(1), Setters = { new Setter(RotateTransform.AngleProperty, 360d) } } }
        });
        return new Grid { Width = size, Height = size, VerticalAlignment = VerticalAlignment.Center, IsHitTestVisible = false, Children = { track, arc } };
    }
    public static Control Spinner(double size = 14) => Arc(size, Violet, 2);
}

/// <summary>A member's face: the avatar image when the roster has one, else the initial on the accent; an authored lane text's initial on grey; 「?」 for 名簿にないメンバー and 「–」 for 担当なし.</summary>
internal sealed class LatticeAvatar : Grid
{
    public LatticeAvatar(LatticePerson? person, double size, Func<string, string, Task<Bitmap>>? load)
    {
        Width = Height = size; VerticalAlignment = VerticalAlignment.Center; IsHitTestVisible = false;
        var accent = person is { Known: true } ? LatticeLook.Accent(person.Color) : Color.FromRgb(0xA4, 0xA7, 0xB6);
        var initial = person is null ? "–" : !person.Known && !person.Authored ? "?" : person.Name.Length > 0 ? person.Name[..1] : "?";
        var letter = new TextBlock { Text = initial, FontSize = size * .42, FontWeight = FontWeight.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        var face = new Border
        {
            CornerRadius = new CornerRadius(size * .31), BorderBrush = Brushes.White, BorderThickness = new Thickness(size > 30 ? 2 : 1.5), Child = letter,
            Background = new LinearGradientBrush { StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative), EndPoint = new RelativePoint(1, 1, RelativeUnit.Relative), GradientStops = [new GradientStop(Color.FromArgb(190, accent.R, accent.G, accent.B), 0), new GradientStop(accent, 1)] }
        };
        Children.Add(face);
        AutomationProperties.SetName(this, LatticeChart.NameOf(person));
        if (person is { Known: true, AvatarVersion.Length: > 0 } && load is not null) _ = LoadAsync(person, face, letter, load);
    }
    private static async Task LoadAsync(LatticePerson person, Border face, TextBlock letter, Func<string, string, Task<Bitmap>> load)
    {
        // An image that cannot be read keeps the initial: the face still names the member.
        try { var image = await load(person.BotId, person.AvatarVersion); face.Background = new ImageBrush(image) { Stretch = Stretch.UniformToFill }; letter.Text = ""; }
        catch (Exception) { }
    }
}

/// <summary>The progress ring: done / total around, the count in the middle.</summary>
internal sealed class LatticeRing : Control
{
    private readonly double fraction; private readonly string label; private readonly double size;
    public LatticeRing(int done, int total, double size, bool showLabel = true)
    {
        fraction = total > 0 ? Math.Min(1, (double)done / total) : 0; label = showLabel ? $"{done}/{total}" : ""; this.size = size; Width = Height = size; VerticalAlignment = VerticalAlignment.Center;
        AutomationProperties.SetName(this, $"完了 {done}/{total}");
    }
    public override void Render(DrawingContext context)
    {
        var thickness = Math.Max(3, size / 10); var radius = (size - thickness) / 2; var center = new Point(size / 2, size / 2);
        context.DrawEllipse(null, new Pen(LatticeLook.Brush(LatticeLook.Violet, 0x24), thickness), center, radius, radius);
        if (fraction > 0)
        {
            var angle = Math.Min(359.99, fraction * 360) * Math.PI / 180; var end = new Point(center.X + radius * Math.Sin(angle), center.Y - radius * Math.Cos(angle));
            var figure = new StreamGeometry();
            using (var open = figure.Open())
            {
                open.BeginFigure(new Point(center.X, center.Y - radius), false);
                open.ArcTo(end, new Size(radius, radius), 0, fraction > .5, SweepDirection.Clockwise);
                open.EndFigure(false);
            }
            var gradient = new LinearGradientBrush { StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative), EndPoint = new RelativePoint(0, 1, RelativeUnit.Relative), GradientStops = [new GradientStop(Color.FromRgb(0x8B, 0x6C, 0xF0), 0), new GradientStop(LatticeLook.Violet, 1)] };
            context.DrawGeometry(null, new Pen(gradient, thickness, null, PenLineCap.Round), figure);
        }
        if (label.Length == 0) return;
        FormattedText Label(double em) => new(label, CultureInfo.CurrentUICulture, FlowDirection.LeftToRight, new Typeface(BellTheme.Font, FontStyle.Normal, FontWeight.SemiBold), em, LatticeLook.Brush(LatticeLook.Ink));
        var em = Math.Max(9, size * .27); var text = Label(em);
        // Three-digit counts (141/151) shrink to stay inside the ring instead of running over it.
        var inside = 2 * radius - thickness - 4;
        if (text.Width > inside) text = Label(em * inside / text.Width);
        context.DrawText(text, new Point(center.X - text.Width / 2, center.Y - text.Height / 2));
    }
}

/// <summary>A closed bud (unavailable chart): a stem, a leaf and a bud that has not opened yet.</summary>
internal sealed class LatticeBud : Control
{
    public LatticeBud() { Width = 120; Height = 120; HorizontalAlignment = HorizontalAlignment.Center; }
    public override void Render(DrawingContext context)
    {
        var green = Color.FromRgb(0x6F, 0xA8, 0x8E);
        context.DrawEllipse(LatticeLook.Brush(LatticeLook.Violet, 0x14), null, new Point(60, 64), 56, 56);
        context.DrawGeometry(null, new Pen(LatticeLook.Brush(green), 3, null, PenLineCap.Round), Geometry.Parse("M60,104 C60,88 59,76 60,62"));
        context.DrawGeometry(LatticeLook.Brush(green, 0xCC), null, Geometry.Parse("M60,90 C70,78 84,80 88,84 C80,94 68,94 60,90 Z"));
        var bud = new LinearGradientBrush { StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative), EndPoint = new RelativePoint(0, 1, RelativeUnit.Relative), GradientStops = [new GradientStop(Color.FromRgb(0xC9, 0xB8, 0xFF), 0), new GradientStop(LatticeLook.Violet, 1)] };
        context.DrawGeometry(bud, null, Geometry.Parse("M60,24 C72,36 76,50 68,62 C64,66 56,66 52,62 C44,50 48,36 60,24 Z"));
        context.DrawGeometry(LatticeLook.Brush(green), null, Geometry.Parse("M50,60 C54,66 66,66 70,60 C68,68 64,70 60,70 C56,70 52,68 50,60 Z"));
    }
}
