using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// a485, shape 2 (app-sessions.md section 7): start, show the code, poll, keep the token; the Bearer header; the DPAPI token file; the connect screen. Cases follow the Linux AppLoginTests.
public sealed class AppLoginTests
{
    private sealed class Server(params string[] polls) : HttpMessageHandler
    {
        public readonly List<string> Calls = []; public string? Authorization, ConsoleBody; public int PollCount; public int FailPolls;
        public string Sessions = """{"sessions":[{"id":"S1","kind":"windows","origin":"phone","networkClass":"lan","createdAt":"2026-11-20T10:00:00.000Z","lastUsedAt":"2026-11-21T10:00:00.000Z","current":true},{"id":"S2","kind":"web","origin":"added","networkClass":"unknown","createdAt":"2026-11-21T09:00:00.000Z","issuedBy":"S1","current":false}]}""";
        private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var path = request.RequestUri!.AbsolutePath; Calls.Add(request.Method + " " + path);
            Authorization = request.Headers.Authorization?.ToString();
            if (path == "/api/login/start") return Json("""{"loginId":"L1","status":"waiting_second_hand","expiresAt":"2999-01-01T00:00:00.000Z","pollAfterMs":3000}""");
            if (path == "/api/login/L1/cancel") return Json("""{"loginId":"L1","status":"cancelled"}""");
            if (path == "/api/login/console") { ConsoleBody = await request.Content!.ReadAsStringAsync(token); return ConsoleBody.Contains("GOOD") ? Json("""{"status":"approved","sessionId":"S1","token":"tok-console"}""") : Json("""{"error":"LOGIN_CODE_INVALID"}""", HttpStatusCode.Forbidden); }
            if (path == "/api/home/sessions/S1") return Json("""{"ok":true}""");
            if (path == "/api/sessions") return Json(Sessions);
            if (path == "/api/sessions/S2") { Sessions = """{"sessions":[]}"""; return Json("""{"id":"S2","status":"ended"}"""); }
            if (path == "/api/login/L1")
            {
                if (FailPolls-- > 0) return Json("""{"error":"LOGIN_RATE_LIMITED"}""", (HttpStatusCode)429);
                return Json(polls[Math.Min(PollCount++, polls.Length - 1)]);
            }
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }
    }
    private const string Phone = """{"loginId":"L1","status":"waiting_phone","expiresAt":"2999-01-01T00:00:00.000Z","phone":{"shortCode":"0123-4567","checkNumber":"042","qr":"bt://x"}}""";
    private static LoginApi Api(Server server) => new(new BellApi(new("http://localhost/"), server));
    private static readonly Func<int, CancellationToken, Task> NoWait = (_, _) => Task.CompletedTask;

    [Fact]
    public async Task ItWaitsForTheSecondHandThenThePhoneAndReceivesTheTokenOnce()
    {
        var server = new Server("""{"loginId":"L1","status":"waiting_second_hand"}""", Phone, """{"loginId":"L1","status":"approved","token":"tok-1"}""");
        var flow = new LoginFlow(Api(server), "windows", NoWait); var seen = new List<LoginPhase>(); string? code = null; flow.Changed += () => { seen.Add(flow.Phase); if (flow.Phase == LoginPhase.WaitingPhone) code = flow.Status!.Phone!.ShortCode; };
        await flow.RunAsync(default);
        Assert.Equal(LoginPhase.Approved, flow.Phase); Assert.Equal("tok-1", flow.Token);
        Assert.Contains(LoginPhase.WaitingPhone, seen); Assert.Equal("0123-4567", code);
        Assert.Equal(1, server.Calls.Count(call => call == "POST /api/login/start"));   // start is never resent
    }

    [Fact]
    public async Task ARefusedExpiredOrLostLoginEndsWithItsSentenceAndAFailedPollIsRetriedWithoutLimit()
    {
        var refused = new LoginFlow(Api(new Server("""{"loginId":"L1","status":"refused","reason":"not_owner_account"}""")), "windows", NoWait); await refused.RunAsync(default);
        Assert.Equal(LoginPhase.Refused, refused.Phase); Assert.Equal(LoginFlow.RefusedText("not_owner_account"), refused.Message);
        var expired = new LoginFlow(Api(new Server("""{"loginId":"L1","status":"expired"}""")), "windows", NoWait); await expired.RunAsync(default);
        Assert.Equal(LoginPhase.Failed, expired.Phase); Assert.Equal("ログインの時間が切れました。もう一度始めてください。", expired.Message);
        var delivered = new LoginFlow(Api(new Server("""{"loginId":"L1","status":"delivered"}""")), "windows", NoWait); await delivered.RunAsync(default);
        Assert.Equal(LoginPhase.Failed, delivered.Phase);   // the token comes once; a later "delivered" without it means it was lost
        var flaky = new Server("""{"loginId":"L1","status":"approved","token":"tok-2"}""") { FailPolls = 5 };
        var retried = new LoginFlow(Api(flaky), "windows", NoWait); await retried.RunAsync(default);
        Assert.Equal("tok-2", retried.Token); Assert.True(flaky.Calls.Count(call => call == "GET /api/login/L1") >= 6);
    }

    private sealed class Probe(string session, HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
            => Task.FromResult(new HttpResponseMessage(request.RequestUri!.AbsolutePath == "/api/session" ? status : HttpStatusCode.NotFound) { Content = new StringContent(session, Encoding.UTF8, "application/json") });
    }

    [Fact]
    public async Task AnEnforcingServerRoutesToItsOwnLoginAnOldOneKeepsAccessAndAnUnjudgeableOneKeepsTheToken()
    {
        using var enforced = new Workspace(origin => new BellApi(origin, new Probe("""{"authenticated":false,"authMode":"local","login":{"capability":true,"bound":true,"enforced":true}}""")));
        await enforced.ConnectAsync("http://localhost:1/", listen: false);
        Assert.True(enforced.NeedsLogin); Assert.True(enforced.SessionLoginRequired);
        using var old = new Workspace(origin => new BellApi(origin, new Probe("""{"authenticated":false,"authMode":"cloudflare"}""")));
        await old.ConnectAsync("http://localhost:1/", listen: false);
        Assert.True(old.NeedsLogin); Assert.False(old.SessionLoginRequired);
        using var busy = new Workspace(origin => new BellApi(origin, new Probe("""{"error":"SESSION_STORE_UNAVAILABLE"}""", HttpStatusCode.ServiceUnavailable)));
        await busy.ConnectAsync("http://localhost:1/", listen: false);
        Assert.False(busy.NeedsLogin); Assert.True(busy.ConnectionRetryable); Assert.Equal("サーバーの準備中です。", busy.ConnectionError);
    }

    [Fact]
    public async Task TheSessionTokenIsABearerHeaderAndSignOutDeletesTheSession()
    {
        var server = new Server("{}"); using var api = new BellApi(new("http://localhost/"), server) { SessionToken = "abc" };
        await api.GetAsync<System.Text.Json.JsonElement>("/api/login/L1");
        Assert.Equal("Bearer abc", server.Authorization);
        await new PlanningApi(api).EndHomeSessionAsync("S1");
        Assert.Equal("DELETE /api/home/sessions/S1", server.Calls.Last());
    }

    private static Kitepon.LoginBilling.Desktop.DesktopLocal Local() => new(LocalFormConfig.Build(), new Kitepon.LoginBilling.Desktop.MemoryPassStore());

    // Mint 2026-11-23: makeRequest("google") signs in by itself (it opens Google's page, then listens). Rapi's table: the card offers 「QRを出す（Google）」 and nothing opens before it is pressed.
    [Fact]
    public void TheFirstRunOffersTheQrButtonThenWaitsForTheBrowserThenOffersItAgainWhenStoppedAndNeverOffersTheNextStepBeforeAPhoneAnswered() => RunSta(() =>
    {
        var opened = new List<Uri>(); var before = AccountStore.OpenBrowser; AccountStore.OpenBrowser = uri => { opened.Add(uri); return Task.CompletedTask; };
        try
        {
            var gate = new AccountGateView(Local(), () => { });
            Until(() => Texts(gate).Contains(LocalFormText.StatusUnpaid)); Assert.Empty(opened);   // nothing opens before the person presses the button
            Assert.Contains(LocalFormText.CardTitle, Texts(gate)); Assert.Contains(LocalFormText.Title, Texts(gate)); Assert.Contains(LocalFormText.Lead, Texts(gate)); Assert.DoesNotContain(SignInText.Apple, Texts(gate));
            Click(gate, LocalFormText.Google); Until(() => opened.Count == 1);
            Assert.Contains(SignInText.Waiting, Texts(gate)); Assert.False(gate.Account.Entitled);
            Assert.DoesNotContain(Descendants<Button>(gate), b => b.Visibility == Visibility.Visible && System.Windows.Automation.AutomationProperties.GetName(b) == StoreAccountText.GateNext);
            Click(gate, SignInText.Cancel); Until(() => Descendants<Button>(gate).Any(b => System.Windows.Automation.AutomationProperties.GetName(b) == LocalFormText.Google));
            gate.Dispose();
        }
        finally { AccountStore.OpenBrowser = before; }
    });

    [Fact]
    public void WhatATryEndedWithIsTheTablesSentenceAndAPcNamesThePrivateNetworkStep()
    {
        Assert.Equal(LocalFormText.Of(LocalFormOutcome.PrivateNetwork), AccountView.SentenceOf(new Kitepon.LoginBilling.Desktop.LoginBillingException("unreachable_same_wifi", 0, null)));
        Assert.Equal(LocalFormText.Failure("other_account"), AccountView.SentenceOf(new Kitepon.LoginBilling.Desktop.LoginBillingException("other_account", 0, null)));
        Assert.Null(AccountView.SentenceOf(new Kitepon.LoginBilling.Desktop.LoginBillingException("signin_cancelled", 0, null)));
        Assert.Equal(SignInText.ReturnNotReceived, AccountView.SentenceOf(new Kitepon.LoginBilling.Desktop.LoginBillingException("return_not_received", 0, null)));
    }

    [Fact]
    public void TheDeletionWordsAreRapisFinalTableWithOnlyTheStoreSentencesChangedAndTheReasonsAreTheThree()
    {
        Assert.Equal(("アカウントを削除", "アカウントを削除しますか？", "削除する", "やめる", "アカウントを削除しました"), (AccountDeletionText.Button, AccountDeletionText.ConfirmTitle, AccountDeletionText.ConfirmYes, AccountDeletionText.ConfirmNo, AccountDeletionText.ResultTitle));
        const string store = "<store>";
        Assert.Equal("この端末のBellTeamのサインインと、受け取った購読の確認を消します。決裁箱のサインインと鍵、サーバーのトークン、保存した会話の写しも消して、最初の画面に戻ります。BellTeamは、名前・メールアドレス・購入の記録を、サーバーにも運営にも持っていません。決裁箱は、サインインを終えるだけです。決裁箱のアカウントと申請は消えません。消すには、決裁箱のアプリでアカウントを削除してください。決裁箱の運営には、止めたサインインのランダムな番号も最長14日残ります。ほかの端末のサインインは、その端末で終えてください。" + store + "サーバーの会話や設定は消えません。", AccountDeletionText.ConfirmBody(store));
        Assert.Equal("この端末のサインインとデータを消しました。BellTeamの運営は、あなたに関する情報を持っていません。あなたのサーバーの会話と設定は残ります。決裁箱のアカウントは、決裁箱のアプリで削除するまで残ります。" + store, AccountDeletionText.ResultBody(store));
        Assert.Equal("アカウントの削除を終えられませんでした", AccountDeletionText.FailedTitle);
        Assert.Equal("決裁箱のサインインを消せませんでした（ネットワークにつながっていません）。つながる場所でもう一度「アカウントを削除」を押すと、続きから終えます。すでに終えた手順はそのままです。", AccountDeletionText.Failed("決裁箱のサインイン", AccountDeletionText.NoNetwork));
        Assert.Equal(AccountDeletionText.NoNetwork, MainWindow.ReasonOf(new InvalidOperationException("x", new HttpRequestException("offline"))));
        Assert.Equal(("決裁箱の運営に届きません", "処理できませんでした"), (MainWindow.ReasonOf(new Kitepon.LoginBilling.Desktop.LoginBillingException("server_error", 503, null)), MainWindow.ReasonOf(new IOException("locked"))));
        Assert.DoesNotContain("Apple Account", AccountDeletionText.Subscription + AccountDeletionText.Cancel);
    }

    [Fact]
    public void TheDeleteButtonIsTheLastItemOfTheCardAndOnlyWhereAWayToDeleteIsGiven() => RunSta(() =>
    {
        var deleted = 0; var card = new AccountView(Local(), () => deleted++);
        Assert.Equal(AccountDeletionText.Button, System.Windows.Automation.AutomationProperties.GetName(Descendants<Button>(card).Last()));   // last, below the sign-in entry
        Click(card, AccountDeletionText.Button); Assert.Equal(1, deleted);
        Assert.DoesNotContain(Descendants<Button>(new AccountView(Local())), b => System.Windows.Automation.AutomationProperties.GetName(b) == AccountDeletionText.Button);   // the first-run gate has none
        card.Dispose();
    });

    [Fact]
    public void TheHandoffQrIsDrawnFromTheGivenTextAsAMatrix() => RunSta(() =>
    {
        var qr = new QrView("bellteam://handoff/ABC", 200); qr.Measure(new Size(200, 200)); qr.Arrange(new Rect(0, 0, 200, 200));
        Assert.Equal(200, qr.Width); Assert.Equal(200, qr.ActualWidth);
    });

    private static string[] Texts(DependencyObject root) => Descendants<TextBlock>(root).Select(text => text.Text).ToArray();
    private static void Click(DependencyObject root, string name) => Descendants<Button>(root).Single(button => System.Windows.Automation.AutomationProperties.GetName(button) == name).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
    private static IEnumerable<T> Descendants<T>(DependencyObject root) where T : DependencyObject { if (root is T found) yield return found; foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()) foreach (var item in Descendants<T>(child)) yield return item; }
    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Until(Func<bool> done) { var until = DateTime.UtcNow.AddSeconds(5); while (!done()) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(2); } }
    private static void RunSta(Action action)
    {
        Exception? failure = null; var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
