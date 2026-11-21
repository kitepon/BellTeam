using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;

namespace BellTeam.App;

// a471-open-newest: the chat is laid out from its newest end. The view is never "scrolled to" a place: it is anchored either to the newest end (newest) or to one row at a fixed distance
// from the top of the view. Every layout pass puts the view where its anchor says, so opening, a new row, a sent bubble, a row that grows and an older page landing above need no scroll
// command and no catch-up; only the user's own scroll (SetVerticalOffset) changes the anchor. The scroll bar still sees an ordinary top-based offset.
public sealed class BottomAnchoredScroller : Decorator, IScrollInfo
{
    // The message rows: containers in item order. Set by the window; a row is anchored by its container.
    public ItemsControl? Rows { get; set; }
    private bool newest = true; private FrameworkElement? anchor; private double anchorTop;
    private double offset, extent, viewport, viewportWidth, bottomDistance;
    public BottomAnchoredScroller() { ClipToBounds = true; }

    public bool IsNewest => newest;
    // The Owner opened a conversation, sent a message, or pressed 「最新へ」.
    public void FollowNewest() { newest = true; anchor = null; InvalidateArrange(); }
    // Centre a row (a quote jump): the anchor becomes that row at the centre of the view.
    public void Reveal(FrameworkElement row) { anchor = row; anchorTop = Math.Max(0, (viewport - row.ActualHeight) / 2); newest = false; InvalidateArrange(); }

    protected override Size MeasureOverride(Size available)
    {
        Child?.Measure(new Size(available.Width, double.PositiveInfinity));
        return new Size(available.Width, double.IsInfinity(available.Height) ? Child?.DesiredSize.Height ?? 0 : available.Height);
    }

    protected override Size ArrangeOverride(Size finalSize)
    {
        if (Child is not { } child) return finalSize;
        var (oldExtent, oldViewport, oldOffset) = (extent, viewport, offset);
        var height = child.DesiredSize.Height; viewport = finalSize.Height; viewportWidth = finalSize.Width; extent = Math.Max(height, viewport);
        child.Arrange(new Rect(0, extent - height, finalSize.Width, height)); // at offset 0 first: this gives every row its place
        var max = extent - viewport;
        if (!newest && anchor is { } row && row.IsDescendantOf(child)) offset = row.TransformToAncestor(this).Transform(new Point(0, 0)).Y - anchorTop; // the arrangement is at offset 0 here
        else if (!newest) offset = max - bottomDistance; // the anchor row left the list: keep the distance from the newest end
        else offset = max;
        offset = Math.Clamp(offset, 0, max);
        if (offset >= max - 0.5) { newest = true; anchor = null; }
        bottomDistance = max - offset;
        child.Arrange(new Rect(0, extent - height - offset, finalSize.Width, height));
        if (extent != oldExtent || viewport != oldViewport || offset != oldOffset) ScrollOwner?.InvalidateScrollInfo();
        return finalSize;
    }

    // The user moved the view (wheel, bar, keys, ScrollToVerticalOffset): at the newest end it follows again, elsewhere it anchors to the first row still in view.
    public void SetVerticalOffset(double value)
    {
        var max = Math.Max(0, extent - viewport); value = Math.Clamp(value, 0, max);
        if (value >= max - 0.5) { FollowNewest(); ScrollOwner?.InvalidateScrollInfo(); return; }
        newest = false; anchor = null;
        if (Rows is { } rows && Child is { } child)
        {
            int low = 0, high = rows.Items.Count - 1;
            while (low <= high) // rows are in order: the first one whose bottom is below the top of the view is found by halving
            {
                var middle = (low + high) / 2;
                if (rows.ItemContainerGenerator.ContainerFromIndex(middle) is not FrameworkElement candidate || !candidate.IsDescendantOf(child)) break;
                var top = candidate.TransformToAncestor(this).Transform(new Point(0, 0)).Y + offset - value; // its place in the view after the move
                if (top + candidate.ActualHeight > 0) { anchor = candidate; anchorTop = top; high = middle - 1; } else low = middle + 1;
            }
        }
        offset = value; bottomDistance = max - value; InvalidateArrange(); ScrollOwner?.InvalidateScrollInfo();
    }

    public bool CanVerticallyScroll { get; set; } = true;
    public bool CanHorizontallyScroll { get; set; }
    public double ExtentWidth => viewportWidth;
    public double ExtentHeight => extent;
    public double ViewportWidth => viewportWidth;
    public double ViewportHeight => viewport;
    public double HorizontalOffset => 0;
    public double VerticalOffset => offset;
    public ScrollViewer? ScrollOwner { get; set; }
    public void LineUp() => SetVerticalOffset(offset - 16);
    public void LineDown() => SetVerticalOffset(offset + 16);
    public void PageUp() => SetVerticalOffset(offset - viewport);
    public void PageDown() => SetVerticalOffset(offset + viewport);
    public void MouseWheelUp() => SetVerticalOffset(offset - 48);
    public void MouseWheelDown() => SetVerticalOffset(offset + 48);
    public void LineLeft() { }
    public void LineRight() { }
    public void PageLeft() { }
    public void PageRight() { }
    public void MouseWheelLeft() { }
    public void MouseWheelRight() { }
    public void SetHorizontalOffset(double value) { }
    public Rect MakeVisible(Visual visual, Rect rectangle)
    {
        if (visual is not UIElement element || !element.IsDescendantOf(this)) return rectangle;
        var top = element.TransformToAncestor(this).Transform(rectangle.TopLeft).Y;
        if (top < 0) SetVerticalOffset(offset + top); else if (top + rectangle.Height > viewport) SetVerticalOffset(offset + top + rectangle.Height - viewport);
        return rectangle;
    }
}
