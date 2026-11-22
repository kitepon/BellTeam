using Avalonia.Controls;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// After the server refuses an answer with 409 answer_on_device the card shows the line and no 答える or 保留 (a second try would only be refused again; Delta's review).
public sealed class ApprovalsOnDeviceCardTests
{
    private static bool Has(Window w, string text) { w.UpdateLayout(); return w.GetVisualDescendants().OfType<TextBlock>().Any(t => (t.Text ?? "").Contains(text, StringComparison.Ordinal)); }
    private static Button? Find(Window w, string name) { w.UpdateLayout(); return w.GetVisualDescendants().OfType<Button>().FirstOrDefault(b => Avalonia.Automation.AutomationProperties.GetName(b) == name); }

    [Fact]
    public Task TheLineReplacesTheAnswerControlsOfThatCard() => Ui.Run(async () =>
    {
        var workspace = new LinuxWorkspace(origin => new BellApi(origin, new ApprovalsFixture("on-device")));
        await workspace.ConnectAsync("http://localhost", listen: false);
        var hub = new ApprovalsHub(workspace); hub.Sync();
        var window = new ApprovalsWindow(hub, workspace, (_, _) => { }, _ => { });
        window.Show();
        for (var wait = 0; wait < 200 && !window.Settled; wait++) await Task.Delay(20);
        try
        {
            await window.PreviewAsync("pending", "K-1", 0);
            Assert.NotNull(Find(window, "答える")); Assert.NotNull(Find(window, "保留にする"));
            Find(window, "答える")!.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
            for (var wait = 0; wait < 100 && Find(window, "答える") is not null; wait++) await Task.Delay(20);
            Assert.True(Has(window, Approvals.AnswerOnDevice));
            Assert.Null(Find(window, "答える")); Assert.Null(Find(window, "保留にする"));
        }
        finally { window.Close(); }
    });
}
