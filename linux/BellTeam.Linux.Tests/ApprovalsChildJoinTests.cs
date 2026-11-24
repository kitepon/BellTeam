using Avalonia.Controls;
using Avalonia.VisualTree;
using BellTeam.Core;
using BellTeam.PeerChannel;

namespace BellTeam.Linux;

// child-join.md, "The one screen": each state of the table with its words and action, and the never-a-parent rule. The component is stood in by JoinFixtureSource.
public sealed class ApprovalsChildJoinTests
{
    private sealed class Device : IDeviceDecisions
    {
        public DecisionBook Book { get; } = new();
        public RuntimeState State { get; set; } = new(RuntimeStatus.Live);
        public event Action? Changed;
        public Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text) => Task.FromResult(new SendOutcome("ok"));
        public Task<SendOutcome> HoldAsync(string decisionId, bool held) => Task.FromResult(new SendOutcome("ok"));
        public void Refresh() => Changed?.Invoke();
        public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => Task.FromResult<byte[]?>(null);
    }

    private static async Task<(ApprovalsWindow Window, JoinFixtureSource Source, Device Device)> OpenAsync(ChildJoinState join, RuntimeState? state = null)
    {
        var workspace = new LinuxWorkspace(origin => new BellApi(origin, new ApprovalsFixture("connected")));
        await workspace.ConnectAsync("http://localhost", listen: false);
        var device = new Device(); if (state is { } s) device.State = s;
        var source = new JoinFixtureSource(new PeerSource(device), join);
        var window = new ApprovalsWindow(new ApprovalsHub(workspace, source), workspace, (_, _) => { }, _ => { });
        window.Show(); for (var wait = 0; wait < 100 && !window.Settled; wait++) await Task.Delay(20);
        return (window, source, device);
    }
    private static List<string?> Texts(Control root) { root.UpdateLayout(); return [.. root.GetVisualDescendants().OfType<TextBlock>().Select(t => t.Text)]; }
    private static bool Has(Control root, string text) => Texts(root).Any(t => (t ?? "").Contains(text, StringComparison.Ordinal));
    private static Button? Find(Control root, string label) => root.GetVisualDescendants().OfType<Button>().FirstOrDefault(b => Avalonia.Automation.AutomationProperties.GetName(b) == label);
    private static void Click(Button button) { button.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent)); Avalonia.Threading.Dispatcher.UIThread.RunJobs(); }

    // A child never offers to add another device, a purchase or a plan (the Owner: BellTeam's window is never a parent).
    private static void NeverAParent(Control root)
    {
        var all = string.Join("\n", Texts(root)) + string.Join("\n", root.GetVisualDescendants().OfType<Button>().Select(b => Avalonia.Automation.AutomationProperties.GetName(b)));
        foreach (var word in new[] { "ほかの端末を追加", "この端末を親にする", "購入", "プラン", "料金" }) Assert.DoesNotContain(word, all);
    }

    [Fact]
    public Task NotJoinedShowsTheSignInAndTheTwoButtons() => Ui.Run(async () =>
    {
        var (window, source, _) = await OpenAsync(new(JoinPhase.NotJoined));
        try
        {
            Assert.True(Has(window, ChildJoinText.Title)); Assert.True(Has(window, ChildJoinText.Lead)); Assert.True(Has(window, LocalFormText.FirstSignInChildOnly));
            Click(Find(window, SignInText.Apple)!); Click(Find(window, SignInText.Google)!);
            Assert.Equal(["join:apple", "join:google"], source.Calls);
            NeverAParent(window);
        }
        finally { window.Close(); }
    });

    [Fact]
    public Task SigningInOffersOnlyTheWayOut() => Ui.Run(async () =>
    {
        var (window, source, _) = await OpenAsync(new(JoinPhase.SigningIn));
        try { Assert.True(Has(window, SignInText.Waiting)); Assert.Null(Find(window, SignInText.Apple)); Click(Find(window, SignInText.Cancel)!); Assert.Equal(["cancel"], source.Calls); }
        finally { window.Close(); }
    });

    [Fact]
    public Task WaitingShowsTheQrTheValidityTheOwnersSentenceAndCancel() => Ui.Run(async () =>
    {
        var (window, source, _) = await OpenAsync(new(JoinPhase.Waiting, "https://login-billing.kitepon.dev/join/dev.kitepon.approvalbox#lbq4:test", DateTimeOffset.Now.AddMinutes(5)));
        try
        {
            Assert.True(Has(window, ChildJoinText.WaitingTitle)); Assert.NotEmpty(window.GetVisualDescendants().OfType<QrView>()); Assert.True(Has(window, " まで有効")); Assert.True(Has(window, LocalFormText.Qr));
            Click(Find(window, ChildJoinText.LeaveNo)!); Assert.Equal(["cancel"], source.Calls); NeverAParent(window);
        }
        finally { window.Close(); }
    });

    [Fact]
    public Task FailedAsksTheSameSignInAgainAndRemovedStartsClean() => Ui.Run(async () =>
    {
        // After a sign-in the person chose, a failure offers 「もう一度つなぐ」 with that provider; a failure with no choice known shows the two buttons (requestJoin always takes a provider).
        var (started, startedSource, startedDevice) = await OpenAsync(new(JoinPhase.NotJoined));
        try
        {
            Click(Find(started, SignInText.Google)!); startedSource.Current = new(JoinPhase.Failed); startedDevice.Refresh(); await Task.Delay(100); Avalonia.Threading.Dispatcher.UIThread.RunJobs();
            Assert.True(Has(started, ChildJoinText.Failed)); Click(Find(started, ChildJoinText.ConnectAgain)!); Assert.Equal(["join:google", "join:google"], startedSource.Calls);
        }
        finally { started.Close(); }
        var (failed, _, _) = await OpenAsync(new(JoinPhase.Failed));
        try { Assert.True(Has(failed, ChildJoinText.Failed)); Assert.Null(Find(failed, ChildJoinText.ConnectAgain)); Assert.NotNull(Find(failed, SignInText.Apple)); Assert.NotNull(Find(failed, SignInText.Google)); } finally { failed.Close(); }
        var (other, _, _) = await OpenAsync(new(JoinPhase.Failed, Code: "other_account"));
        try { Assert.True(Has(other, ChildJoinText.OtherAccount)); Assert.False(Has(other, "other_account")); } finally { other.Close(); }
        var (removed, _, _) = await OpenAsync(new(JoinPhase.NotJoined, Removed: true));
        try { Assert.True(Has(removed, ChildJoinText.Removed)); Assert.True(Has(removed, ChildJoinText.Title)); Assert.NotNull(Find(removed, SignInText.Apple)); Assert.NotNull(Find(removed, SignInText.Google)); } finally { removed.Close(); }
    });

    [Fact]
    public Task JoinedIsTheNormalWindowAndLeavingTakesTwoSteps() => Ui.Run(async () =>
    {
        var (window, source, _) = await OpenAsync(new(JoinPhase.Joined));
        try
        {
            Assert.False(Has(window, ChildJoinText.Title));   // the normal 決裁箱, not the join screen
            await window.OpenLinkForRenderAsync(); Avalonia.Threading.Dispatcher.UIThread.RunJobs();
            Assert.True(Has(window, ChildJoinText.Joined));
            Click(Find(window, ChildJoinText.Leave)!); Assert.Empty(source.Calls);   // one step does nothing
            Click(Find(window, ChildJoinText.LeaveNo)!); Assert.Empty(source.Calls); Assert.NotNull(Find(window, ChildJoinText.Leave));
            Click(Find(window, ChildJoinText.Leave)!); Click(Find(window, ChildJoinText.LeaveYes)!); await Task.Delay(100); Avalonia.Threading.Dispatcher.UIThread.RunJobs();
            Assert.Equal(["leave"], source.Calls); Assert.True(Has(window, ChildJoinText.Title));   // left: the not-joined screen
            NeverAParent(window);
        }
        finally { window.Close(); }
    });

    [Fact]
    public Task JoinedKeepsTheExistingNotesForReconnectingNotEntitledAndUpdate() => Ui.Run(async () =>
    {
        foreach (var (state, words) in new (RuntimeState, string)[] { (new(RuntimeStatus.Retrying, "x"), Approvals.DeviceReconnecting), (new(RuntimeStatus.NotEntitled), Approvals.DeviceNotEntitled), (new(RuntimeStatus.Stopped, "update_needed"), Approvals.DeviceUpdateNeeded) })
        {
            var (window, _, _) = await OpenAsync(new(JoinPhase.Joined), state);
            try { Assert.True(Has(window, words)); NeverAParent(window); } finally { window.Close(); }
        }
    });

    [Fact]
    public Task WithoutAChildJoinTheWindowKeepsItsPresentBehaviour() => Ui.Run(async () =>
    {
        var workspace = new LinuxWorkspace(origin => new BellApi(origin, new ApprovalsFixture("connected")));
        await workspace.ConnectAsync("http://localhost", listen: false);
        var window = new ApprovalsWindow(new ApprovalsHub(workspace, (IDeviceDecisions?)new Device()), workspace, (_, _) => { }, _ => { });
        window.Show(); for (var wait = 0; wait < 100 && !window.Settled; wait++) await Task.Delay(20);
        try { Assert.False(Has(window, ChildJoinText.Title)); } finally { window.Close(); }
    });
}
