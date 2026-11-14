using Avalonia;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using BellTeam.Core;

namespace BellTeam.Linux;

public sealed class LatticeWindowTests
{
    // One 工程表 window per app; it reads only while shown; closing drops it so the next open is a fresh one.
    [Fact]
    public Task TheWindowIsSingleAndReadsOnlyWhileShown() => Ui.Run(async () =>
    {
        using var workspace = new LinuxWorkspace(origin => new BellApi(origin, new LatticeFixture("list")));
        await workspace.ConnectAsync("http://localhost", listen: false);
        var window = LatticeWindow.Open(workspace, _ => Task.CompletedTask);
        Assert.Same(window, LatticeWindow.Open(workspace, _ => Task.CompletedTask));
        Assert.Equal((1360, 860, 900, 600), (window.Width, window.Height, window.MinWidth, window.MinHeight));
        window.Sync();
        await Task.Delay(100);
        Assert.False(window.ListSettled);
        window.Show();
        for (var wait = 0; wait < 100 && !window.ListSettled; wait++) await Task.Delay(20);
        Assert.True(window.ListSettled);
        window.Close();
        Assert.NotSame(window, LatticeWindow.Open(workspace, _ => Task.CompletedTask));
        LatticeWindow.Current!.Close();
    });

    // 0/0 charts are not listed, and they do not count for the one-chart shortcut (screen-spec 一覧, task a107).
    [Theory]
    [InlineData("list", 5, false)]
    [InlineData("single", 0, true)]
    public Task ZeroChartsAreNotListed(string scene, int cards, bool opened) => Ui.Run(async () =>
    {
        using var workspace = new LinuxWorkspace(origin => new BellApi(origin, new LatticeFixture(scene)));
        await workspace.ConnectAsync("http://localhost", listen: false);
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask);
        window.Show();
        for (var wait = 0; wait < 100 && !window.ListSettled; wait++) await Task.Delay(20);
        window.UpdateLayout();
        Assert.Equal(cards, Avalonia.VisualTree.VisualExtensions.GetVisualDescendants(window).OfType<Avalonia.Controls.Button>().Count(button => Avalonia.Automation.AutomationProperties.GetAutomationId(button) == "lattice-chart-card"));
        Assert.Equal(opened, window.Chart is not null);
        window.Close();
    });

    // Fractions count only the counted cards off the wire (a96): t03 is a finished tree and leaves the ring, the tree root and its phase; t02 is hidden but counts.
    [Fact]
    public Task FractionsCountOnlyCountedCards() => Ui.Run(async () =>
    {
        using var workspace = new LinuxWorkspace(origin => new BellApi(origin, new LatticeFixture("chart")));
        await workspace.ConnectAsync("http://localhost", listen: false);
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask);
        window.Show(); window.OpenChart("lattice");
        for (var wait = 0; wait < 100 && window.Chart!.Feed.Snapshot is null; wait++) await Task.Delay(20);
        var snapshot = window.Chart!.Feed.Snapshot!;
        Assert.Equal((10, 2), (LatticeChart.Counts(snapshot).Total, LatticeChart.Counts(snapshot).Done));
        var node = LatticeChart.Tree(snapshot, "工程表").Nodes.ToDictionary(item => item.Key);
        Assert.Equal((2, 10), (node["root"].Done, node["root"].Total));
        Assert.Equal((2, 2), (node["phase:p1/ph1"].Done, node["phase:p1/ph1"].Total));
        window.Close();
    });

    // The card entrance, the change settle, the completion bloom and the card-to-detail morph start their animations on real controls (a wrong target type throws when the animation is applied).
    [Fact]
    public Task TheCardAnimationsStartOnTheirControls() => Ui.Run(async () =>
    {
        using var workspace = new LinuxWorkspace(origin => new BellApi(origin, new LatticeFixture("chart")));
        await workspace.ConnectAsync("http://localhost", listen: false);
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask);
        window.Show(); window.OpenChart("lattice");
        var chart = window.Chart!;
        for (var wait = 0; wait < 100 && chart.Feed.Snapshot is null; wait++) await Task.Delay(20);
        var snapshot = chart.Feed.Snapshot!;
        string[] ids = [.. snapshot.Cards.Select(card => card.Id)];
        chart.Board.Show(snapshot, new LatticeDiff(false, ids.Take(3).ToArray(), ids.Skip(3).Take(3).ToArray(), ids.Skip(6).Take(3).ToArray()), DateTimeOffset.UtcNow);
        window.UpdateLayout();
        chart.OpenDetail(ids[3]);
        await Task.Delay(50);
        Assert.Equal(ids[3], chart.SelectedCard);
        window.Close();
    });

    // 待ちの流れ starts folded to the right-edge handle (count red: a row waits on a blocked producer); the handle opens it, its close folds it, and the choice outlives the chart.
    [Fact]
    public Task TheWaitPanelStartsFoldedAndRemembersItsState() => Ui.Run(async () =>
    {
        using var workspace = new LinuxWorkspace(origin => new BellApi(origin, new LatticeFixture("chart")));
        await workspace.ConnectAsync("http://localhost", listen: false);
        LatticeChartPage.WaitsOpen = false;
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask);
        window.Show(); window.OpenChart("lattice");
        for (var wait = 0; wait < 100 && window.Chart!.Feed.Snapshot is null; wait++) await Task.Delay(20);
        Avalonia.Controls.Button? Find(string id) { window.UpdateLayout(); return Avalonia.VisualTree.VisualExtensions.GetVisualDescendants(window).OfType<Avalonia.Controls.Button>().FirstOrDefault(button => Avalonia.Automation.AutomationProperties.GetAutomationId(button) == id); }
        var handle = Find("lattice-waits-open");
        Assert.NotNull(handle); Assert.Null(Find("lattice-waits-close"));
        Assert.Equal("待ちの流れを開く、7件", Avalonia.Automation.AutomationProperties.GetName(handle!));
        handle!.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Avalonia.Controls.Button.ClickEvent));
        Assert.True(LatticeChartPage.WaitsOpen); Assert.NotNull(Find("lattice-waits-close")); Assert.Null(Find("lattice-waits-open"));
        window.ShowList(); window.OpenChart("lattice");
        for (var wait = 0; wait < 100 && window.Chart!.Feed.Snapshot is null; wait++) await Task.Delay(20);
        Find("lattice-waits-close")!.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Avalonia.Controls.Button.ClickEvent));
        Assert.False(LatticeChartPage.WaitsOpen); Assert.NotNull(Find("lattice-waits-open"));
        window.Close();
    });

    // The 相関図 window has the same single-instance and minimum-size contract (480x360 of graph).
    [Fact]
    public Task TheWorkGraphWindowIsSingleWithAMinimumSize() => Ui.Run(async () =>
    {
        using var workspace = new LinuxWorkspace();
        var window = WorkGraphWindow.Open(workspace, _ => Task.CompletedTask);
        Assert.Same(window, WorkGraphWindow.Open(workspace, _ => Task.CompletedTask));
        Assert.Equal((480, 360), (window.MinWidth, window.MinHeight));
        // A screen reader reads the canvas as the group 「相関図」 whose children are the members and requests (none yet).
        var peer = Avalonia.Automation.Peers.ControlAutomationPeer.CreatePeerForElement(window.Graph);
        Assert.Equal("相関図", peer.GetName());
        Assert.Empty(peer.GetChildren());
        window.Show(); window.Close();
        Assert.Null(WorkGraphWindow.Current);
        await Task.CompletedTask;
    });

    // The avatar's representative colour (Mac AvatarTone): a vivid picture gives its hue, a grey one gives none.
    [Fact]
    public Task AnAvatarsRepresentativeColourFollowsItsVividPixels() => Ui.Run(async () =>
    {
        static Bitmap Solid(byte red, byte green, byte blue)
        {
            var pixels = new byte[4 * 4 * 4];
            for (var i = 0; i < pixels.Length; i += 4) { pixels[i] = blue; pixels[i + 1] = green; pixels[i + 2] = red; pixels[i + 3] = 255; }
            var pin = System.Runtime.InteropServices.GCHandle.Alloc(pixels, System.Runtime.InteropServices.GCHandleType.Pinned);
            try { return new Bitmap(PixelFormat.Bgra8888, AlphaFormat.Unpremul, pin.AddrOfPinnedObject(), new PixelSize(4, 4), new Vector(96, 96), 16); } finally { pin.Free(); }
        }
        var red = WorkGraphColors.Representative(Solid(220, 30, 30));
        Assert.NotNull(red);
        Assert.True(red!.Value.R > red.Value.G * 2 && red.Value.R > red.Value.B * 2);
        Assert.Null(WorkGraphColors.Representative(Solid(128, 128, 128)));
        await Task.CompletedTask;
    });
}
