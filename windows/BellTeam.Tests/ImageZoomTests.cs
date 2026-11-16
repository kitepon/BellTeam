using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class ImageZoomTests
{
    private static ImageZoom Zoom() { var zoom = new ImageZoom(); zoom.Resize(1000, 600, 800, 600); return zoom; }

    [Fact]
    public void ZoomKeepsThePointUnderTheCursorAndStaysInTheScaleLimits()
    {
        var zoom = Zoom();
        zoom.ZoomAt(2, 100, 0);
        Assert.Equal((2, 0), (zoom.Scale, zoom.Y)); // centred rows cannot move: the 600 high picture at 2x overhangs 300 each side, the cursor is at y 0
        Assert.Equal(-100, zoom.X); // 100 - 100 * 2
        zoom.ZoomAt(100, 0, 0); Assert.Equal(ImageZoom.Max, zoom.Scale);
        zoom.ZoomAt(0.0001, 0, 0); Assert.Equal((ImageZoom.Min, 0, 0), (zoom.Scale, zoom.X, zoom.Y));
    }

    [Fact]
    public void PanIsClampedToTheOverhangAndImpossibleWhenTheWholePictureShows()
    {
        var zoom = Zoom();
        zoom.Pan(500, 500); Assert.Equal((0, 0), (zoom.X, zoom.Y));
        zoom.ZoomAt(2, 0, 0); zoom.Pan(9999, -9999);
        Assert.Equal((300, -300), (zoom.X, zoom.Y)); // (800*2-1000)/2 and (600*2-600)/2
    }

    [Fact]
    public void DoubleTapZoomsInThenBackToFit()
    {
        var zoom = Zoom();
        zoom.Toggle(0, 0); Assert.Equal(ImageZoom.DoubleTapScale, zoom.Scale);
        zoom.Toggle(0, 0); Assert.Equal((ImageZoom.Min, 0, 0), (zoom.Scale, zoom.X, zoom.Y));
    }

    [Fact]
    public void AResizeReclampsTheOffset()
    {
        var zoom = Zoom(); zoom.ZoomAt(2, 0, 0); zoom.Pan(300, 0);
        zoom.Resize(1600, 600, 800, 600);
        Assert.Equal(0, zoom.X);
    }
}
