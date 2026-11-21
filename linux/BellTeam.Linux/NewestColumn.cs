using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Presenters;
using Avalonia.Threading;
using Avalonia.VisualTree;

namespace BellTeam.Linux;

// a471-open-newest-linux: the newest row is the anchor of the conversation. While Following, the scroll offset is put at the end the moment the presenter learns a new extent or viewport,
// inside the layout loop that precedes the frame, so opening, a new row, a sent bubble, a refresh and an image that finished loading need no scroll command and no catch-up animation: the first frame shows the newest.
// Not Following (the reader moved up), nothing here moves the view; the scroll view's anchor (each MessageCard registers) keeps the row being read, so an older page above changes nothing on screen.
// Following ends when the reader moves the offset away from the end (wheel, key, touch, drag, quote jump) and starts again when the reader reaches the end, opens a conversation, sends, or presses 最新へ.
// An offset that changes while the layout is still changing (the anchor's shift, a clamp) is the layout's, never the reader's: only a move on a settled layout counts.
internal sealed class NewestColumn : Grid
{
    public bool Following { get; private set; } = true;
    private ScrollContentPresenter? presenter;
    private bool pinning, settling;
    private double lastOffset = double.NaN;

    // A request of the reader or the app to be at the newest.
    public void FollowNewest() { Following = true; Sync(false); }

    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        presenter = this.GetVisualParent() as ScrollContentPresenter;
        if (presenter is not null) presenter.PropertyChanged += PresenterChanged;
        Sync(false);
    }
    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e)
    {
        if (presenter is not null) presenter.PropertyChanged -= PresenterChanged;
        presenter = null; lastOffset = double.NaN; base.OnDetachedFromVisualTree(e);
    }
    private void PresenterChanged(object? sender, AvaloniaPropertyChangedEventArgs e)
    {
        if (e.Property == ScrollContentPresenter.OffsetProperty) Sync(true);
        else if (e.Property == ScrollContentPresenter.ExtentProperty || e.Property == ScrollContentPresenter.ViewportProperty) Sync(false);
    }

    private void Sync(bool offsetChanged)
    {
        if (pinning || presenter is null) return;
        var extent = presenter.Extent.Height; var viewport = presenter.Viewport.Height; var offset = presenter.Offset.Y;
        if (offsetChanged && !settling && !double.IsNaN(lastOffset) && Math.Abs(offset - lastOffset) > 0.5) Following = offset >= extent - viewport - 1;
        if (!offsetChanged && !settling) { settling = true; Dispatcher.UIThread.Post(() => { settling = false; if (presenter is not null) lastOffset = presenter.Offset.Y; }, DispatcherPriority.Background); }
        if (Following)
        {
            var end = Math.Max(0, extent - viewport);
            if (Math.Abs(offset - end) > 0.5) { pinning = true; try { presenter.SetCurrentValue(ScrollContentPresenter.OffsetProperty, new Vector(presenter.Offset.X, end)); } finally { pinning = false; } offset = presenter.Offset.Y; }
        }
        lastOffset = offset;
    }
}
