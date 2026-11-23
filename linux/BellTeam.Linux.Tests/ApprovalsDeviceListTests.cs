using Avalonia.Controls;
using Avalonia.VisualTree;
using BellTeam.Core;
using Kitepon.ApprovalBox.Client;

namespace BellTeam.Linux;

// The 決裁箱 window since the /v1 close (2026-12-12): the list is this device's book only; BellTeam's server is asked for the id-level chart link (by-decision) and the one 工程表との連携 connection.
// Core's `Approvals` words are tested in BellTeam.Tests/ApprovalsTests.cs.
public sealed class ApprovalsDeviceListTests
{
    private sealed class Device : IApprovalSource
    {
        private readonly List<ViewDecision> items = [];
        public IReadOnlyList<ViewDecision> Decisions => items;
        public ClientState State { get; set; } = new(ClientStatus.Live);
        public event Action? Changed;
        public readonly List<string> Calls = [];
        public Task<AnswerResult> AnswerAsync(string decisionId, string? optionId, string? text, long version) { Calls.Add($"{decisionId}:{optionId}:{text}:{version}"); return Task.FromResult<AnswerResult>(new AnswerResult.Accepted(null)); }
        public Task<AnswerResult> HoldAsync(string decisionId, bool held) { Calls.Add($"hold:{decisionId}:{held}"); return Task.FromResult<AnswerResult>(new AnswerResult.Accepted(null)); }
        public void Refresh() { }
        public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => Task.FromResult<byte[]?>(null);
        public void Close(string id) { var i = items.FindIndex(d => d.Id == id); items[i] = items[i] with { Status = "answered" }; Changed?.Invoke(); }
        public void Add(string id, string title, string? botId = "bot-molly") => items.Add(new ViewDecision
        {
            Id = id, Title = title, Context = "背景", Status = "pending", Version = 3, CreatedAt = DateTimeOffset.UtcNow.AddMinutes(-2).ToString("O"), UpdatedAt = DateTimeOffset.UtcNow.AddMinutes(-2).ToString("O"),
            Options = [new ApprovalOption { Id = "a", Label = "進める" }, new ApprovalOption { Id = "b", Label = "見送る" }],
            Origin = new ApprovalOrigin { Kind = botId is null ? "external" : "bellteam", Client = "claude-code", SessionLabel = "端末で受信", WorkLabel = "確認" },
            Requester = botId is null ? null : new ApprovalRequester { BotId = botId, Name = "モリー" },
        });
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
            Assert.Equal(["D-9:a::3"], device.Calls);   // the version the person saw goes with the answer
            device.Close("D-9");
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
