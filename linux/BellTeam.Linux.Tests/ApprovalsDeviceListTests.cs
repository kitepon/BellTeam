using System.Text.Json;
using Avalonia.Controls;
using Avalonia.VisualTree;
using BellTeam.Core;
using BellTeam.PeerChannel;

namespace BellTeam.Linux;

// The 決裁箱 window since the /v1 close (2026-12-12): the list is this device's book only; BellTeam's server is asked for the id-level chart link (by-decision) and the one 工程表との連携 connection.
// Core's `Approvals` words are tested in BellTeam.Tests/ApprovalsTests.cs.
public sealed class ApprovalsDeviceListTests
{
    private sealed class Device : IDeviceDecisions
    {
        public DecisionBook Book { get; } = new();
        public RuntimeState State { get; set; } = new(RuntimeStatus.Live);
        public event Action? Changed;
        public readonly List<string> Calls = [];
        public Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text) { Calls.Add($"{decisionId}:{optionId}:{text}"); return Task.FromResult(new SendOutcome("ok")); }
        public Task<SendOutcome> HoldAsync(string decisionId, bool held) { Calls.Add($"hold:{decisionId}:{held}"); return Task.FromResult(new SendOutcome("ok")); }
        public void Refresh() { }
        public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => Task.FromResult<byte[]?>(null);
        public void Raise() => Changed?.Invoke();
        public void Add(string id, string title, string? botId = "bot-molly") => Book.Apply("request", JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            rid = "r-" + id, rv = 1, schema = "approval-box/decision@1",
            content = new { decision_id = id, title, context = "背景", options = new[] { new { id = "a", label = "進める" }, new { id = "b", label = "見送る" } }, source = new { client = "claude-code", session_label = "端末で受信", work_label = "確認", requester = botId is null ? null : "モリー", requester_bot_id = botId, test = false } }
        })).RootElement, [1], DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 120_000);
    }

    private static async Task<(ApprovalsWindow Window, ApprovalsHub Hub, Device Device, ApprovalsFixture Server)> OpenAsync(Action<Device> setup, string scene = "main", bool withDevice = true)
    {
        var server = new ApprovalsFixture(scene);
        var workspace = new LinuxWorkspace(origin => new BellApi(origin, server));
        await workspace.ConnectAsync("http://localhost", listen: false);
        var device = new Device(); setup(device);
        var hub = new ApprovalsHub(workspace, withDevice ? device : null); hub.ReadLinks();
        var window = new ApprovalsWindow(hub, workspace, (_, _) => { }, _ => { });
        window.Show();
        for (var wait = 0; wait < 100 && !window.Settled; wait++) await Task.Delay(20);
        return (window, hub, device, server);
    }
    private static bool HasText(Control root, string text) { root.UpdateLayout(); return root.GetVisualDescendants().OfType<TextBlock>().Any(t => (t.Text ?? "").Contains(text, StringComparison.Ordinal)); }
    private static Button? Find(ApprovalsWindow window, string name) { window.UpdateLayout(); return window.GetVisualDescendants().OfType<Button>().FirstOrDefault(button => Avalonia.Automation.AutomationProperties.GetName(button) == name); }
    private static void Click(ApprovalsWindow window, string label) => Find(window, label)!.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));


    [Fact]
    public Task AReplayBurstOfSourceChangesRepaintsOnceInAWhileNotPerEvent() => Ui.Run(async () =>
    {
        var (window, hub, device, _) = await OpenAsync(d => d.Add("D-1", "一件"));
        try
        {
            var repaints = 0; hub.DeviceChanged += () => repaints++;
            await Task.Run(() => { for (var i = 0; i < 500; i++) device.Raise(); });
            for (var wait = 0; wait < 50; wait++) { await Task.Delay(20); Avalonia.Threading.Dispatcher.UIThread.RunJobs(); }
            Assert.InRange(repaints, 1, 20);   // 500 events, one running and at most one queued
        }
        finally { window.Close(); hub.Dispose(); }
    });

    [Fact]
    public Task TheListIsTheDevicesBookAndTheCountsAreItsToo() => Ui.Run(async () =>
    {
        var (window, hub, _, _) = await OpenAsync(d => { d.Add("D-9", "端末だけの決裁"); d.Add("D-8", "外部の決裁", botId: null); });
        try
        {
            Assert.True(HasText(window, "端末だけの決裁"));
            Assert.Equal(2, hub.Summary!.Pending);
            Assert.NotNull(Find(window, "すべて 2件")); Assert.NotNull(Find(window, "BellTeam 1件")); Assert.NotNull(Find(window, "外部 1件"));   // the origin filter counts the device's decisions
        }
        finally { window.Close(); hub.Dispose(); }
    });

    [Fact]
    public Task AnAnswerGoesToTheDeviceThroughTheConfirmStepAndEndsWhenTheResultFrameClosesIt() => Ui.Run(async () =>
    {
        var (window, hub, device, _) = await OpenAsync(d => d.Add("D-9", "端末だけの決裁"));
        try
        {
            await window.PreviewAsync("pending", "D-9", null);
            Assert.Null(Find(window, "答える"));                                   // an option never answers by itself
            Find(window, "進める")!.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
            Click(window, "やめる"); Assert.Null(Find(window, "答える"));
            await window.PreviewAsync("pending", "D-9", 0);
            Click(window, "答える");
            for (var wait = 0; wait < 100 && device.Calls.Count == 0; wait++) await Task.Delay(20);
            Assert.Equal(["D-9:a:"], device.Calls);
            device.Book.Close("r-D-9", "answered", null, "me", 9); device.Raise();
            for (var wait = 0; wait < 100 && window.Selected is { Status: "pending" }; wait++) await Task.Delay(20);
            Assert.NotEqual("pending", window.Selected!.Status);
            Assert.Null(Find(window, "答える"));
        }
        finally { window.Close(); hub.Dispose(); }
    });

    [Fact]
    public Task HoldGoesToTheDevice() => Ui.Run(async () =>
    {
        var (window, hub, device, _) = await OpenAsync(d => d.Add("D-9", "端末だけの決裁"));
        try
        {
            await window.PreviewAsync("pending", "D-9", null);
            Click(window, "保留にする");
            for (var wait = 0; wait < 100 && device.Calls.Count == 0; wait++) await Task.Delay(20);
            Assert.Equal(["hold:D-9:True"], device.Calls);
        }
        finally { window.Close(); hub.Dispose(); }
    });

    [Fact]
    public Task TheChartLinkComesFromByDecisionAndAMissingOneDrawsNoBadge() => Ui.Run(async () =>
    {
        var (window, hub, _, server) = await OpenAsync(d => { d.Add("D-1", "つながった決裁"); d.Add("D-2", "つながっていない決裁"); });
        try
        {
            for (var wait = 0; wait < 100 && hub.DeviceViews.All(item => item.Link is null); wait++) await Task.Delay(20);
            var linked = hub.DeviceViews.First(item => item.Id == "D-1"); var plain = hub.DeviceViews.First(item => item.Id == "D-2");
            Assert.Equal("linked", linked.Link!.State); Assert.Equal("p1/t07", linked.Link.Task!.CardId); Assert.Equal("lattice", linked.Link.Chart!.ProjectId);
            Assert.Null(plain.Link);
            Assert.True(server.LinkReads >= 2);
            await window.PreviewAsync("pending", "D-1", null);
            Assert.NotNull(Find(window, "工程表の工程を開く"));
        }
        finally { window.Close(); hub.Dispose(); }
    });

    [Fact]
    public Task RemovedRoutesShowNoFailureAndTheDeviceListStays() => Ui.Run(async () =>
    {
        var (window, hub, _, _) = await OpenAsync(d => d.Add("D-9", "端末だけの決裁"), scene: "gone");
        try
        {
            await Task.Delay(200);
            Assert.True(HasText(window, "端末だけの決裁"));
            Assert.False(HasText(window, "再接続")); Assert.False(HasText(window, "このサーバーではまだ"));
            Assert.Null(hub.DeviceViews[0].Link);
        }
        finally { window.Close(); hub.Dispose(); }
    });

    [Fact]
    public Task NoDeviceOnThisMachineShowsThePlainStateAndNothingToRetry() => Ui.Run(async () =>
    {
        var (window, hub, _, _) = await OpenAsync(d => { }, withDevice: false);
        try
        {
            Assert.True(HasText(window, ApprovalsWindow.NotAvailable));
            Assert.Null(Find(window, "読み直す"));
        }
        finally { window.Close(); hub.Dispose(); }
    });

    [Fact]
    public Task TheLinkPanelConnectsAndDisconnectsTheChartLink() => Ui.Run(async () =>
    {
        var (window, hub, _, _) = await OpenAsync(d => d.Add("D-9", "端末だけの決裁"));
        try
        {
            Click(window, "工程表との連携");
            for (var wait = 0; wait < 100 && Find(window, "つなぐ") is null; wait++) await Task.Delay(20);
            Assert.True(HasText(window, "まだつながっていません")); Assert.NotNull(Find(window, "つなぐ"));
            Click(window, "戻る"); Assert.True(HasText(window, "端末だけの決裁"));   // not a gate on the list
        }
        finally { window.Close(); hub.Dispose(); }
        var (connected, hub2, _, _) = await OpenAsync(d => d.Add("D-9", "端末だけの決裁"), scene: "connected");
        try
        {
            Click(connected, "工程表との連携");
            for (var wait = 0; wait < 100 && Find(connected, "はずす") is null; wait++) await Task.Delay(20);
            Assert.True(HasText(connected, "工程表と連携しています"));
            Click(connected, "はずす");
            for (var wait = 0; wait < 100 && Find(connected, "つなぐ") is null; wait++) await Task.Delay(20);
            Assert.NotNull(Find(connected, "つなぐ"));
        }
        finally { connected.Close(); hub2.Dispose(); }
    });
}
