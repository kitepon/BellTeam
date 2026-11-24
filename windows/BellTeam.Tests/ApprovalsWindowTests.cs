using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// 決裁箱 window and entry (screen-spec.md; Core is ApprovalsTests): since the /v1 close (2026-12-12) the list, answers, holds and images are this device's session; BellTeam adds the chart links (by-decision)
// and the one 工程表との連携 connection. The screen over ApprovalsFixture and its stand-in device, the real API reads and the real drawing.
public sealed class ApprovalsWindowTests
{
    private sealed record Rig(Workspace Workspace, ApprovalsHub Hub, ApprovalsWindow Window, ApprovalsFixture Server, ApprovalsFixture.Demo? Device) : IDisposable
    {
        public ApprovalsPage Page => Window.Page;
        public void Dispose() { Page.Stop(); Window.Close(); Hub.Dispose(); Workspace.Dispose(); }
    }
    // scene: the module's (connected, main = not connected, waiting, gone, unreadable); device: the stand-in session (null = this PC has none).
    private static Rig Open(string scene = "connected", ApprovalsFixture.Demo? device = null, bool noDevice = false)
    {
        var server = new ApprovalsFixture(scene);
        var workspace = new Workspace(origin => new BellApi(origin, server));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        var session = noDevice ? null : device ?? new ApprovalsFixture.Demo().Fill();
        var hub = new ApprovalsHub(workspace, device: session); var window = new ApprovalsWindow(hub) { Rendering = true };
        window.Sync();
        return new Rig(workspace, hub, window, server, session);
    }
    private static List<string> Texts(ApprovalsWindow window)
        => LogicalTree.Find<TextBlock>(window.Content).Select(text => text.Text).Concat(LogicalTree.Find<TextBox>(window.Content).Select(box => box.Text)).ToList();
    // The reconnect pill (a Border carrying the status text) is hidden unless the device is retrying: the text itself is always set.
    private static bool PillShown(ApprovalsWindow window) => IsShown(LogicalTree.Find<TextBlock>(window.Content).Single(text => System.Windows.Automation.AutomationProperties.GetAutomationId(text) == "approvals-status"));
    // Up to the page: an unshown test window reports itself collapsed.
    private static bool IsShown(DependencyObject at) { for (; at is not null and not Window; at = LogicalTreeHelper.GetParent(at)) if (at is UIElement { Visibility: not Visibility.Visible }) return false; return true; }
    private static Button Find(ApprovalsWindow window, string key) => LogicalTree.Find<Button>(window.Content).First(button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == "ab:" + key);
    private static void Press(Button button) => button.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent, button));

    [Fact]
    public void TheListIsTheDevicesBookAndNeverShowsAnId() => RunSta(() =>
    {
        using var rig = Open(); Until(() => rig.Page.Settled);
        Assert.Equal(["K-1", "K-2", "K-3", "K-4", "K-5"], rig.Page.Pending.Select(item => item.Id).Order());
        var texts = Texts(rig.Window);
        Assert.Contains("決裁箱拡張の月額を、決裁箱と同じ請求にしてよいですか？", texts);
        Assert.Contains("工程表とはつながっていません", texts);          // the outside decision is shown, not hidden
        Assert.Contains(texts, text => text.StartsWith("Claude Code", StringComparison.Ordinal)); Assert.Equal(2, texts.Count(text => text == "外部から"));   // a bot id that is not on the roster is no BellTeam member (origin rule, client-v0.5): it draws as an outside decision
        Assert.DoesNotContain(texts, text => text.Contains("K-1", StringComparison.Ordinal) || text.Contains("bot-", StringComparison.Ordinal));
        Assert.DoesNotContain(texts, text => text == "端末で受信" || text == "サーバー経由");   // one source: no source tags
        Assert.DoesNotContain(rig.Server.Sent, call => call.Path is "/api/approvals/summary" or "/api/approvals" or "/api/approvals/events");
    });

    [Fact]
    public void TheChartLinkOfADecisionComesFromTheIdLevelLookupAndNeverFromTheListRead() => RunSta(() =>
    {
        using var rig = Open(); Until(() => rig.Page.Settled && rig.Page.Pending.First(item => item.Id == "K-1").Link is not null);
        Assert.Equal("linked", rig.Page.Pending.First(item => item.Id == "K-1").Link!.State);
        Assert.Null(rig.Page.Pending.First(item => item.Id == "K-3").Link);       // 404 = not linked
        Assert.True(rig.Server.LinkReads >= 5);
        rig.Page.Select("K-1");
        Assert.NotNull(Find(rig.Window, "chart"));                                  // 工程表で見る
    });

    [Fact]
    public void ChoosingOpensAConfirmInPlaceAndAnsweringGoesThroughTheDeviceOnceAndClosesInTheBook() => RunSta(() =>
    {
        using var rig = Open(); Until(() => rig.Page.Settled);
        rig.Page.Select("K-2"); rig.Page.Choose("o1");
        Assert.Equal("confirm", rig.Page.AnswerStep);
        Assert.Contains(Texts(rig.Window), text => text.StartsWith("「夜間だけにする」で答えますか？", StringComparison.Ordinal));
        Assert.True(rig.Window.Page.Escape()); Assert.Null(rig.Page.AnswerStep);   // Esc leaves the confirm, not the screen
        rig.Page.Choose("o1"); Press(Find(rig.Window, "confirm"));
        Until(() => rig.Page.AnswerStep is null && rig.Page.Done.Any(item => item.Id == "K-2"));
        Assert.Equal([("K-2", "o1", (string?)null)], rig.Device!.Answers);
        Assert.DoesNotContain(rig.Server.Sent, call => call.Method == "POST" && call.Path.EndsWith("/answer", StringComparison.Ordinal));
        rig.Page.Show("K-2");
        Assert.Contains(Texts(rig.Window), text => text.StartsWith("答えました。", StringComparison.Ordinal));
    });

    [Fact]
    public void AnAmendedDecisionKeepsTheAnswerOutAndNamesWhoAmendedAndAnUnknownOrFailedSendKeepsItsConfirm() => RunSta(() =>
    {
        var device = new ApprovalsFixture.Demo().Fill();
        using var rig = Open(device: device); Until(() => rig.Page.Settled);
        rig.Page.Select("K-1"); rig.Page.Choose("o1"); device.Ack = "refused:stale_version"; Press(Find(rig.Window, "confirm"));
        Until(() => rig.Page.AnswerStep is null && Texts(rig.Window).Contains(Approvals.AmendedPlain));
        rig.Page.Select("K-2"); rig.Page.Choose("o1"); device.Ack = "unknown"; Press(Find(rig.Window, "confirm"));
        Until(() => rig.Page.AnswerStep == "confirm" && Texts(rig.Window).Contains(Approvals.DeviceUnknown));
        device.Ack = "failed"; Press(Find(rig.Window, "confirm"));
        Until(() => rig.Page.AnswerStep == "confirm" && Texts(rig.Window).Contains(Approvals.Retry));
        Assert.Equal(["K-1", "K-2", "K-2"], device.Answers.Select(answer => answer.Id));
    });

    [Fact]
    public void HoldingAndTheFilterWorkOnTheDevicesBook() => RunSta(() =>
    {
        using var rig = Open(); Until(() => rig.Page.Settled);
        rig.Page.Select("K-4"); Press(Find(rig.Window, "hold"));
        Until(() => rig.Device!.Holds.Count == 1);
        Assert.Equal(("K-4", true), rig.Device!.Holds[0]);
        Assert.Equal("held", rig.Page.Pending.Single(item => item.Id == "K-4").Status);
        rig.Page.SetOrigin("external");
        var texts = Texts(rig.Window);
        Assert.Contains("BellTeamの決裁 2件を隠しています。", texts);          // K-1 and K-2 (K-4 is held now)
        Assert.Contains("領収書の保存先を、共有フォルダにしてよいですか？", texts);
        Assert.DoesNotContain("席の自動更新を、夜間だけにしますか？", texts);
    });

    [Fact]
    public void ABellTeamDecisionTheEngineAnswered404ForSaysItFoundNoTask_NeverPendingForever() => RunSta(() =>
    {
        using var rig = Open(); Until(() => rig.Page.Settled && rig.Server.LinkReads >= 5);
        Until(() => Texts(rig.Window).Contains("この決裁に合う工程は、工程表に見つかっていません"));
        Assert.DoesNotContain("工程表につなげています", Texts(rig.Window));          // every BellTeam decision has been answered by the engine now (K-1 linked, the rest 404)
        Assert.Contains("工程表とはつながっていません", Texts(rig.Window));         // an external decision keeps its own line
    });

    [Fact]
    public void TheDoneTabHoldsTheAnsweredAndTheWithdrawnWithTheDeliveryNote() => RunSta(() =>
    {
        using var rig = Open(); Until(() => rig.Page.Settled);
        rig.Page.SetTab(ApprovalsPage.Tab.Done); Assert.Equal(["K-6", "K-7"], rig.Page.Done.Select(item => item.Id).Order());
        rig.Page.Select("K-6");
        Assert.Contains("答えました。モリーが会話に戻ると受け取ります。", Texts(rig.Window));
    });

    [Theory]
    [InlineData("pending", "あなたの回答を待っています", 4, true)]
    [InlineData("empty", "待っている決裁はありません", 0, false)]
    public void TheEntryRowShowsTheDevicesCountTheBoltAndCallsTheWindow(string which, string line, int pending, bool urgent) => RunSta(() =>
    {
        var server = new ApprovalsFixture("connected"); using var workspace = new Workspace(origin => new BellApi(origin, server));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        using var hub = new ApprovalsHub(workspace, device: which == "empty" ? new ApprovalsFixture.Demo() : new ApprovalsFixture.Demo().Fill()); var row = new ApprovalsEntryRow(); row.Attach(hub);
        Assert.Equal((pending, urgent, line), (row.View.Pending, row.View.Urgent, row.View.Sub));
        Assert.Equal(pending > 0 ? $"決裁箱、回答待ち{pending}件" : "決裁箱", System.Windows.Automation.AutomationProperties.GetName(row));
        string? asked = "unset"; hub.Show = id => asked = id; Press(row);
        Assert.Null(asked);
    });

    [Fact]
    public void ThisPcWithoutADeviceSaysSoWithoutAFailureAndTheEntryOffersToOpenIt() => RunSta(() =>
    {
        using var rig = Open(noDevice: true); Until(() => rig.Page.Settled);
        var texts = Texts(rig.Window);
        Assert.Contains(Approvals.NotAvailable, texts); Assert.DoesNotContain(texts, text => text.StartsWith("このサーバーでは", StringComparison.Ordinal)); Assert.False(PillShown(rig.Window));
        Assert.Equal("決裁箱を開く", Approvals.EntryView(rig.Hub.Summary, null).Sub);
        Assert.NotNull(Find(rig.Window, "close-screen"));
    });

    [Theory]
    [InlineData("gone")]
    [InlineData("unreadable")]
    public void ARemovedOrUnreadableRouteIsAbsentNeverAFailureScreen(string scene) => RunSta(() =>
    {
        using var rig = Open(scene); Until(() => rig.Page.Settled);
        Assert.Equal(5, rig.Page.Pending.Count);                                    // the list is the device's
        var texts = Texts(rig.Window);
        Assert.DoesNotContain(texts, text => text.StartsWith("決裁箱につながっていません", StringComparison.Ordinal)); Assert.False(PillShown(rig.Window));
        Assert.DoesNotContain(texts, text => text.StartsWith("このサーバーでは", StringComparison.Ordinal));
        Assert.All(rig.Page.Pending, item => Assert.Null(item.Link));               // no link, no badge, no retry loop on screen
        rig.Page.Select("K-1"); Assert.Contains("決裁箱拡張の月額を、決裁箱と同じ請求にしてよいですか？", Texts(rig.Window));
        _ = rig.Page.OpenLinkAsync();
        Until(() => Texts(rig.Window).Contains("連携の状態を読めませんでした。少し待って、読み直してください。"));
        Press(Find(rig.Window, "connect:back")); Assert.Contains("決裁箱拡張の月額を、決裁箱と同じ請求にしてよいですか？", Texts(rig.Window));
    });

    [Fact]
    public void TheConnectionPanelConnectsOnceOpensTheConsentPageAndWaits() => RunSta(() =>
    {
        using var rig = Open("main"); Until(() => rig.Page.Settled);
        Press(Find(rig.Window, "link")); try { Until(() => Texts(rig.Window).Contains("工程表との連携は、まだつながっていません。つなぐと、決裁が工程表の工程につながります。")); } catch (TimeoutException) { throw new Exception("DUMP " + string.Join(" | ", Texts(rig.Window)) + " || " + string.Join(" | ", rig.Server.Sent)); }
        Assert.DoesNotContain("決裁箱拡張の月額を、決裁箱と同じ請求にしてよいですか？", Texts(rig.Window));   // the panel replaces the columns, it is not a gate on the list
        string? opened = null; rig.Page.OpenUrl = url => { opened = url; return true; };
        Press(Find(rig.Window, "connect:go"));
        Until(() => rig.Page.ConnectPhase == "waiting");
        Assert.Equal("https://approval.example/consent?code=abc", opened);
        Assert.Contains(Approvals.Waiting, Texts(rig.Window));
        Assert.Contains(LogicalTree.Find<Button>(rig.Window.Content), button => button.Content as string == "もう一度開く");
        Press(Find(rig.Window, "connect:cancel"));
        Until(() => rig.Page.ConnectPhase == "idle");
        Assert.Contains(rig.Server.Sent, call => call.Method == "DELETE" && call.Path == "/api/approvals/connect");
        Assert.Single(rig.Server.Sent, call => call.Method == "POST" && call.Path == "/api/approvals/connect");
    });

    [Fact]
    public void ADisconnectAsksFirstThenEndsTheConnectionAndLeavesTheListUntouched() => RunSta(() =>
    {
        using var rig = Open("connected"); Until(() => rig.Page.Settled);
        Press(Find(rig.Window, "link")); Until(() => Texts(rig.Window).Contains("工程表と連携しています。決裁が、工程表の工程につながります。"));
        Press(Find(rig.Window, "unlink")); Assert.DoesNotContain(rig.Server.Sent, call => call.Method == "DELETE");
        Press(Find(rig.Window, "unlink-no")); Assert.DoesNotContain(rig.Server.Sent, call => call.Method == "DELETE");
        Press(Find(rig.Window, "unlink")); Press(Find(rig.Window, "unlink-yes"));
        Until(() => Texts(rig.Window).Contains("工程表との連携は、まだつながっていません。つなぐと、決裁が工程表の工程につながります。"));
        Assert.Contains(rig.Server.Sent, call => call.Method == "DELETE" && call.Path == "/api/approvals/connection");
        Assert.Equal(5, rig.Page.Pending.Count);
    });

    [Fact]
    public void TheLatticeDetailOfADecisionCardOpensTheDecisionOnTheScreen() => RunSta(() =>
    {
        using var workspace = new Workspace(origin => new BellApi(origin, new LatticeFixture("owner")));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        using var hub = new ApprovalsHub(workspace, autostart: false); string? opened = null; hub.Show = id => opened = id; ApprovalsHub.Current = hub;
        try
        {
            var window = new LatticeWindow(workspace, _ => Task.CompletedTask) { Rendering = true };
            window.Sync(); Until(() => window.ListSettled);
            window.OpenChart("lattice"); var chart = window.Chart!; Until(() => chart.Feed.Snapshot is not null);
            chart.OpenDetail("p1/t11", morph: false); Until(() => chart.Decisions.ContainsKey("p1/t11"));
            var open = LogicalTree.Find<Button>(window.Content).Single(button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == "lattice-decision-open");
            Press(open);
            Assert.Equal("K-FIXTUR", opened);
            chart.Stop(); window.Close();
        }
        finally { ApprovalsHub.Current = null; }
    });

    [Fact]
    public void ADeviceThatIsNotLiveSaysWhyAndKeepsEveryDecision() => RunSta(() =>
    {
        var device = new ApprovalsFixture.Demo().Fill(); device.State = new(RuntimeStatus.Retrying, "接続できません");
        using var rig = Open(device: device); Until(() => rig.Page.Settled);
        Assert.Contains(Approvals.DeviceReconnecting, Texts(rig.Window)); Assert.DoesNotContain(Texts(rig.Window), text => text.Contains("接続できません")); Assert.True(PillShown(rig.Window));
        Assert.Equal(5, rig.Page.Pending.Count);
        device.State = new(RuntimeStatus.NeedsAdmission); device.Raise();
        Assert.Contains(Approvals.DeviceNeedsApproval, Texts(rig.Window));
        rig.Page.Reload(); Assert.Equal(1, device.Refreshed);
    });

    [Fact]
    public void TheDeviceStatesShowDeltasCopyForEndedSignInDeletedAccountAndRemovedDevice() => RunSta(() =>
    {
        var device = new ApprovalsFixture.Demo().Fill(); device.State = new(RuntimeStatus.SignedOut, "pass_ended");
        using var rig = Open(device: device); Until(() => rig.Page.Settled);
        Assert.Contains(Approvals.DevicePassEnded, Texts(rig.Window));
        device.State = new(RuntimeStatus.SignedOut, "account_deleted"); device.Raise();
        Assert.Contains(Approvals.DeviceAccountDeleted, Texts(rig.Window));
        device.State = new(RuntimeStatus.NeedsAdmission, "removed"); device.Raise();
        Assert.Contains(Approvals.DeviceRemoved, Texts(rig.Window));
        device.State = new(RuntimeStatus.NotEntitled, "no_entitlement"); device.Raise();
        Assert.Contains(Approvals.DeviceNotEntitled, Texts(rig.Window));
        Assert.Equal(5, rig.Page.Pending.Count);                                  // no state hides a decision
    });

    [Fact]
    public void SigningInShowsTheBrowserLineWithAnUndoAndAFailedTryShowsItsReason() => RunSta(() =>
    {
        var device = new ApprovalsFixture.Demo().Fill(); device.State = new(RuntimeStatus.SignedOut, "signed_out");
        using var rig = Open(device: device); Until(() => rig.Page.Settled);
        var cancelled = 0; rig.Hub.CancelSignIn = () => cancelled++; rig.Hub.SignInApprovalBox = () => { }; device.Raise();
        Assert.Contains(Approvals.DeviceSignedOut, Texts(rig.Window)); Assert.NotNull(Find(rig.Window, "legacy:Approval Boxにサインイン"));
        rig.Hub.SetSignIn(true);
        Assert.Contains(Approvals.DeviceSigningIn, Texts(rig.Window)); Assert.DoesNotContain(Approvals.DeviceSignedOut, Texts(rig.Window));
        Press(Find(rig.Window, "legacy:やめる")); Assert.Equal(1, cancelled);
        rig.Hub.SetSignIn(false, "サインインできませんでした。");
        Assert.Contains("サインインできませんでした。", Texts(rig.Window)); Assert.Contains(Approvals.DeviceSignedOut, Texts(rig.Window));
    });

    [Fact]
    public void SignedOutOffersTheBrowserAndTheQrHandoffAndTheHandoffShowsTheQrTheCodeAndTheCheckNumberWithAnUndo() => RunSta(() =>
    {
        var device = new ApprovalsFixture.Demo().Fill(); device.State = new(RuntimeStatus.SignedOut);
        using var rig = Open(device: device); Until(() => rig.Page.Settled);
        var started = 0; var cancelled = 0; rig.Hub.SignInApprovalBox = () => { }; rig.Hub.SignInByHandoff = () => started++; rig.Hub.CancelSignIn = () => cancelled++; device.Raise();
        Assert.Contains(Approvals.DeviceSignedOut, Texts(rig.Window)); Press(Find(rig.Window, "legacy:" + Approvals.DeviceHandoffStart)); Assert.Equal(1, started);
        rig.Hub.SetSignIn(true); rig.Hub.SetHandoff(new ApprovalHandoff("LB1:qr", "0123-4567", "042", DateTimeOffset.UtcNow.AddMinutes(5)));
        var texts = Texts(rig.Window);
        Assert.Contains(Approvals.DeviceHandoffHow, texts); Assert.Contains(StoreAccountText.HandoffCode + " 0123-4567", texts); Assert.Contains(StoreAccountText.HandoffCheckNumber + " 042", texts); Assert.DoesNotContain(Approvals.DeviceSignedOut, texts);
        Assert.Contains(LogicalTree.Find<FrameworkElement>(rig.Window.Content), element => element is QrView);
        Press(Find(rig.Window, "legacy:やめる")); Assert.Equal(1, cancelled);
        rig.Hub.SetHandoff(null); rig.Hub.SetSignIn(false); Assert.Contains(Approvals.DeviceSignedOut, Texts(rig.Window));
        Assert.Equal(5, rig.Page.Pending.Count);
    });

    [Fact]
    public void NeedsApprovalOffersTheAskThenShowsTheCodeAndQrAndTheNoteAfterItEnds() => RunSta(() =>
    {
        var device = new ApprovalsFixture.Demo().Fill(); device.State = new(RuntimeStatus.NeedsAdmission, "not_verified");
        using var rig = Open(device: device); Until(() => rig.Page.Settled);
        var asked = 0; var cancelled = 0; rig.Hub.RequestApproval = () => asked++; rig.Hub.CancelApproval = () => cancelled++; device.Raise();
        Assert.Contains(Approvals.DeviceNeedsApproval, Texts(rig.Window)); Press(Find(rig.Window, "legacy:" + Approvals.DeviceAskApproval)); Assert.Equal(1, asked);
        rig.Hub.SetOffer(new ApprovalOffer("ABCD-EFGH-JKMN-PQRS", "PC1VERIFY:x", DateTimeOffset.UtcNow.AddMinutes(5)));
        var texts = Texts(rig.Window);
        Assert.Contains("ABCD-EFGH-JKMN-PQRS", texts); Assert.Contains(Approvals.DeviceApprovalHow, texts); Assert.DoesNotContain(Approvals.DeviceNeedsApproval, texts);
        Assert.Contains(LogicalTree.Find<FrameworkElement>(rig.Window.Content), element => element is QrView);
        Press(Find(rig.Window, "legacy:やめる")); Assert.Equal(1, cancelled);
        rig.Hub.SetOffer(null, Approvals.DeviceApprovalExpired);
        Assert.Contains(Approvals.DeviceApprovalExpired, Texts(rig.Window)); Press(Find(rig.Window, "legacy:もう一度")); Assert.Equal(2, asked);
        Assert.Equal(5, rig.Page.Pending.Count);
    });

    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Await(Task task) { Until(() => task.IsCompleted); task.GetAwaiter().GetResult(); }
    private static void Until(Func<bool> done) { var until = DateTime.UtcNow.AddSeconds(10); while (!done()) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); } }
    private static void RunSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
