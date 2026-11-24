using Avalonia.Controls;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;
using Kitepon.ApprovalBox.Client;

namespace BellTeam.Linux;

// Render seam for the device's states in the 決裁箱 window (--render-approvals-device <scene> <PNG>): the real window and hub over the in-process fixture server, with a stand-in device session
// (the states of peer-channel-signin.md section 2 are set by the scene; nothing is sent anywhere). Used for Delta's one-per-state review.
internal static class ApprovalsDeviceRender
{
    public static readonly string[] Scenes = ["device-signedout", "device-passended", "device-needsapproval", "device-waiting", "device-expired", "device-notentitled", "device-reconnecting", "device-live", "device-answered", "device-link", "device-seat-waiting", "device-seat-linked", "device-unavailable", "device-deleted", "device-removed", "child-notjoined", "child-signing", "child-waiting", "child-failed", "child-removed", "child-live"];

    private sealed class Device : IApprovalSource
    {
        private readonly List<ViewDecision> items = [];
        public IReadOnlyList<ViewDecision> Decisions => items;
        public ClientState State { get; set; } = new(ClientStatus.Live);
        public event Action? Changed;
        public Task<AnswerResult> AnswerAsync(string decisionId, string? optionId, string? text, long version)
        {
            var i = items.FindIndex(d => d.Id == decisionId);
            items[i] = items[i] with { Status = "answered", Answer = new ApprovalAnswer { OptionId = optionId ?? "a", Text = text, AnsweredAt = DateTimeOffset.UtcNow.ToString("O") } }; Changed?.Invoke();
            return Task.FromResult<AnswerResult>(new AnswerResult.Accepted(null));
        }
        public Task<AnswerResult> HoldAsync(string decisionId, bool held) => Task.FromResult<AnswerResult>(new AnswerResult.Accepted(null));
        public void Refresh() { }
        public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => Task.FromResult<byte[]?>(null);
        public void Add(string id, string title, string context) => items.Add(new ViewDecision
        {
            Id = id, Title = title, Context = context, Status = "pending", Version = 1, Deadline = DateTimeOffset.UtcNow.AddMinutes(id == "D-1" ? 20 : 35).ToString("O"), CreatedAt = DateTimeOffset.UtcNow.AddMinutes(-2).ToString("O"), UpdatedAt = DateTimeOffset.UtcNow.AddMinutes(-2).ToString("O"),
            Options = [new ApprovalOption { Id = "a", Label = "進める" }, new ApprovalOption { Id = "b", Label = "見送る" }],
            Origin = new ApprovalOrigin { Kind = "bellteam", Client = "claude-code", Tool = "Claude Code", SessionLabel = "端末で受信", WorkLabel = "確認", Via = "connector" },
            Requester = new ApprovalRequester { BotId = "bot-molly", Name = "モリー" },
        });
    }

    public static async Task RunAsync(string scene, string output)
    {
        if (!Scenes.Contains(scene)) throw new ArgumentException("未対応の端末の場面です。" + Launcher.Usage);
        using var model = new LinuxWorkspace(origin => new BellApi(origin, new ApprovalsFixture(scene is "device-link" or "device-seat-waiting" or "device-seat-linked" ? "connected" : "main", scene switch { "device-seat-waiting" => "waiting", "device-seat-linked" => "linked", _ => "none" })));
        await model.ConnectAsync("http://localhost", listen: false);
        if (model.ConnectionError is { } failure) throw new BellApiException(failure);
        var device = new Device();
        // A device that holds decisions keeps its list while the connection is down; the others show the note over the server's list.
        if (scene is "device-live" or "device-answered" or "device-link" or "device-seat-waiting" or "device-seat-linked" or "device-reconnecting" or "device-notentitled" or "device-removed")
        { device.Add("D-1", "端末で受け取った請求の確認", "コネクタから、この端末へ直接届きました。"); device.Add("D-2", "夜間のバックアップを予定どおり走らせてよいですか？", "サーバーを通らずに届いた決裁です。"); }
        device.State = scene switch
        {
            "device-signedout" or "device-deleted" or "device-passended" => new(ClientStatus.SignedOut, scene switch { "device-passended" => "pass_ended", "device-deleted" => "account_deleted", _ => null }),
            "device-needsapproval" or "device-waiting" or "device-expired" => new(ClientStatus.NeedsApproval, null, scene == "device-expired" ? "offer_expired" : null),
            "device-removed" => new(ClientStatus.NeedsApproval, "removed", "device_removed"),
            "device-notentitled" => new(ClientStatus.NotEntitled),
            "device-reconnecting" => new(ClientStatus.Reconnecting, "socket_closed"),
            _ => new(ClientStatus.Live),
        };
        if (scene == "device-waiting") device.State = new(ClientStatus.Waiting, Offer: new ApprovalOffer("4CH9-MGVR-13NC-MC6C", "PC1VERIFY:a1b2c3d4e5:fp0123456789abcdef0123456789abcdef0123456789a:secret0123456789abcdef", DateTimeOffset.UtcNow.AddMinutes(4).AddSeconds(30)));
        // The child-join scenes (child-join.md): the same device session behind a stand-in for the component's joinState.
        IApprovalSource? source = scene == "device-unavailable" ? null : device;
        if (scene.StartsWith("child-", StringComparison.Ordinal))
        {
            if (scene == "child-live") { device.Add("D-1", "端末で受け取った請求の確認", "コネクタから、この端末へ直接届きました。"); device.Add("D-2", "夜間のバックアップを予定どおり走らせてよいですか？", "サーバーを通らずに届いた決裁です。"); }
            source = new JoinFixtureSource(device, scene switch
            {
                "child-signing" => new(JoinPhase.SigningIn), "child-failed" => new(JoinPhase.Failed), "child-removed" => new(JoinPhase.NotJoined, Removed: true), "child-live" => new(JoinPhase.Joined),
                "child-waiting" => new(JoinPhase.Waiting, "https://login-billing.kitepon.dev/join/dev.kitepon.approvalbox#lbq4:render-only-sample-not-a-real-request", DateTimeOffset.Now.AddMinutes(5)),
                _ => new(JoinPhase.NotJoined),
            });
        }
        using var hub = new ApprovalsHub(model, source); hub.ReadLinks();
        hub.SignInApprovalBox = () => { }; hub.RequestApproval = () => { };
        var window = new ApprovalsWindow(hub, model, (_, _) => { }, _ => { });
        LatticeLook.Motion = false;
        window.Show();
        for (var wait = 0; wait < 400 && !window.Settled; wait++) await Task.Delay(20);
        await Task.Delay(150);   // the id-level link reads arrive
        if (scene == "device-answered") { await window.PreviewAsync("pending", "D-1", 0); await ClickAsync(window, "答える"); await Task.Delay(300); }
        else if (scene is "device-link" or "device-seat-waiting" or "device-seat-linked" or "child-live") { await window.OpenLinkForRenderAsync(); await Task.Delay(300); }
        else if (scene == "device-live") await window.PreviewAsync("pending", "D-2", null);
        Dispatcher.UIThread.RunJobs(); window.UpdateLayout();
        Launcher.WritePng(window, output);
        window.Close();
    }

    private static async Task ClickAsync(Window window, string name)
    {
        window.UpdateLayout();
        var button = window.GetVisualDescendants().OfType<Button>().FirstOrDefault(item => Avalonia.Automation.AutomationProperties.GetName(item) == name) ?? throw new InvalidOperationException(name + " が見つかりません。");
        button.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
        await Task.Delay(100); Dispatcher.UIThread.RunJobs();
    }
}
