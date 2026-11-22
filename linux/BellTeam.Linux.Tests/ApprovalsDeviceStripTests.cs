using Avalonia.Controls;
using Avalonia.VisualTree;
using BellTeam.Core;
using BellTeam.PeerChannel;

namespace BellTeam.Linux;

// The device's states in the 決裁箱 window (peer-channel-signin.md section 3): each state says its words and offers its one action; Live says nothing.
public sealed class ApprovalsDeviceStripTests
{
    private sealed class FakeDevice : IDeviceDecisions
    {
        public DecisionBook Book { get; } = new();
        public RuntimeState State { get; set; } = new(RuntimeStatus.Live);
        public event Action? Changed;
        public int Refreshed;
        public Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text) => Task.FromResult(new SendOutcome("ok"));
        public Task<SendOutcome> HoldAsync(string decisionId, bool held) => Task.FromResult(new SendOutcome("ok"));
        public void Refresh() => Refreshed++;
        public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => Task.FromResult<byte[]?>(null);
        public void Raise() => Changed?.Invoke();
    }

    private static async Task<(ApprovalsWindow Window, ApprovalsHub Hub, FakeDevice Device)> OpenAsync(RuntimeState state)
    {
        var workspace = new LinuxWorkspace(origin => new BellApi(origin, new ApprovalsFixture("main")));
        await workspace.ConnectAsync("http://localhost", listen: false);
        var device = new FakeDevice { State = state };
        var hub = new ApprovalsHub(workspace, device); hub.Sync();
        var window = new ApprovalsWindow(hub, workspace, (_, _) => { }, _ => { });
        window.Show();
        return (window, hub, device);
    }
    private static IEnumerable<string> Texts(Control root) { root.UpdateLayout(); return root.GetVisualDescendants().OfType<TextBlock>().Select(t => t.Text ?? "").Where(t => t.Length > 0); }
    private static bool HasText(Control root, string text) => Texts(root).Any(t => t.Contains(text, StringComparison.Ordinal));

    [Theory]
    [InlineData(RuntimeStatus.Connecting, null, "この端末を決裁箱につないでいます")]
    [InlineData(RuntimeStatus.Retrying, "relay", "つなぎ直しています（relay）")]
    [InlineData(RuntimeStatus.NeedsAdmission, "not_verified", "まだ承認されていません")]
    [InlineData(RuntimeStatus.NeedsAdmission, "removed", "ほかの端末から外されました")]
    [InlineData(RuntimeStatus.SignedOut, null, "Approval Boxにサインインします")]
    [InlineData(RuntimeStatus.SignedOut, "pass_ended", "サインインが終わりました")]
    [InlineData(RuntimeStatus.SignedOut, "account_deleted", "アカウントは削除されました")]
    [InlineData(RuntimeStatus.NotEntitled, null, "購読が必要です")]
    public Task EachStateSaysItsWords(RuntimeStatus status, string? reason, string words) => Ui.Run(async () =>
    {
        var (window, _, _) = await OpenAsync(new RuntimeState(status, reason));
        try { Assert.True(window.DeviceStrip() is { } strip && HasText(strip, words), words); }
        finally { window.Close(); }
    });

    [Fact]
    public Task LiveShowsNoNoteAndSigningInOffersToStop() => Ui.Run(async () =>
    {
        var (window, hub, _) = await OpenAsync(new RuntimeState(RuntimeStatus.Live));
        try
        {
            Assert.Null(window.DeviceStrip());
            var (w2, hub2, device2) = await OpenAsync(new RuntimeState(RuntimeStatus.SignedOut));
            try
            {
                var cancelled = 0; hub2.CancelSignIn = () => cancelled++; hub2.SetSignIn(true);
                var strip = window2Strip(w2);
                Assert.True(HasText(strip, "ブラウザでサインインしています"));
                Click(w2, "やめる"); Assert.Equal(1, cancelled);
            }
            finally { w2.Close(); }
        }
        finally { window.Close(); }
    });
    private static Control window2Strip(ApprovalsWindow w) => w.DeviceStrip()!;
    private static void Click(ApprovalsWindow window, string label) { window.UpdateLayout(); window.GetVisualDescendants().OfType<Button>().First(b => Avalonia.Automation.AutomationProperties.GetName(b) == label).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent)); }

    [Fact]
    public Task WaitingShowsTheCodeAndAskingAgainAfterItEnds() => Ui.Run(async () =>
    {
        var (window, hub, _) = await OpenAsync(new RuntimeState(RuntimeStatus.NeedsAdmission, "not_verified"));
        try
        {
            var asked = 0; hub.RequestApproval = () => asked++; hub.SetOffer(null);   // draws the note again, now with its action
            Click(window, "承認をお願いする"); Assert.Equal(1, asked);
            hub.SetOffer(new ApprovalOffer("ABCD-EFGH-JKLM-NPQR", "PC1PAIR-test", DateTimeOffset.UtcNow.AddMinutes(5)));
            var waiting = window.DeviceStrip()!;
            Assert.True(HasText(waiting, "ABCD-EFGH-JKLM-NPQR")); Assert.True(HasText(waiting, "あと"));
            hub.SetOffer(null, "承認の待ち時間が過ぎました。");
            var again = window.DeviceStrip()!;
            Assert.True(HasText(again, "承認の待ち時間が過ぎました。")); Click(window, "もう一度"); Assert.Equal(2, asked);
        }
        finally { window.Close(); }
    });
}
