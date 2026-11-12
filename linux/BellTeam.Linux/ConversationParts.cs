using Avalonia;
using Avalonia.Animation;
using Avalonia.Controls;
using Avalonia.Controls.Shapes;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Styling;

namespace BellTeam.Linux;

// Mac ProgressView(.mini): a small arc turning once per 0.9 s. Only the transform animates, so layout is untouched.
public sealed class Spinner : Decorator
{
    private CancellationTokenSource? turning;
    public Spinner(IBrush stroke, double size = 13)
    {
        Width = Height = size; VerticalAlignment = VerticalAlignment.Center; IsHitTestVisible = false; RenderTransformOrigin = RelativePoint.Center;
        Child = new Arc { StartAngle = -90, SweepAngle = 270, Stroke = stroke, StrokeThickness = 1.6, StrokeLineCap = PenLineCap.Round, Margin = new Thickness(1) };
    }
    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        var animation = new Animation
        {
            Duration = TimeSpan.FromSeconds(.9), IterationCount = IterationCount.Infinite,
            Children = { new KeyFrame { Cue = new Cue(0), Setters = { new Setter(RotateTransform.AngleProperty, 0.0) } }, new KeyFrame { Cue = new Cue(1), Setters = { new Setter(RotateTransform.AngleProperty, 360.0) } } }
        };
        turning = new CancellationTokenSource(); _ = animation.RunAsync(this, turning.Token);
    }
    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e) { turning?.Cancel(); turning?.Dispose(); turning = null; base.OnDetachedFromVisualTree(e); }
}

// Fills the row up to a cap. Its own width never depends on the child, so a narrower window shrinks it again.
public sealed class CappedRow : Decorator
{
    public const double Maximum = 900;
    protected override Size MeasureOverride(Size availableSize)
    {
        if (Child is null) return default;
        var width = Math.Min(availableSize.Width, Maximum); Child.Measure(new Size(width, availableSize.Height));
        return new Size(width, Child.DesiredSize.Height);
    }
    protected override Size ArrangeOverride(Size finalSize) { Child?.Arrange(new Rect(finalSize)); return finalSize; }
}

internal static class Round
{
    // A rounded frame that clips its child to the corners (images and cards).
    public static Border Clip(Control child, double radius) => new() { Child = child, CornerRadius = new CornerRadius(radius), ClipToBounds = true };
}
