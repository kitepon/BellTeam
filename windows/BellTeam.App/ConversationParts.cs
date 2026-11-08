using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace BellTeam.App;

// Mac ProgressView(.mini): a small arc turning once per 0.9 s. Only the transform animates, so layout is untouched.
public sealed class Spinner : FrameworkElement
{
    public static readonly DependencyProperty StrokeProperty = DependencyProperty.Register(nameof(Stroke), typeof(Brush), typeof(Spinner), new FrameworkPropertyMetadata(Brushes.Gray, FrameworkPropertyMetadataOptions.AffectsRender));
    public Brush Stroke { get => (Brush)GetValue(StrokeProperty); set => SetValue(StrokeProperty, value); }
    private readonly RotateTransform rotation = new();
    public Spinner()
    {
        Width = Height = 13; VerticalAlignment = VerticalAlignment.Center; IsHitTestVisible = false; RenderTransform = rotation; RenderTransformOrigin = new Point(.5, .5);
        Loaded += (_, _) => rotation.BeginAnimation(RotateTransform.AngleProperty, new DoubleAnimation(0, 360, TimeSpan.FromSeconds(.9)) { RepeatBehavior = RepeatBehavior.Forever });
        Unloaded += (_, _) => rotation.BeginAnimation(RotateTransform.AngleProperty, null);
    }
    protected override void OnRender(DrawingContext context)
    {
        var radius = Math.Min(ActualWidth, ActualHeight) / 2 - 1; var center = new Point(ActualWidth / 2, ActualHeight / 2);
        var start = new Point(center.X, center.Y - radius); var end = new Point(center.X - radius, center.Y); // three quarters of the circle
        var geometry = new PathGeometry([new PathFigure(start, [new ArcSegment(end, new Size(radius, radius), 0, true, SweepDirection.Clockwise, true)], false)]);
        context.DrawGeometry(null, new Pen(Stroke, 1.6) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round }, geometry);
    }
}

// Fills the row up to a cap. Its own width never depends on the child, so a narrower window shrinks it again.
public sealed class CappedRow : System.Windows.Controls.Decorator
{
    public const double Maximum = 900;
    protected override Size MeasureOverride(Size constraint)
    {
        if (Child is null) return default;
        var width = Math.Min(constraint.Width, Maximum); Child.Measure(new Size(width, constraint.Height));
        return new Size(width, Child.DesiredSize.Height);
    }
}

internal static class RoundClip
{
    // A Border does not clip its child to CornerRadius, so images and cards clip themselves.
    public static void Apply(FrameworkElement element, double radius) => element.SizeChanged += (_, args) => element.Clip = new RectangleGeometry(new Rect(0, 0, args.NewSize.Width, args.NewSize.Height), radius, radius);
}
