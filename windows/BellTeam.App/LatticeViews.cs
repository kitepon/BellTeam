using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using BellTeam.Core;

namespace BellTeam.App;

/// <summary>Colors, shapes and small parts of the 工程表 window (screen-spec.md "Colors", "Card states"). Light only, like the rest of this app.</summary>
internal static class LatticeLook
{
    public static readonly Color Ink = Color.FromRgb(0x21, 0x29, 0x3D), Muted = Color.FromRgb(0x78, 0x7D, 0x91), Line = Color.FromRgb(0xE5, 0xE3, 0xF0),
        Violet = Color.FromRgb(0x61, 0x47, 0xD4), Red = Color.FromRgb(0xE0, 0x53, 0x3D), Done = Color.FromRgb(0x5E, 0x8F, 0x7E), Amber = Color.FromRgb(0xB8, 0x6E, 0x00), Slate = Color.FromRgb(0x4A, 0x5B, 0x70);
    public static SolidColorBrush Brush(Color color, byte alpha = 255) { var brush = new SolidColorBrush(Color.FromArgb(alpha, color.R, color.G, color.B)); brush.Freeze(); return brush; }
    public static Color Accent(string? color) => BellColors.Accent(color);
    public static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");
    // Motion is off when Windows' "Animation effects" is off (screen-spec "Reduce Motion": no particles, no rotation, no bloom; cross-fade only).
    public static bool Motion => SystemParameters.ClientAreaAnimation;
    // The spec's spring(response 0.45, damping 0.82) as a cubic ease, and the 300 ms entry.
    public static IEasingFunction Spring { get; } = Frozen(new CubicEase { EasingMode = EasingMode.EaseOut });
    private static IEasingFunction Frozen(CubicEase ease) { ease.Freeze(); return ease; }

    /// <summary>Frosted glass over the window backdrop: a translucent white sheet with a light rim and a soft shadow.</summary>
    public static Border Glass(UIElement? child = null, double radius = 16, Thickness? padding = null, byte alpha = 0xD9) => new()
    {
        Child = child, CornerRadius = new CornerRadius(radius), Padding = padding ?? new Thickness(14), Background = Brush(Colors.White, alpha),
        BorderBrush = Brush(Colors.White, 0xF0), BorderThickness = new Thickness(1),
        Effect = new System.Windows.Media.Effects.DropShadowEffect { Color = Ink, Opacity = .07, BlurRadius = 22, ShadowDepth = 6, Direction = 270 }
    };
    public static TextBlock Text(string text, double size = 14, Color? color = null, FontWeight? weight = null, TextWrapping wrap = TextWrapping.NoWrap) => new()
    {
        Text = text, FontSize = size, Foreground = Brush(color ?? Ink), FontWeight = weight ?? FontWeights.Normal, TextWrapping = wrap, TextTrimming = wrap == TextWrapping.NoWrap ? TextTrimming.CharacterEllipsis : TextTrimming.None, VerticalAlignment = VerticalAlignment.Center
    };
    public static TextBlock Icon(string glyph, double size, Color color) => new() { Text = glyph, FontFamily = Icons, FontSize = size, Foreground = Brush(color), VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
    public static Border Pill(UIElement child, Color tint, byte alpha = 0x1F, Thickness? padding = null) => new() { Child = child, Background = Brush(tint, alpha), CornerRadius = new CornerRadius(99), Padding = padding ?? new Thickness(10, 4, 10, 4), VerticalAlignment = VerticalAlignment.Center };
    public static StackPanel Row(params UIElement[] children) { var row = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center }; foreach (var child in children) row.Children.Add(child); return row; }
    public static Button Action(string label, string glyph, bool primary = false)
    {
        var button = new Button { Content = label, Tag = glyph, FontSize = 13, Padding = new Thickness(11, 6, 11, 6), Margin = new Thickness(0, 0, 8, 0) };
        if (Application.Current?.TryFindResource(primary ? "PrimaryButton" : typeof(Button)) is Style style) button.Style = style;
        return button;
    }
    /// <summary>A button that draws only its content (cards, rail items, list cards): keyboard focus, Enter/Space and the accessibility name come from Button.</summary>
    public static Button Plain(UIElement content, string name)
    {
        var button = new Button { Content = content, Template = PlainTemplate, Cursor = System.Windows.Input.Cursors.Hand, FocusVisualStyle = FocusRing, Padding = new Thickness(0), Margin = new Thickness(0), Background = Brushes.Transparent, BorderThickness = new Thickness(0) };
        System.Windows.Automation.AutomationProperties.SetName(button, name);
        return button;
    }
    private static readonly ControlTemplate PlainTemplate = Template();
    private static ControlTemplate Template()
    {
        var template = new ControlTemplate(typeof(Button)); var presenter = new FrameworkElementFactory(typeof(ContentPresenter)); template.VisualTree = presenter; template.Seal(); return template;
    }
    private static readonly Style FocusRing = Ring();
    private static Style Ring()
    {
        var factory = new FrameworkElementFactory(typeof(Border));
        factory.SetValue(Border.BorderBrushProperty, Brush(Violet)); factory.SetValue(Border.BorderThicknessProperty, new Thickness(2)); factory.SetValue(Border.CornerRadiusProperty, new CornerRadius(14)); factory.SetValue(Border.MarginProperty, new Thickness(-3));
        var style = new Style(typeof(Control)); style.Setters.Add(new Setter(Control.TemplateProperty, new ControlTemplate(typeof(Control)) { VisualTree = factory })); style.Seal(); return style;
    }

    public static Geometry CrownGeometry { get; } = Freeze(Geometry.Parse("M1,11 L2.6,3.6 L6.6,7.2 L10,1.4 L13.4,7.2 L17.4,3.6 L19,11 Z M1.6,12.6 H18.4 V14.6 H1.6 Z"));
    public static Geometry HourglassGeometry { get; } = Freeze(Geometry.Parse("M0,0 H10 V1.6 L6.4,5 L10,8.4 V10 H0 V8.4 L3.6,5 L0,1.6 Z"));
    public static Geometry OctagonGeometry { get; } = Freeze(Geometry.Parse("M4.1,0 H9.9 L14,4.1 V9.9 L9.9,14 H4.1 L0,9.9 V4.1 Z"));
    private static Geometry Freeze(Geometry geometry) { geometry.Freeze(); return geometry; }
    public static Path Shape(Geometry geometry, double size, Color color) => new() { Data = geometry, Fill = Brush(color), Width = size, Height = size, Stretch = Stretch.Uniform, VerticalAlignment = VerticalAlignment.Center };
    public static UIElement Crown(double size = 15) => Shape(CrownGeometry, size, Color.FromRgb(0xD9, 0x9A, 0x1E));
    public static Border CoordinatorBadge() => Pill(Row(Crown(13), Spaced(Text("統括", 12, Color.FromRgb(0x9A, 0x63, 0x00), FontWeights.SemiBold), 5)), Color.FromRgb(0xF5, 0xB7, 0x2E), 0x2E, new Thickness(8, 3, 9, 3));
    public static T Spaced<T>(T element, double left) where T : FrameworkElement { element.Margin = new Thickness(left, 0, 0, 0); return element; }

    /// <summary>State glyph: dashed circle, play, working arc, octagon exclamation, seal check, archive. Color never carries a state alone: the badge text is always beside it.</summary>
    public static FrameworkElement StateGlyph(string state, double size, Color accent)
    {
        switch (state)
        {
            case "ready": return Icon("", size * .8, accent);
            case "in-progress": return Arc(size, accent, 1.8);
            case "blocked":
                var octagon = new Grid { Width = size, Height = size, VerticalAlignment = VerticalAlignment.Center };
                octagon.Children.Add(Shape(OctagonGeometry, size, Red)); octagon.Children.Add(new TextBlock { Text = "!", FontSize = size * .72, FontWeight = FontWeights.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, -size * .08, 0, 0) });
                if (Motion) octagon.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(1, .45, TimeSpan.FromMilliseconds(900)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, EasingFunction = new SineEase() });
                return octagon;
            case "done": return Icon("", size * .9, Done);
            case "retired": return Icon("", size * .8, Muted);
            default: return new Ellipse { Width = size * .82, Height = size * .82, Stroke = Brush(Muted), StrokeThickness = 1.4, StrokeDashArray = [2, 1.6], VerticalAlignment = VerticalAlignment.Center };
        }
    }
    /// <summary>The working arc: a quarter-open ring turning once every 8 s (still when motion is off).</summary>
    public static FrameworkElement Arc(double size, Color color, double thickness)
    {
        var radius = (size - thickness) / 2; var center = size / 2;
        var figure = new PathFigure { StartPoint = new Point(center, center - radius) };
        figure.Segments.Add(new ArcSegment(new Point(center - radius, center), new Size(radius, radius), 0, true, SweepDirection.Clockwise, true));
        var track = new Ellipse { Width = size, Height = size, Stroke = Brush(color, 0x33), StrokeThickness = thickness };
        var arc = new Path { Data = new PathGeometry([figure]), Stroke = Brush(color), StrokeThickness = thickness, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, Width = size, Height = size, RenderTransformOrigin = new Point(.5, .5) };
        var rotate = new RotateTransform(); arc.RenderTransform = rotate;
        if (Motion) rotate.BeginAnimation(RotateTransform.AngleProperty, new DoubleAnimation(0, 360, TimeSpan.FromSeconds(8)) { RepeatBehavior = RepeatBehavior.Forever });
        var grid = new Grid { Width = size, Height = size, VerticalAlignment = VerticalAlignment.Center, IsHitTestVisible = false }; grid.Children.Add(track); grid.Children.Add(arc); return grid;
    }
    public static FrameworkElement Spinner(double size = 14) => Arc(size, Violet, 2);
}

/// <summary>A member's face: the avatar image when the roster has one, else the initial on the accent; an authored lane text's initial on grey; 「?」 for 名簿にないメンバー and 「–」 for 担当なし.</summary>
internal sealed class LatticeAvatar : Grid
{
    public LatticeAvatar(LatticePerson? person, double size, Func<string, string, Task<System.Windows.Media.Imaging.BitmapSource>>? load)
    {
        Width = Height = size; VerticalAlignment = VerticalAlignment.Center; IsHitTestVisible = false;
        var accent = person is { Known: true } ? LatticeLook.Accent(person.Color) : Color.FromRgb(0xA4, 0xA7, 0xB6);
        var face = new Border { CornerRadius = new CornerRadius(size * .31), Background = new LinearGradientBrush(Color.FromArgb(190, accent.R, accent.G, accent.B), accent, 45), BorderBrush = Brushes.White, BorderThickness = new Thickness(size > 30 ? 2 : 1.5) };
        var initial = person is null ? "–" : !person.Known && !person.Authored ? "?" : person.Name.Length > 0 ? person.Name[..1] : "?";
        face.Child = new TextBlock { Text = initial, FontSize = size * .42, FontWeight = FontWeights.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        Children.Add(face);
        System.Windows.Automation.AutomationProperties.SetName(this, LatticeChart.NameOf(person));
        if (person is { Known: true, AvatarVersion.Length: > 0 } && load is not null) _ = LoadAsync(person, size, face, load);
    }
    private static async Task LoadAsync(LatticePerson person, double size, Border face, Func<string, string, Task<System.Windows.Media.Imaging.BitmapSource>> load)
    {
        // An image that cannot be read keeps the initial: the face still names the member.
        try { var image = await load(person.BotId, person.AvatarVersion); face.Background = new ImageBrush(image) { Stretch = Stretch.UniformToFill }; ((TextBlock)face.Child).Text = ""; }
        catch (Exception) { }
    }
}

/// <summary>The progress ring: done / total around, the count in the middle.</summary>
internal sealed class LatticeRing : FrameworkElement
{
    private readonly double fraction; private readonly string label; private readonly double size;
    public LatticeRing(int done, int total, double size, bool showLabel = true)
    {
        fraction = total > 0 ? Math.Min(1, (double)done / total) : 0; label = showLabel ? $"{done}/{total}" : ""; this.size = size; Width = Height = size; VerticalAlignment = VerticalAlignment.Center;
        System.Windows.Automation.AutomationProperties.SetName(this, $"完了 {done}/{total}");
    }
    protected override void OnRender(DrawingContext context)
    {
        var thickness = Math.Max(3, size / 10); var radius = (size - thickness) / 2; var center = new Point(size / 2, size / 2);
        context.DrawEllipse(null, new Pen(LatticeLook.Brush(LatticeLook.Violet, 0x24), thickness), center, radius, radius);
        if (fraction > 0)
        {
            var angle = Math.Min(359.99, fraction * 360) * Math.PI / 180; var end = new Point(center.X + radius * Math.Sin(angle), center.Y - radius * Math.Cos(angle));
            var figure = new PathFigure { StartPoint = new Point(center.X, center.Y - radius) }; figure.Segments.Add(new ArcSegment(end, new Size(radius, radius), 0, fraction > .5, SweepDirection.Clockwise, true));
            context.DrawGeometry(null, new Pen(new LinearGradientBrush(Color.FromRgb(0x8B, 0x6C, 0xF0), LatticeLook.Violet, 90), thickness) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round }, new PathGeometry([figure]));
        }
        if (label.Length == 0) return;
        FormattedText Label(double em) => new(label, System.Globalization.CultureInfo.CurrentUICulture, FlowDirection.LeftToRight, new Typeface(new FontFamily("Yu Gothic UI"), FontStyles.Normal, FontWeights.SemiBold, FontStretches.Normal), em, LatticeLook.Brush(LatticeLook.Ink), VisualTreeHelper.GetDpi(this).PixelsPerDip);
        // As the Mac's minimumScaleFactor(0.6): a long count shrinks to fit inside the ring instead of spilling over it.
        var em = Math.Max(9, size * .27); var text = Label(em); var inside = 2 * radius - thickness - 2;
        if (text.Width > inside) text = Label(em * Math.Max(.6, inside / text.Width));
        context.DrawText(text, new Point(center.X - text.Width / 2, center.Y - text.Height / 2));
    }
}

/// <summary>A closed bud (unavailable chart): a stem, a leaf and a bud that has not opened yet.</summary>
internal sealed class LatticeBud : FrameworkElement
{
    public LatticeBud() { Width = 120; Height = 120; HorizontalAlignment = HorizontalAlignment.Center; }
    protected override void OnRender(DrawingContext context)
    {
        var green = Color.FromRgb(0x6F, 0xA8, 0x8E);
        context.DrawEllipse(LatticeLook.Brush(LatticeLook.Violet, 0x14), null, new Point(60, 64), 56, 56);
        context.DrawGeometry(null, new Pen(LatticeLook.Brush(green), 3) { StartLineCap = PenLineCap.Round }, Geometry.Parse("M60,104 C60,88 59,76 60,62"));
        context.DrawGeometry(LatticeLook.Brush(green, 0xCC), null, Geometry.Parse("M60,90 C70,78 84,80 88,84 C80,94 68,94 60,90 Z"));
        context.DrawGeometry(new LinearGradientBrush(Color.FromRgb(0xC9, 0xB8, 0xFF), LatticeLook.Violet, 90), null, Geometry.Parse("M60,24 C72,36 76,50 68,62 C64,66 56,66 52,62 C44,50 48,36 60,24 Z"));
        context.DrawGeometry(LatticeLook.Brush(green), null, Geometry.Parse("M50,60 C54,66 66,66 70,60 C68,68 64,70 60,70 C56,70 52,68 50,60 Z"));
    }
}
