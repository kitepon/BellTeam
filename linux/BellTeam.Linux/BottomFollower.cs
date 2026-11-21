using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Threading;

namespace BellTeam.Linux;

// a471-scroll-jump-linux: a row that arrives while the reader is at the bottom is followed by an animated scroll, at most Step px per frame (the Web's rule), never a snap.
// With motion off it is instant; the reader's wheel, touch, drag or key stops the following.
// shortcut: a 16 ms timer stands for the display frame; upgrade to the compositor's frame clock if the pace shows on a 120 Hz screen.
internal sealed class BottomFollower
{
    public const double Step = 33;
    public static Func<bool> MotionOn { get; set; } = () => LatticeLook.Motion;
    private readonly ScrollViewer scroll;
    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromMilliseconds(16) };
    private double expected = double.NaN;   // where the last step left the view; a different offset means the reader moved it

    public BottomFollower(ScrollViewer scroll)
    {
        this.scroll = scroll; timer.Tick += (_, _) => Tick();
        scroll.AddHandler(InputElement.PointerWheelChangedEvent, (_, _) => Stop(), handledEventsToo: true);
        scroll.AddHandler(InputElement.PointerPressedEvent, (_, _) => Stop(), handledEventsToo: true);
        scroll.AddHandler(InputElement.KeyDownEvent, (_, _) => Stop(), handledEventsToo: true);
    }

    // ScrollViewer.ScrollToEnd() leaves the view stuck to the end: rows that arrive later move it at once, which is the snap. A plain offset is not sticky.
    public static void SnapToEnd(ScrollViewer scroll) => scroll.Offset = new Vector(0, Math.Max(0, scroll.Extent.Height - scroll.Viewport.Height));

    public void Follow()
    {
        if (!MotionOn()) { Stop(); SnapToEnd(scroll); return; }
        if (!timer.IsEnabled) { expected = double.NaN; timer.Start(); }
    }

    public void Stop() { timer.Stop(); expected = double.NaN; }

    private void Tick()
    {
        var y = scroll.Offset.Y;
        if (!double.IsNaN(expected) && Math.Abs(y - expected) > 1) { Stop(); return; }
        var target = Math.Max(0, scroll.Extent.Height - scroll.Viewport.Height);
        if (target - y <= 0.5) { Stop(); return; }
        scroll.Offset = new Vector(0, Math.Min(target, y + Step)); expected = scroll.Offset.Y;
    }
}
