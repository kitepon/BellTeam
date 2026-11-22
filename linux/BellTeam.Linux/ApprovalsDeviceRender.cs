using System.Text.Json;
using Avalonia.Controls;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;
using BellTeam.PeerChannel;

namespace BellTeam.Linux;

// Render seam for the device's states in the 決裁箱 window (--render-approvals-device <scene> <PNG>): the real window and hub over the in-process fixture server, with a stand-in device session
// (the states of peer-channel-signin.md section 2 are set by the scene; nothing is sent anywhere). Used for Delta's one-per-state review.
internal static class ApprovalsDeviceRender
{
    public static readonly string[] Scenes = ["device-signedout", "device-passended", "device-needsapproval", "device-waiting", "device-expired", "device-notentitled", "device-reconnecting", "device-live", "device-answered", "device-on-device", "device-deleted", "device-removed"];

    private sealed class Device : IDeviceDecisions
    {
        public DecisionBook Book { get; } = new();
        public RuntimeState State { get; set; } = new(RuntimeStatus.Live);
        public event Action? Changed;
        public Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text)
        {
            var rid = Book.All.First(e => e.DecisionId == decisionId).Rid;
            Book.Close(rid, "answered", JsonDocument.Parse(JsonSerializer.Serialize(new { option_id = optionId ?? "a" })).RootElement, "me", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); Changed?.Invoke();
            return Task.FromResult(new SendOutcome("ok"));
        }
        public Task<SendOutcome> HoldAsync(string decisionId, bool held) => Task.FromResult(new SendOutcome("ok"));
        public void Refresh() { }
        public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => Task.FromResult<byte[]?>(null);
        public void Add(string id, string title, string context) => Book.Apply("request", JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            rid = "r-" + id, rv = 1, schema = "approval-box/decision@1",
            content = new { decision_id = id, title, context, deadline = DateTimeOffset.UtcNow.AddMinutes(id == "D-1" ? 20 : 35).ToString("O"), options = new[] { new { id = "a", label = "進める" }, new { id = "b", label = "見送る" } }, source = new { client = "claude-code", session_label = "端末で受信", work_label = "確認", requester = "モリー", requester_bot_id = "bot-molly", test = false } }
        })).RootElement, [1], DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 120_000);
    }

    public static async Task RunAsync(string scene, string output)
    {
        if (!Scenes.Contains(scene)) throw new ArgumentException("未対応の端末の場面です。" + Launcher.Usage);
        using var model = new LinuxWorkspace(origin => new BellApi(origin, new ApprovalsFixture(scene == "device-on-device" ? "on-device" : "main")));
        await model.ConnectAsync("http://localhost", listen: false);
        if (model.ConnectionError is { } failure) throw new BellApiException(failure);
        var device = new Device();
        // A device that holds decisions keeps its list while the connection is down; the others show the note over the server's list.
        if (scene is "device-live" or "device-answered" or "device-reconnecting" or "device-notentitled" or "device-removed")
        { device.Add("D-1", "端末で受け取った請求の確認", "コネクタから、この端末へ直接届きました。"); device.Add("D-2", "夜間のバックアップを予定どおり走らせてよいですか？", "サーバーを通らずに届いた決裁です。"); }
        device.State = scene switch
        {
            "device-signedout" or "device-deleted" or "device-passended" => new(RuntimeStatus.SignedOut, scene switch { "device-passended" => "pass_ended", "device-deleted" => "account_deleted", _ => null }),
            "device-needsapproval" or "device-waiting" or "device-expired" => new(RuntimeStatus.NeedsAdmission, "not_verified"),
            "device-removed" => new(RuntimeStatus.NeedsAdmission, "removed"),
            "device-notentitled" => new(RuntimeStatus.NotEntitled),
            "device-reconnecting" => new(RuntimeStatus.Retrying, "HttpRequestException: Connection refused"),
            _ => new(RuntimeStatus.Live),
        };
        using var hub = new ApprovalsHub(model, device); hub.Sync();
        hub.SignInApprovalBox = () => { }; hub.RequestApproval = () => { };
        if (scene == "device-waiting") hub.SetOffer(new ApprovalOffer("4CH9-MGVR-13NC-MC6C", "PC1VERIFY:a1b2c3d4e5:fp0123456789abcdef0123456789abcdef0123456789a:secret0123456789abcdef", DateTimeOffset.UtcNow.AddMinutes(4).AddSeconds(30)));
        if (scene == "device-expired") hub.SetOffer(null, Approvals.DeviceApprovalExpired);
        var window = new ApprovalsWindow(hub, model, (_, _) => { }, _ => { });
        LatticeLook.Motion = false;
        window.Show();
        for (var wait = 0; wait < 400 && !window.Settled; wait++) await Task.Delay(20);
        if (scene == "device-answered") { await window.PreviewAsync("pending", "D-1", 0); await ClickAsync(window, "答える"); await Task.Delay(300); }
        else if (scene == "device-on-device") { await window.PreviewAsync("pending", "K-1", 0); await ClickAsync(window, "答える"); await Task.Delay(300); }
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
