using Avalonia.Controls;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// The 決裁箱 window over ApprovalsFixture: the real API reads, hub and feed. Core's `Approvals` words are tested in BellTeam.Tests/ApprovalsTests.cs.
public sealed class ApprovalsWindowTests
{
    private static async Task<(LinuxWorkspace Workspace, ApprovalsHub Hub, ApprovalsWindow Window)> OpenAsync(string scene)
    {
        var workspace = new LinuxWorkspace(origin => new BellApi(origin, new ApprovalsFixture(scene)));
        await workspace.ConnectAsync("http://localhost", listen: false);
        var hub = new ApprovalsHub(workspace); hub.Sync();
        var window = new ApprovalsWindow(hub, workspace, (_, _) => { }, _ => { });
        window.Show();
        for (var wait = 0; wait < 200 && !window.Settled; wait++) await Task.Delay(20);
        Assert.True(window.Settled);
        return (workspace, hub, window);
    }
    private static Button? Find(ApprovalsWindow window, string name) { window.UpdateLayout(); return window.GetVisualDescendants().OfType<Button>().FirstOrDefault(button => Avalonia.Automation.AutomationProperties.GetName(button) == name); }

    [Fact]
    public Task AnAnswerGoesThroughTheConfirmStepAndLeavesTheOpenList() => Ui.Run(async () =>
    {
        var (workspace, hub, window) = await OpenAsync("main");
        try
        {
            Assert.Equal(4, hub.Feed!.Summary!.Pending);
            await window.PreviewAsync("pending", "K-1", null);
            Assert.NotNull(Find(window, "決裁箱と同じ請求にする、推奨"));
            Assert.Null(Find(window, "答える"));                           // an option never answers by itself
            Find(window, "決裁箱と同じ請求にする、推奨")!.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
            Assert.NotNull(Find(window, "答える"));                        // the confirm step
            Find(window, "やめる")!.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
            Assert.Null(Find(window, "答える"));
            await window.PreviewAsync("pending", "K-1", 0);
            Find(window, "答える")!.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
            for (var wait = 0; wait < 100 && window.Selected is { Status: "pending" }; wait++) await Task.Delay(20);
            Assert.Equal("answered", window.Selected!.Status);
            Assert.Equal("delivered", window.Selected.Delivery);
        }
        finally { window.Close(); hub.Dispose(); workspace.Dispose(); }
    });

    [Fact]
    public Task WithoutAConnectionTheWindowOffersToConnect() => Ui.Run(async () =>
    {
        var (workspace, hub, window) = await OpenAsync("not-connected");
        try
        {
            Assert.Equal(ApprovalFeedStatus.NoCredential, hub.Feed!.Status);
            Assert.NotNull(Find(window, "決裁箱につなぐ"));
            Assert.NotNull(Find(window, "読み直す"));
            Assert.False(hub.Feed.Running);                                 // no timer: it leaves by 読み直す
        }
        finally { window.Close(); hub.Dispose(); workspace.Dispose(); }
    });

    [Fact]
    public Task AnExternalDecisionIsListedAndAnswerableAndTheOriginFilterKeepsTheFullCounts() => Ui.Run(async () =>
    {
        var (workspace, hub, window) = await OpenAsync("external");
        try
        {
            await window.PreviewAsync("pending", "K-3", null);
            Assert.Equal("K-3", window.SelectedId);
            Assert.NotNull(Find(window, "共有フォルダに保存する"));
            Assert.NotNull(Find(window, "すべて 4件")); Assert.NotNull(Find(window, "BellTeam 2件")); Assert.NotNull(Find(window, "外部 2件"));
        }
        finally { window.Close(); hub.Dispose(); workspace.Dispose(); }
    });
}
