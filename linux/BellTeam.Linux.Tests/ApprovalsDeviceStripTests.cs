using Avalonia.Controls;
using Avalonia.VisualTree;
using BellTeam.Core;
using Kitepon.ApprovalBox.Client;

namespace BellTeam.Linux;

// The device's states in the 決裁箱 window (peer-channel-signin.md section 3): each state says its words and offers its one action; Live says nothing.
public sealed class ApprovalsDeviceStripTests
{
    private sealed class FakeDevice : IApprovalSource
    {
        public IReadOnlyList<ViewDecision> Decisions => [];
        public ClientState State { get; set; } = new(ClientStatus.Live);
        public event Action? Changed;
        public int Refreshed;
        public Task<AnswerResult> AnswerAsync(string decisionId, string? optionId, string? text, long version) => Task.FromResult<AnswerResult>(new AnswerResult.Accepted(null));
        public Task<AnswerResult> HoldAsync(string decisionId, bool held) => Task.FromResult<AnswerResult>(new AnswerResult.Accepted(null));
        public void Refresh() => Refreshed++;
        public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => Task.FromResult<byte[]?>(null);
        public void Raise() => Changed?.Invoke();
    }

    private static async Task<(ApprovalsWindow Window, ApprovalsHub Hub, FakeDevice Device)> OpenAsync(ClientState state)
    {
        var workspace = new LinuxWorkspace(origin => new BellApi(origin, new ApprovalsFixture("main")));
        await workspace.ConnectAsync("http://localhost", listen: false);
        var device = new FakeDevice { State = state };
        var hub = new ApprovalsHub(workspace, device); hub.ReadLinks();
        var window = new ApprovalsWindow(hub, workspace, (_, _) => { }, _ => { });
        window.Show();
        return (window, hub, device);
    }
    private static IEnumerable<string> Texts(Control root) { root.UpdateLayout(); return root.GetVisualDescendants().OfType<TextBlock>().Select(t => t.Text ?? "").Where(t => t.Length > 0); }
    private static bool HasText(Control root, string text) => Texts(root).Any(t => t.Contains(text, StringComparison.Ordinal));

    [Theory]
    [InlineData(ClientStatus.Joining, null, null, "この端末を決裁箱につないでいます")]
    [InlineData(ClientStatus.Reconnecting, "socket_closed", null, "つなぎ直しています")]
    [InlineData(ClientStatus.NeedsApproval, null, null, "まだ承認されていません")]
    [InlineData(ClientStatus.NeedsApproval, "removed", "device_removed", "ほかの端末から外されました")]
    [InlineData(ClientStatus.SignedOut, null, null, "Approval Boxにサインインします")]
    [InlineData(ClientStatus.SignedOut, "pass_ended", null, "サインインが終わりました")]
    [InlineData(ClientStatus.SignedOut, "account_deleted", null, "アカウントは削除されました")]
    [InlineData(ClientStatus.NotEntitled, null, null, "契約が必要です")]
    [InlineData(ClientStatus.UpdateRequired, "gone", null, "この版では、決裁箱をまだ使えません。アプリを更新してください。")]
    public Task EachStateSaysItsWords(ClientStatus status, string? reason, string? note, string words) => Ui.Run(async () =>
    {
        var (window, _, _) = await OpenAsync(new ClientState(status, reason, note));
        try { Assert.True(window.DeviceStrip() is { } strip && HasText(strip, words), words); }
        finally { window.Close(); }
    });

    [Fact]
    public Task LiveShowsNoNoteAndSigningInOffersToStop() => Ui.Run(async () =>
    {
        var (window, hub, _) = await OpenAsync(new ClientState(ClientStatus.Live));
        try
        {
            Assert.Null(window.DeviceStrip());
            var (w2, hub2, device2) = await OpenAsync(new ClientState(ClientStatus.SignedOut));
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
        var (window, hub, device) = await OpenAsync(new ClientState(ClientStatus.NeedsApproval));
        try
        {
            var asked = 0; hub.RequestApproval = () => asked++; device.Raise();   // draws the note again, now with its action
            Click(window, "承認をお願いする"); Assert.Equal(1, asked);
            device.State = new(ClientStatus.Waiting, Offer: new ApprovalOffer("ABCD-EFGH-JKLM-NPQR", "PC1PAIR-test", DateTimeOffset.UtcNow.AddMinutes(5)));
            var waiting = window.DeviceStrip()!;
            Assert.True(HasText(waiting, "ABCD-EFGH-JKLM-NPQR")); Assert.True(HasText(waiting, "あと"));
            device.State = new(ClientStatus.NeedsApproval, Note: "offer_expired");
            device.Raise(); var again = window.DeviceStrip()!;
            Assert.True(HasText(again, Approvals.DeviceApprovalExpired)); Click(window, "もう一度"); Assert.Equal(2, asked);
        }
        finally { window.Close(); }
    });
}
