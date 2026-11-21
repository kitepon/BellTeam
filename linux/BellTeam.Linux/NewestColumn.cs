using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Presenters;
using Avalonia.VisualTree;

namespace BellTeam.Linux;

// a471-open-newest-linux: the newest row is the anchor of the conversation. While Following, the scroll offset is put at the end the moment the presenter learns a new extent or viewport,
// inside the layout loop that precedes the frame, so opening, a new row, a sent bubble, a refresh and an image that finished loading need no scroll command and no catch-up animation: the first frame shows the newest.
// Not Following (the reader moved up), nothing here moves the view; the scroll view's anchor (each MessageCard registers) keeps the row being read, so an older page above changes nothing on screen.
// Following ends when the reader moves the offset away from the end (wheel, key, drag, quote jump) and starts again when the reader reaches the end, opens a conversation, sends, or presses 最新へ.
internal sealed class NewestColumn : Grid
{
    public bool Following { get; private set; } = true;
    private ScrollContentPresenter? presenter;
    private bool pinning;
    private double lastOffset = double.NaN, lastExtent, lastViewport;

    // A request of the reader or the app to be at the newest.
    public void FollowNewest() { Following = true; Sync(); }

    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        presenter = this.GetVisualParent() as ScrollContentPresenter;
        if (presenter is not null) presenter.PropertyChanged += PresenterChanged;
        Sync();
    }
    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e)
    {
        if (presenter is not null) presenter.PropertyChanged -= PresenterChanged;
        presenter = null; lastOffset = double.NaN; base.OnDetachedFromVisualTree(e);
    }
    private void PresenterChanged(object? sender, AvaloniaPropertyChangedEventArgs e)
    {
        if (e.Property == ScrollContentPresenter.ExtentProperty || e.Property == ScrollContentPresenter.ViewportProperty || e.Property == ScrollContentPresenter.OffsetProperty) Sync();
    }

    private void Sync()
    {
        if (pinning || presenter is null) return;
        var extent = presenter.Extent.Height; var viewport = presenter.Viewport.Height; var offset = presenter.Offset.Y;
        // An offset we did not leave is the reader's (or the anchor's). A smaller extent only clamps it to the new end, which says nothing about where the reader is.
        if (!double.IsNaN(lastOffset) && Math.Abs(offset - Math.Min(lastOffset, Math.Max(0, extent - viewport))) > 0.5) Following = offset >= lastExtent - lastViewport - 1;
        if (Following)
        {
            var end = Math.Max(0, extent - viewport);
            if (Math.Abs(offset - end) > 0.5) { pinning = true; try { presenter.SetCurrentValue(ScrollContentPresenter.OffsetProperty, new Vector(presenter.Offset.X, end)); } finally { pinning = false; } offset = presenter.Offset.Y; }
        }
        lastOffset = offset; lastExtent = extent; lastViewport = viewport;
    }
}
