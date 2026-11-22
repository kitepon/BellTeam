using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// 決裁箱 window and entry (screen-spec.md; Core is ApprovalsTests): the screen over ApprovalsFixture, the real API reads and the real drawing.
public sealed class ApprovalsWindowTests
{
    // Records what the page sends (the answer's body and key) and passes everything to the fixture.
    private sealed class Spy(HttpMessageHandler inner) : DelegatingHandler(inner)
    {
        public List<(string Method, string Path, string? Body, string? Key)> Sent { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(token);
            lock (Sent) Sent.Add((request.Method.Method, request.RequestUri!.PathAndQuery, body, request.Headers.TryGetValues("Idempotency-Key", out var key) ? key.Single() : null));
            return await base.SendAsync(request, token);
        }
    }
    private sealed record Rig(Workspace Workspace, ApprovalsHub Hub, ApprovalsWindow Window, Spy Spy) : IDisposable
    {
        public ApprovalsPage Page => Window.Page;
        public void Dispose() { Page.Stop(); Window.Close(); Hub.Dispose(); Workspace.Dispose(); }
    }
    private static Rig Open(string scene, IDeviceDecisions? device = null)
    {
        var spy = new Spy(new ApprovalsFixture(scene));
        var workspace = new Workspace(origin => new BellApi(origin, spy));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        var hub = new ApprovalsHub(workspace, device: device); var window = new ApprovalsWindow(hub) { Rendering = true };
        window.Sync();
        return new Rig(workspace, hub, window, spy);
    }
    private static List<string> Texts(ApprovalsWindow window)
        => LogicalTree.Find<TextBlock>(window.Content).Select(text => text.Text).Concat(LogicalTree.Find<TextBox>(window.Content).Select(box => box.Text)).ToList();
    private static Button Find(ApprovalsWindow window, string key) => LogicalTree.Find<Button>(window.Content).First(button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == "ab:" + key);
    private static void Press(Button button) => button.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent, button));

    [Fact]
    public void TheListHoldsEveryDecisionAndNeverShowsAnId() => RunSta(() =>
    {
        using var rig = Open("main"); Until(() => rig.Page.Settled);
        Assert.Equal(["K-1", "K-2", "K-3", "K-4", "K-5"], rig.Page.Pending.Select(item => item.Id).Order());
        var texts = Texts(rig.Window);
        Assert.Contains("決裁箱拡張の月額を、決裁箱と同じ請求にしてよいですか？", texts);
        Assert.Contains("工程表「課金の設計」が、この回答を待っています", texts);
        Assert.Contains("工程表とはつながっていません", texts);          // the outside decision is shown, not hidden
        Assert.Contains(LatticeChart.UnknownMember, texts);              // a requester not on the roster
        Assert.DoesNotContain(texts, text => text.Contains("K-1", StringComparison.Ordinal) || text.Contains("bot-", StringComparison.Ordinal));
        Assert.Equal(1, rig.Spy.Sent.Count(call => call.Path == "/api/approvals/summary"));
    });

    [Fact]
    public void ChoosingOpensAConfirmInPlaceAndAnsweringSendsOneKeyedRequestWithTheVersion() => RunSta(() =>
    {
        using var rig = Open("main"); Until(() => rig.Page.Settled);
        rig.Page.Select("K-2"); rig.Page.Choose("o1");
        Assert.Equal("confirm", rig.Page.AnswerStep);
        Assert.Contains(Texts(rig.Window), text => text.StartsWith("「夜間だけにする」で答えますか？", StringComparison.Ordinal));
        Assert.True(rig.Window.Page.Escape()); Assert.Null(rig.Page.AnswerStep);   // Esc leaves the confirm, not the screen
        rig.Page.Choose("o1"); Press(Find(rig.Window, "confirm"));
        Until(() => rig.Page.AnswerStep is null && rig.Page.Pending.All(item => item.Id != "K-2" || item.Status == "answered"));
        var posts = rig.Spy.Sent.Where(call => call.Method == "POST" && call.Path == "/api/approvals/K-2/answer").ToList();
        var post = Assert.Single(posts);
        Assert.True(Guid.TryParse(post.Key, out _));
        using var json = JsonDocument.Parse(post.Body!);
        Assert.Equal(("o1", 1), (json.RootElement.GetProperty("optionId").GetString(), json.RootElement.GetProperty("version").GetInt32()));
        rig.Page.Show("K-2");
        Assert.Contains("答えました。アドミに届きました。", Texts(rig.Window));
    });

    [Fact]
    public void AConflictReplacesTheDecisionAndSendsNothingMore() => RunSta(() =>
    {
        using var rig = Open("conflict"); Until(() => rig.Page.Settled);
        rig.Page.Select("K-1"); rig.Page.Choose("o1"); Press(Find(rig.Window, "confirm"));
        Until(() => rig.Page.AnswerStep is null && Texts(rig.Window).Contains("答える前に、モリーが内容を直しました。もう一度、内容を確かめてください。"));
        Assert.Equal(3, rig.Page.Pending.First(item => item.Id == "K-1").Version);
        Assert.Single(rig.Spy.Sent, call => call.Method == "POST");                 // never answered by itself
        Assert.Contains(LogicalTree.Find<Button>(rig.Window.Content), button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == "ab:o:o1");   // the options are back on screen
    });

    [Fact]
    public void AnAnswerTheServerCouldNotCarryKeepsItsConfirmAndShowsWhatToDo() => RunSta(() =>
    {
        using var rig = Open("retry"); Until(() => rig.Page.Settled);
        rig.Page.Select("K-1"); rig.Page.Choose("o1"); Press(Find(rig.Window, "confirm"));
        Until(() => rig.Page.AnswerStep == "confirm" && Texts(rig.Window).Contains(Approvals.Retry));
        var key = rig.Spy.Sent.Single(call => call.Method == "POST").Key;
        Press(Find(rig.Window, "confirm"));                                          // the same press again: the same key
        Until(() => rig.Page.AnswerStep is null);
        Assert.Equal([key, key], rig.Spy.Sent.Where(call => call.Method == "POST").Select(call => call.Key));
    });

    [Fact]
    public void FilteringByOriginNeverChangesTheCountsAndSaysWhatItHides() => RunSta(() =>
    {
        using var rig = Open("main"); Until(() => rig.Page.Settled);
        rig.Page.SetOrigin("external");
        var texts = Texts(rig.Window);
        Assert.Contains("BellTeamの決裁 3件を隠しています。", texts);
        Assert.Contains("領収書の保存先を、共有フォルダにしてよいですか？", texts);
        Assert.DoesNotContain("席の自動更新を、夜間だけにしますか？", texts);
        Assert.Equal(4, Approvals.CountsOf(rig.Hub.Feed!.Summary).Pending);        // the toolbar counts every origin
        Assert.Contains("4", texts);
    });

    [Fact]
    public void AnUnknownDeliveryOffersTheResumePhraseAndNamesTheTool() => RunSta(() =>
    {
        using var rig = Open("main"); Until(() => rig.Page.Settled);
        rig.Page.SetTab(ApprovalsPage.Tab.Done); Until(() => rig.Page.Done.Count == 3); rig.Page.Select("K-7");
        var texts = Texts(rig.Window);
        Assert.Contains("届いたか不明", texts); Assert.Contains("外部から", texts);
        Assert.Contains("答えは保存しました。ただ、ChatGPTに届いたかを確かめられませんでした。念のため、再開の文をChatGPTの会話に貼ってください。", texts);
        Assert.Contains("つながっていません", texts);
        Assert.DoesNotContain(texts, text => text.Contains("次の担当", StringComparison.Ordinal));
        Assert.Equal("再開の文をコピー", (string)Find(rig.Window, "copy").Content);
    });

    [Theory]
    [InlineData("not-entitled", "決裁箱の拡張は、まだ使えません。")]
    [InlineData("expired", "決裁箱の契約が切れています。")]
    [InlineData("old", "このサーバーではまだ決裁箱の拡張を使えません。")]
    public void ARefusalThatWaitingDoesNotCureShowsItsWordsAndALeaveOnTheSameScreen(string scene, string start) => RunSta(() =>
    {
        using var rig = Open(scene); Until(() => rig.Page.Settled);
        var texts = Texts(rig.Window);
        Assert.Contains(texts, text => text.StartsWith(start, StringComparison.Ordinal));
        Assert.Contains(LogicalTree.Find<Button>(rig.Window.Content), button => button.Content as string is "閉じる" or "契約を確かめる" or "読み直す");
        Assert.DoesNotContain("待ち", LogicalTree.Find<Button>(rig.Window.Content).Select(button => button.Content as string));   // no list behind it
    });

    [Fact]
    public void NotConnectedOpensTheConsentPageOnceAndWaitsForTheModule() => RunSta(() =>
    {
        using var rig = Open("not-connected"); Until(() => rig.Page.Settled);
        Assert.Contains(Approvals.NoCredential, Texts(rig.Window));
        string? opened = null; rig.Page.OpenUrl = url => { opened = url; return true; };
        Press(Find(rig.Window, "connect:go"));
        Until(() => rig.Page.ConnectPhase == "waiting");
        Assert.Equal("https://approval.example/consent?code=abc", opened);
        Assert.Contains(Approvals.Waiting, Texts(rig.Window));
        Assert.Contains(LogicalTree.Find<Button>(rig.Window.Content), button => button.Content as string == "もう一度開く");
        Assert.Contains(LogicalTree.Find<Button>(rig.Window.Content), button => button.Content as string == "やめる");
        Press(Find(rig.Window, "connect:cancel"));
        Until(() => rig.Page.ConnectPhase == "idle");
        Assert.Contains(rig.Spy.Sent, call => call.Method == "DELETE" && call.Path == "/api/approvals/connect");
    });

    [Fact]
    public void AnAnswerThatTheOwnerDeniedOffersTheConnectAgain() => RunSta(() =>
    {
        using var rig = Open("denied"); Until(() => rig.Page.Settled && rig.Page.ConnectPhase == "denied");
        Assert.Contains(Approvals.Denied, Texts(rig.Window));
        Assert.Contains(LogicalTree.Find<Button>(rig.Window.Content), button => button.Content as string == "もう一度つなぐ");
    });

    [Theory]
    [InlineData("main", "あなたの回答を待っています", 4, true)]
    [InlineData("empty", "待っている決裁はありません", 0, false)]
    public void TheEntryRowShowsTheCountTheBoltAndCallsTheWindow(string scene, string line, int pending, bool urgent) => RunSta(() =>
    {
        var workspace = new Workspace(origin => new BellApi(origin, new ApprovalsFixture(scene)));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        using var hub = new ApprovalsHub(workspace); var row = new ApprovalsEntryRow(); row.Attach(hub);
        Until(() => hub.Feed?.Summary is not null);
        Assert.Equal((pending, urgent, line), (row.View.Pending, row.View.Urgent, row.View.Sub));
        Assert.Equal(pending > 0 ? $"決裁箱、回答待ち{pending}件" : "決裁箱", System.Windows.Automation.AutomationProperties.GetName(row));
        string? asked = "unset"; hub.Show = id => asked = id; Press(row);
        Assert.Null(asked);
        hub.Feed!.Stop(); workspace.Dispose();
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

    // The device side of the page: a book the test fills and an answer sink that records what the page sent.
    private sealed class FakeDevice : IDeviceDecisions
    {
        public BellTeam.PeerChannel.DecisionBook Book { get; } = new();
        public BellTeam.PeerChannel.RuntimeState State { get; set; } = new(BellTeam.PeerChannel.RuntimeStatus.Live);
        public event Action? Changed;
        public List<(string Id, string? Option, string? Text)> Answers { get; } = [];
        public int Refreshed;
        public Task<BellTeam.PeerChannel.SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text) { Answers.Add((decisionId, optionId, text)); return Task.FromResult(new BellTeam.PeerChannel.SendOutcome("ok")); }
        public Task<BellTeam.PeerChannel.SendOutcome> HoldAsync(string decisionId, bool held) => Task.FromResult(new BellTeam.PeerChannel.SendOutcome("ok"));
        public void Refresh() => Refreshed++;
        public void Raise() => Changed?.Invoke();
        public void Add(string rid, string decisionId, string title)
        {
            var json = "{\"rid\":\"" + rid + "\",\"rv\":1,\"schema\":\"approval-box/decision@1\",\"content\":{\"decision_id\":\"" + decisionId + "\",\"title\":\"" + title + "\",\"context\":\"本文\",\"options\":[{\"id\":\"o1\",\"label\":\"はい\"}],\"urgency\":\"normal\",\"source\":{\"client\":\"codex\",\"session_label\":\"端末の席\",\"work_label\":\"w\"},\"created_at\":\"" + DateTimeOffset.UtcNow.ToString("O") + "\",\"version\":1}}";
            Book.Apply("request", JsonDocument.Parse(json).RootElement, System.Text.Encoding.UTF8.GetBytes(json), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }
    }

    [Fact]
    public void TheDeviceCopyWinsADeviceOnlyDecisionJoinsAndEachCardNamesItsSource() => RunSta(() =>
    {
        var device = new FakeDevice(); device.Add("r2", "K-2", "端末の写し"); device.Add("r9", "K-9", "端末だけの決裁");
        using var rig = Open("main", device); Until(() => rig.Page.Settled);
        Assert.Equal(["K-1", "K-2", "K-3", "K-4", "K-5", "K-9"], rig.Page.Pending.Select(item => item.Id).Order());
        Assert.Equal(("device", "端末の写し"), (rig.Page.Pending.Single(item => item.Id == "K-2").Source, rig.Page.Pending.Single(item => item.Id == "K-2").Title));
        Assert.Equal("server", rig.Page.Pending.Single(item => item.Id == "K-1").Source);
        var texts = Texts(rig.Window);
        Assert.Contains("端末で受信", texts); Assert.Contains("サーバー経由", texts);
        Assert.Equal(1, rig.Page.Pending.Count(item => item.Id == "K-2"));
    });

    [Fact]
    public void WithoutADeviceTheListHasNoSourceTagsAndAVerifiedEmptyDeviceRemovesNothing() => RunSta(() =>
    {
        using (var plain = Open("main")) { Until(() => plain.Page.Settled); Assert.All(plain.Page.Pending, item => Assert.Null(item.Source)); Assert.DoesNotContain("サーバー経由", Texts(plain.Window)); }
        using var rig = Open("main", new FakeDevice()); Until(() => rig.Page.Settled);
        Assert.Equal(["K-1", "K-2", "K-3", "K-4", "K-5"], rig.Page.Pending.Select(item => item.Id).Order());
    });

    [Fact]
    public void AnAnswerGoesOnlyThroughTheSourceThatHoldsTheCopy() => RunSta(() =>
    {
        var device = new FakeDevice(); device.Add("r9", "K-9", "端末だけの決裁");
        using var rig = Open("main", device); Until(() => rig.Page.Settled);
        rig.Page.Select("K-9"); rig.Page.Choose("o1"); Press(Find(rig.Window, "confirm"));
        Until(() => device.Answers.Count == 1);
        Assert.Equal(("K-9", "o1", (string?)null), device.Answers[0]);
        Assert.DoesNotContain(rig.Spy.Sent, call => call.Method == "POST");
        Assert.Equal("sending", rig.Page.AnswerStep);                              // stays until the result frame closes it in the book
        device.Book.Close("r9", "answered", JsonDocument.Parse("{\"option_id\":\"o1\"}").RootElement, "dev", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); device.Raise();
        Until(() => rig.Page.AnswerStep is null);
        Assert.Equal("answered", rig.Page.Done.Single(item => item.Id == "K-9").Status);
        rig.Page.Select("K-1"); rig.Page.Choose("o1"); Press(Find(rig.Window, "confirm"));
        Until(() => rig.Page.AnswerStep is null);
        Assert.Single(rig.Spy.Sent, call => call.Method == "POST" && call.Path == "/api/approvals/K-1/answer");
        Assert.Single(device.Answers);                                              // never the same answer through both
    });

    [Fact]
    public void WhenTheServerIsNotConnectedTheDeviceListStaysAndTheConnectScreenIsOneButtonAway() => RunSta(() =>
    {
        var device = new FakeDevice(); device.Add("r9", "K-9", "端末だけの決裁");
        using var rig = Open("not-connected", device); Until(() => rig.Page.Settled);
        Assert.Equal(["K-9"], rig.Page.Pending.Select(item => item.Id));
        Assert.Contains("端末だけの決裁", Texts(rig.Window)); Assert.Contains(Approvals.ServerSideNoCredential, Texts(rig.Window));
        Press(Find(rig.Window, "legacy:つなぐ"));
        Until(() => Texts(rig.Window).Contains(Approvals.NoCredential) || Texts(rig.Window).Contains(Approvals.Waiting));
        Press(Find(rig.Window, "connect:back"));
        Assert.Contains("端末だけの決裁", Texts(rig.Window));
    });

    [Fact]
    public void ADeviceThatIsNotLiveSaysWhyAndKeepsEveryServerDecision() => RunSta(() =>
    {
        var device = new FakeDevice { State = new(BellTeam.PeerChannel.RuntimeStatus.Retrying, "接続できません") };
        using var rig = Open("main", device); Until(() => rig.Page.Settled);
        Assert.Contains(Approvals.DeviceReconnecting("接続できません"), Texts(rig.Window));
        Assert.Equal(5, rig.Page.Pending.Count);
        device.State = new(BellTeam.PeerChannel.RuntimeStatus.NeedsAdmission); device.Raise();
        Assert.Contains(Approvals.DeviceNeedsApproval, Texts(rig.Window));
        rig.Page.Reload(); Assert.Equal(1, device.Refreshed);
    });

    [Fact]
    public void TheDeviceStatesShowDeltasCopyForEndedSignInDeletedAccountAndRemovedDevice() => RunSta(() =>
    {
        var device = new FakeDevice { State = new(BellTeam.PeerChannel.RuntimeStatus.SignedOut, "pass_ended") };
        using var rig = Open("main", device); Until(() => rig.Page.Settled);
        Assert.Contains(Approvals.DevicePassEnded, Texts(rig.Window));
        device.State = new(BellTeam.PeerChannel.RuntimeStatus.SignedOut, "account_deleted"); device.Raise();
        Assert.Contains(Approvals.DeviceAccountDeleted, Texts(rig.Window));
        device.State = new(BellTeam.PeerChannel.RuntimeStatus.NeedsAdmission, "removed"); device.Raise();
        Assert.Contains(Approvals.DeviceRemoved, Texts(rig.Window));
        device.State = new(BellTeam.PeerChannel.RuntimeStatus.NotEntitled, "no_entitlement"); device.Raise();
        Assert.Contains(Approvals.DeviceNotEntitled, Texts(rig.Window));
        Assert.Equal(5, rig.Page.Pending.Count);                                  // no state hides a decision
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
