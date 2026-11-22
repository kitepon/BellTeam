using System.Text.Json;
using Avalonia.Controls;
using Avalonia.VisualTree;
using BellTeam.Core;
using BellTeam.PeerChannel;

namespace BellTeam.Linux;

// The 決裁箱 list while both ways are open (Delta, until the /v1 close): the server read and this device's session by decision id, the device copy winning; an answer goes through the source that holds the copy shown.
public sealed class ApprovalsUnionTests
{
    private sealed class Device : IDeviceDecisions
    {
        public DecisionBook Book { get; } = new();
        public RuntimeState State { get; set; } = new(RuntimeStatus.Live);
        public event Action? Changed;
        public readonly List<string> Answers = [];
        public Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text) { Answers.Add($"{decisionId}:{optionId}:{text}"); return Task.FromResult(new SendOutcome("ok")); }
        public Task<SendOutcome> HoldAsync(string decisionId, bool held) { Answers.Add($"hold:{decisionId}:{held}"); return Task.FromResult(new SendOutcome("ok")); }
        public void Refresh() { }
        public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => Task.FromResult<byte[]?>(null);
        public void Raise() => Changed?.Invoke();
        public void Add(string id, string title) => Book.Apply("request", JsonDocument.Parse("{\"rid\":\"r-" + id + "\",\"rv\":1,\"schema\":\"approval-box/decision@1\",\"content\":{\"decision_id\":\"" + id + "\",\"title\":\"" + title + "\",\"options\":[{\"id\":\"a\",\"label\":\"はい\"},{\"id\":\"b\",\"label\":\"いいえ\"}]}}").RootElement, [1], 5);
    }

    private static async Task<(ApprovalsWindow Window, ApprovalsHub Hub, Device Device)> OpenAsync(Action<Device> setup)
    {
        var workspace = new LinuxWorkspace(origin => new BellApi(origin, new ApprovalsFixture("main")));
        await workspace.ConnectAsync("http://localhost", listen: false);
        var device = new Device(); setup(device);
        var hub = new ApprovalsHub(workspace, device); hub.Sync();
        var window = new ApprovalsWindow(hub, workspace, (_, _) => { }, _ => { });
        window.Show();
        for (var wait = 0; wait < 200 && !window.Settled; wait++) await Task.Delay(20);
        for (var wait = 0; wait < 200 && hub.Feed?.Summary is null; wait++) await Task.Delay(20);
        return (window, hub, device);
    }
    private static bool HasText(Control root, string text) { root.UpdateLayout(); return root.GetVisualDescendants().OfType<TextBlock>().Any(t => (t.Text ?? "").Contains(text, StringComparison.Ordinal)); }
    private static Button? Find(ApprovalsWindow window, string name) { window.UpdateLayout(); return window.GetVisualDescendants().OfType<Button>().FirstOrDefault(button => Avalonia.Automation.AutomationProperties.GetName(button) == name); }
    private static void Click(ApprovalsWindow window, string label) => Find(window, label)!.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));

    [Fact]
    public Task ADecisionOnlyTheDeviceHoldsIsListedAndCounted() => Ui.Run(async () =>
    {
        var (window, hub, _) = await OpenAsync(device => device.Add("D-9", "端末だけの決裁"));
        try
        {
            Assert.True(HasText(window, "端末だけの決裁"));
            Assert.Equal(5, hub.Summary!.Pending);   // the server's 4 and the device's 1
        }
        finally { window.Close(); }
    });

    [Fact]
    public Task NoUsableDeviceListIsExactlyTheServerRead() => Ui.Run(async () =>
    {
        var (window, hub, _) = await OpenAsync(device => device.State = new RuntimeState(RuntimeStatus.SignedOut));
        try { Assert.False(window.DeviceUsable); Assert.Equal(4, hub.Summary!.Pending); }
        finally { window.Close(); }
    });

    [Fact]
    public Task AnAnswerOnTheDeviceCopyGoesToTheDeviceAndEndsWhenTheResultFrameClosesIt() => Ui.Run(async () =>
    {
        var (window, hub, device) = await OpenAsync(d => d.Add("D-9", "端末だけの決裁"));
        try
        {
            await window.PreviewAsync("pending", "D-9", 0);
            Click(window, "答える");
            for (var wait = 0; wait < 100 && device.Answers.Count == 0; wait++) await Task.Delay(20);
            Assert.Equal(["D-9:a:"], device.Answers);
            device.Book.Close("r-D-9", "answered", null, "me", 9); device.Raise();
            for (var wait = 0; wait < 100 && window.Selected is { Status: "pending" }; wait++) await Task.Delay(20);
            Assert.NotEqual("pending", window.Selected!.Status);
            Assert.Null(Find(window, "答える"));
        }
        finally { window.Close(); }
    });
}
