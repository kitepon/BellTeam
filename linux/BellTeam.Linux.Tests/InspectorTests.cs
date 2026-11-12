using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Input;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

public sealed class InspectorTests
{
    private static async Task<(MainWindow Window, LinuxWorkspace Workspace)> OpenAsync()
    {
        var workspace = new LinuxWorkspace(origin => new BellApi(origin, new FakeServer()));
        var window = new MainWindow(workspace, persistPlacement: false) { AutoRetry = false };
        window.Show();
        await window.ConnectAsync("http://localhost:1/");
        await workspace.SelectAsync(workspace.Entries.Single());
        Dispatcher.UIThread.RunJobs();
        return (window, workspace);
    }
    private static bool Shown(MainWindow window) => window.GetVisualDescendants().OfType<ProfileView>().Single().IsEffectivelyVisible;

    // The crop sheet hands the server JPEG data URLs: the render at the variant's side and the kept source (the part of Core that cannot be shared, the encoder is the UI's).
    [Fact]
    public Task TheCropSheetEncodesAJpegOfTheVariantsSideAndKeepsTheSource() => Ui.Run(async () =>
    {
        var image = Swatch(300, 200);
        var view = new AvatarCropView(image, AvatarVariant.Small, null, wantsSelection: true);
        var outcome = view.TryUse();
        Assert.NotNull(outcome);
        Assert.StartsWith("data:image/jpeg;base64,", outcome.DataUrl);
        var render = await AvatarHost.DecodeAsync(outcome.DataUrl);
        Assert.Equal(new PixelSize(512, 512), render.PixelSize);
        Assert.NotNull(outcome.Selection);
        Assert.StartsWith("data:image/jpeg;base64,", outcome.Selection!.Source);
        Assert.Equal(new PixelSize(300, 200), (await AvatarHost.DecodeAsync(outcome.Selection.Source)).PixelSize);
        // Zoomed in, the kept crop covers less of the image than the whole of it.
        view.ZoomSlider.Value = 2;
        Assert.True(view.TryUse()!.Selection!.Crop.Width < 1);
    });

    [Fact]
    public Task ARowHiddenInAGroupTakesItsSeparatorWithItAndTheFirstShownRowHasNone() => Ui.Run(() =>
    {
        var first = new Border(); var second = new Border(); var group = new FormGroup(first, second);
        group.SetVisible(first, false);
        var lines = group.GetVisualDescendants().OfType<Border>().Where(border => border.Height == 1).ToArray();
        Assert.All(lines, line => Assert.False(line.IsVisible)); // only the second row is shown, and it is the first shown
        group.SetVisible(first, true);
        Assert.Single(lines, line => line.IsVisible);
        return Task.CompletedTask;
    });

    [Fact]
    public Task TheInspectorFollowsTheSelectionAndTheCtrlShiftIToggle() => Ui.Run(async () =>
    {
        var (window, workspace) = await OpenAsync();
        Assert.True(Shown(window));
        Assert.Contains(window.GetVisualDescendants().OfType<Button>(), button => AutomationName(button) == "メンバーを編集");
        window.KeyPressQwerty(PhysicalKey.I, RawInputModifiers.Control | RawInputModifiers.Shift);
        Dispatcher.UIThread.RunJobs();
        Assert.False(Shown(window));
        window.KeyPressQwerty(PhysicalKey.I, RawInputModifiers.Control | RawInputModifiers.Shift);
        Dispatcher.UIThread.RunJobs();
        Assert.True(Shown(window));
        window.Close(); workspace.Dispose();
    });

    [Fact]
    public Task TheNewMemberSheetHasItsSavePillAndEscapeClosesIt() => Ui.Run(async () =>
    {
        var (window, workspace) = await OpenAsync();
        window.ShowMemberSheet(); await window.EditorReady;
        Dispatcher.UIThread.RunJobs();
        var editor = Assert.IsType<MemberEditorView>(window.OpenEditor);
        Assert.True(editor.CanSave);
        var save = window.GetVisualDescendants().OfType<Button>().Single(button => AutomationName(button) == "保存");
        Assert.True(save.IsEffectivelyVisible && save.IsEnabled);
        window.KeyPressQwerty(PhysicalKey.Escape, RawInputModifiers.None);
        Dispatcher.UIThread.RunJobs();
        Assert.Null(window.OpenEditor);
        window.Close(); workspace.Dispose();
    });

    private static string? AutomationName(Control control) => Avalonia.Automation.AutomationProperties.GetName(control);
    private static Bitmap Swatch(int width, int height)
    {
        var bitmap = new WriteableBitmap(new PixelSize(width, height), new Vector(96, 96), Avalonia.Platform.PixelFormat.Bgra8888, Avalonia.Platform.AlphaFormat.Opaque);
        using var buffer = bitmap.Lock();
        var row = new byte[width * 4]; for (var x = 0; x < width; x++) { row[x * 4] = (byte)(x % 256); row[x * 4 + 1] = 90; row[x * 4 + 2] = 200; row[x * 4 + 3] = 255; }
        for (var y = 0; y < height; y++) System.Runtime.InteropServices.Marshal.Copy(row, 0, buffer.Address + y * buffer.RowBytes, row.Length);
        return bitmap;
    }
}
