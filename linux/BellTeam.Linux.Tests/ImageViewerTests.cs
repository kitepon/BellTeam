using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using BellTeam.Core;

namespace BellTeam.Linux;

public sealed class ImageViewerTests
{
    private static readonly Size Pane = new(800, 600);
    private static readonly PixelSize Wide = new(1600, 600); // fits at 0.5 -> shown 800x300
    private static readonly byte[] Png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0, 114, 182, 13, 36, 0, 0, 0, 22, 73, 68, 65, 84, 120, 156, 99, 120, 54, 109, 203, 255, 105, 251, 46, 253, 103, 0, 17, 32, 14, 0, 112, 66, 12, 169, 254, 53, 102, 152, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];

    [Fact]
    public void ThePictureIsShownFittedAndNeverZoomsOutBelowThat()
    {
        var shown = ZoomView.Displayed(Pane, Wide);
        Assert.Equal(new Size(800, 300), shown);
        Assert.Equal(ZoomView.Fit, ZoomView.Fit.ZoomAt(.5, default, shown, Pane));
    }

    [Fact]
    public void ZoomingKeepsThePointUnderThePointerAndStopsAtTheMaximum()
    {
        var shown = ZoomView.Displayed(Pane, Wide);
        var anchor = new Point(200, 0); // 200 right of the centre
        var zoomed = ZoomView.Fit.ZoomAt(2, anchor, shown, Pane);
        Assert.Equal(2, zoomed.Scale);
        Assert.Equal(-200, zoomed.Offset.X); // the picture point at +200 stays at +200: 2*200 + offset = 200
        Assert.Equal(0, zoomed.Offset.Y);    // 2x of 300 = 600 fits the pane height, so no vertical pan
        Assert.Equal(ZoomView.Max, zoomed.ZoomAt(100, anchor, shown, Pane).Scale);
        Assert.Equal(ZoomView.Fit, zoomed.ZoomAt(.1, anchor, shown, Pane));
    }

    [Fact]
    public void PanningStaysInsideThePicture()
    {
        var shown = ZoomView.Displayed(Pane, Wide);
        var zoomed = ZoomView.Fit.ZoomAt(2, default, shown, Pane); // shown 1600 wide in an 800 pane: 400 to each side
        Assert.Equal(400, zoomed.Pan(new Vector(900, 900), shown, Pane).Offset.X);
        Assert.Equal(0, zoomed.Pan(new Vector(900, 900), shown, Pane).Offset.Y);
        Assert.Equal(ZoomView.Fit, ZoomView.Fit.Pan(new Vector(50, 50), shown, Pane));
    }

    [Fact]
    public void ActualSizeIsOnePixelPerPixelButAtLeastTwo()
    {
        Assert.Equal(2, ZoomView.ActualSize(ZoomView.Displayed(Pane, Wide), Wide));
        var big = new PixelSize(4000, 3000);
        Assert.Equal(5, ZoomView.ActualSize(ZoomView.Displayed(Pane, big), big));
        Assert.Equal(ZoomView.Max, ZoomView.ActualSize(ZoomView.Displayed(Pane, new PixelSize(16000, 12000)), new PixelSize(16000, 12000)));
    }

    [Theory]
    [InlineData("/api/message-images/owner/abc.png", "abc.png")]
    [InlineData("/api/message-images/owner/abc.png?download=1", "abc.png")]
    [InlineData("/api/message-images/owner/abc.jpg", "abc.png")]   // the bytes are a PNG: the extension follows the type
    [InlineData("/api/message-images/owner/", "image.png")]
    public void TheSavedNameIsTheUrlsLastSegmentWithTheExtensionOfTheBytes(string path, string expected) => Assert.Equal(expected, ImageActions.FileName(path, Png));

    [Fact]
    public async Task OpenWithWritesTheOriginalBytesAndReportsAFailedOpener()
    {
        string? opened = null;
        await ImageActions.OpenWithAsync("viewer-test.png", Png, file => { opened = file; return Task.FromResult(0); });
        Assert.Equal(Png, await File.ReadAllBytesAsync(opened!));
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => ImageActions.OpenWithAsync("viewer-test.png", Png, _ => Task.FromResult(3)));
        Assert.Equal(ImageActions.OpenWithMissing, error.Message);   // exit code 3: no app for the type; the tool name and the code stay out of the words
        Assert.DoesNotContain("xdg-open", error.Message);
        Assert.Equal(ImageActions.OpenWithFailed, (await Assert.ThrowsAsync<InvalidOperationException>(() => ImageActions.OpenWithAsync("viewer-test.png", Png, _ => Task.FromResult(4)))).Message);
    }

    [Fact]
    public Task TheGalleryZoomsWithItsKeysAndShowsTheHeaderActions() => Ui.Run(async () =>
    {
        using var workspace = new LinuxWorkspace(); workspace.LoadPreview();
        var closed = false; var gallery = new ImageGallery(workspace, ["/api/message-images/owner/a.png"], 0, () => closed = true);
        var window = new Window { Width = 800, Height = 600, Content = gallery }; window.Show();
        var pane = gallery.Pane!; await pane.Image.LoadTask; await Avalonia.Threading.Dispatcher.UIThread.InvokeAsync(() => { }, Avalonia.Threading.DispatcherPriority.Loaded);
        Assert.True(gallery.HandleKey(Key.OemPlus)); Assert.True(pane.View.Scale > 1);
        Assert.True(gallery.HandleKey(Key.D0)); Assert.Equal(ZoomView.Fit, pane.View);
        Assert.False(gallery.HandleKey(Key.X)); Assert.True(gallery.HandleKey(Key.Escape)); Assert.True(closed);
        window.Close();
    });
}
