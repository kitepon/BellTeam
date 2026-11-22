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

    [Fact]
    public void ThePaywallSaysThatTheAppNeedsASubscriptionAndOffersARecheckAndAServerChangeButNoBrowser() => RunSta(() =>
    {
        int rechecked = 0, changed = 0; var view = new PaywallView(() => rechecked++, () => changed++);
        Assert.Contains("このアプリは購読が必要です。無料で使うには、公開されているソースコードから自分でビルドしたものを使ってください。", Texts(view));
        Assert.DoesNotContain(Descendants<Button>(view), button => System.Windows.Automation.AutomationProperties.GetName(button) == "ブラウザーで開く");
        Click(view, "再確認"); Click(view, "接続先を変更"); Assert.Equal((1, 1), (rechecked, changed));
    });

    [Fact]
    public void TheSignInEntryOffersAppleAndGoogleWithoutAConsoleCodeAndAsksForTheSetupCodeOnlyWhenTold() => RunSta(() =>
    {
        var chosen = new List<string>(); var cancelled = 0; var view = new SignInView(chosen.Add, () => cancelled++, ["apple", "google"]);
        Assert.Contains(SignInText.Title, Texts(view)); Assert.Contains(SignInText.Note, Texts(view));
        Assert.Empty(Descendants<TextBox>(view)); Assert.DoesNotContain(SignInText.SetupCodeLabel, Texts(view));
        Click(view, SignInText.Apple); Click(view, SignInText.Google); Assert.Equal(["apple", "google"], chosen);
        view.RequireSetupCode(true); Descendants<TextBox>(view).Single().Text = " ABC "; Assert.Equal("ABC", view.SetupCode);
        Assert.Contains(SignInText.SetupCodeLabel, Texts(view)); Assert.Contains(SignInText.SetupCodeHint, Texts(view));
        view.Show(SignInPhase.Waiting); Assert.Contains(SignInText.Waiting, Texts(view)); Assert.DoesNotContain(Descendants<Button>(view), b => System.Windows.Automation.AutomationProperties.GetName(b) == SignInText.Apple);
        Click(view, SignInText.Cancel); Assert.Equal(1, cancelled);
        view.Show(SignInPhase.ReturnNotReceived); Assert.Contains(SignInText.ReturnNotReceived, Texts(view));
        view.Show(SignInPhase.NotOwner); Assert.Contains(SignInText.NotOwner, Texts(view));
    });

    [Fact]
    public void TheFirstRunAsksToSignInWhenNoPassIsKeptAndSaysSoWhenNoWorkerIsSet() => RunSta(() =>
    {
        var gate = new AccountGateView(null, () => { });
        Assert.Contains(StoreAccountText.NotConfigured, Texts(gate)); Assert.DoesNotContain(Descendants<Button>(gate), b => b.Visibility == Visibility.Visible && System.Windows.Automation.AutomationProperties.GetName(b) == StoreAccountText.GateNext);
        gate.Dispose();
        var signedOut = new AccountGateView(new Kitepon.LoginBilling.Desktop.DesktopLoginBilling("http://127.0.0.1:1", new Kitepon.LoginBilling.Desktop.MemoryPassStore()), () => { });
        Until(() => signedOut.Account.SignedOut);
        Assert.Contains(SignInText.Title, Texts(signedOut)); Assert.Contains(SignInText.Google, Texts(signedOut)); Assert.DoesNotContain(SignInText.Apple, Texts(signedOut));   // Apple waits for the Owner's Apple sitting
        signedOut.Dispose();
    });

    [Fact]
    public void TheHandoffQrIsDrawnFromTheGivenTextAsAMatrix() => RunSta(() =>
    {
        var qr = new QrView("bellteam://handoff/ABC", 200); qr.Measure(new Size(200, 200)); qr.Arrange(new Rect(0, 0, 200, 200));
        Assert.Equal(200, qr.Width); Assert.Equal(200, qr.ActualWidth);
    });

    private sealed class MemoryHome : Kitepon.LoginBilling.Desktop.IHomeStore { public string? Record; public string? Read() => Record; public void Write(string record) => Record = record; public void Delete() => Record = null; }
    private sealed class HomeProbeHandler(string json) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => Task.FromResult(request.RequestUri!.AbsolutePath == "/api/home/session" ? new HttpResponseMessage { Content = new StringContent(json, Encoding.UTF8, "application/json") } : new HttpResponseMessage(HttpStatusCode.NotFound));
    }

    [Fact]
    public async Task OnlyAHomeServerAnswersTheProbeAndAnOlderOneIsLeftToTheNormalPath()
    {
        var home = await HomeGate.ProbeAsync(new Uri("http://localhost/"), default, new HomeProbeHandler("""{"capability":"login-billing-home/1","bound":false,"enforced":true}"""));
        Assert.True(home is { Bound: false, Enforced: true });
        Assert.Null(await HomeGate.ProbeAsync(new Uri("http://localhost/"), default, new HomeProbeHandler("""{"capability":"other"}""")));
        Assert.Null(await HomeGate.ProbeAsync(new Uri("http://localhost/"), default, new HomeProbeHandler("not json")));
    }

    [Fact]
    public void TheHomeScreenAsksForTheSetupCodeOnlyWhenUnboundAndSaysAnUnreachableServerAsSuch() => RunSta(() =>
    {
        var lb = new Kitepon.LoginBilling.Desktop.DesktopLoginBilling("http://127.0.0.1:1", new Kitepon.LoginBilling.Desktop.MemoryPassStore());
        var home = lb.HomeConnection(new MemoryHome());
        var unbound = new HomeConnectView(home, new HomeProbe { Capability = HomeGate.Capability, Bound = false }, new Uri("http://127.0.0.1:1/"), () => { }, () => { });
        Assert.Single(Descendants<TextBox>(unbound)); Assert.Contains(SignInText.SetupCodeLabel, Texts(unbound));
        Descendants<TextBox>(unbound).Single().Text = "ABCD"; unbound.Begin(); Until(() => unbound.Running.IsCompleted);
        Assert.Contains("サーバーに届きません。通信を確かめて、もう一度お試しください。", Texts(unbound));
        var bound = new HomeConnectView(home, new HomeProbe { Capability = HomeGate.Capability, Bound = true }, new Uri("http://127.0.0.1:1/"), () => { }, () => { });
        Until(() => bound.Running.IsCompleted); Assert.Empty(Descendants<TextBox>(bound)); Assert.Contains("サーバーに届きません。通信を確かめて、もう一度お試しください。", Texts(bound));
        unbound.Dispose(); bound.Dispose();
    });

    // a485 「アカウントを削除」: Rapi's reference words, the subscription sentences replaced by the Windows ones (a PC buys nothing).
    [Fact]
    public void TheDeletionWordsAreRapisReferenceWithOnlyTheSubscriptionSentencesChanged()
    {
        Assert.Equal("アカウントを削除", AccountDeletionText.Button); Assert.Equal("アカウントを削除しますか？", AccountDeletionText.ConfirmTitle);
        Assert.Equal(("削除する", "やめる"), (AccountDeletionText.ConfirmYes, AccountDeletionText.ConfirmNo)); Assert.Equal("アカウントを削除しました", AccountDeletionText.ResultTitle);
        const string remains = "ログインの運営に残るのは、止めたパスのランダムな番号と、「ほかの端末をすべて止める」を使った時のアカウントの番号とその時刻だけで、どちらも最長14日で消えます。";
        Assert.Equal("この端末のBellTeamのサインインを、届く限りすべて終わらせます。この端末にある店のパス・アカウントの番号・サーバーのトークン・決裁箱のサインインと鍵・保存した会話の写しを消して、最初の画面に戻ります。ログインの運営は、名前・メールアドレス・購入の記録を持っていません。" + remains + "ほかの端末のサインインは、その端末で終えてください。"
            + AccountDeletionText.Subscription + "サーバーの会話や設定は消えません。", AccountDeletionText.ConfirmBody(AccountDeletionText.Subscription));
        Assert.Equal("この端末のサインインとデータを消しました。" + remains + AccountDeletionText.Cancel, AccountDeletionText.ResultBody(AccountDeletionText.Cancel));
        Assert.Equal("決裁箱のサインインを消せませんでした（ネットワークにつながっていません）。つながる場所でもう一度「アカウントを削除」を押すと、続きから終えます。すでに終えた手順はそのままです。", AccountDeletionText.Failed("決裁箱のサインイン", AccountDeletionText.NoNetwork));
        Assert.Equal(AccountDeletionText.NoNetwork, MainWindow.ReasonOf(new InvalidOperationException("x", new HttpRequestException("offline"))));
        Assert.Equal(AccountDeletionText.OperatorUnreachable, MainWindow.ReasonOf(new Kitepon.LoginBilling.Desktop.LoginBillingException("server_error", 503, null)));
        Assert.Equal(AccountDeletionText.NotProcessed, MainWindow.ReasonOf(new IOException("locked")));
        Assert.DoesNotContain("Apple Account", AccountDeletionText.Subscription + AccountDeletionText.Cancel);
    }

    [Fact]
    public void TheDeleteButtonIsTheLastItemOfTheCardSignedInOrNotAndOnlyWhereAWayToDeleteIsGiven() => RunSta(() =>
    {
        var deleted = 0; var worker = new Kitepon.LoginBilling.Desktop.DesktopLoginBilling("http://127.0.0.1:1", new Kitepon.LoginBilling.Desktop.MemoryPassStore());
        var card = new AccountView(worker, () => deleted++); Until(() => card.SignedOut);
        Assert.Equal(AccountDeletionText.Button, System.Windows.Automation.AutomationProperties.GetName(Descendants<Button>(card).Last()));   // last, below the sign-in entry
        Click(card, AccountDeletionText.Button); Assert.Equal(1, deleted);
        Assert.DoesNotContain(Descendants<Button>(new AccountView(worker)), b => System.Windows.Automation.AutomationProperties.GetName(b) == AccountDeletionText.Button);   // the first-run gate has none
        Assert.DoesNotContain(Descendants<Button>(new AccountView(null, () => deleted++)), b => System.Windows.Automation.AutomationProperties.GetName(b) == AccountDeletionText.Button);   // no Worker: no card to delete from
        card.Dispose();
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
