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
        public string Requests = """{"requests":[{"loginId":"L9","kind":"ios","networkClass":"unknown","requestedAt":"2026-11-21T10:00:00.000Z","expiresAt":"2999-01-01T00:00:00.000Z"}]}""";
        public string Sessions = """{"sessions":[{"id":"S1","kind":"windows","origin":"phone","networkClass":"lan","createdAt":"2026-11-20T10:00:00.000Z","lastUsedAt":"2026-11-21T10:00:00.000Z","current":true},{"id":"S2","kind":"web","origin":"added","networkClass":"unknown","createdAt":"2026-11-21T09:00:00.000Z","issuedBy":"S1","current":false}]}""";
        public bool CodeLimited;
        private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var path = request.RequestUri!.AbsolutePath; Calls.Add(request.Method + " " + path);
            Authorization = request.Headers.Authorization?.ToString();
            if (path == "/api/login/start") return Json("""{"loginId":"L1","status":"waiting_second_hand","expiresAt":"2999-01-01T00:00:00.000Z","pollAfterMs":3000}""");
            if (path == "/api/login/L1/cancel") return Json("""{"loginId":"L1","status":"cancelled"}""");
            if (path == "/api/login/console") { ConsoleBody = await request.Content!.ReadAsStringAsync(token); return ConsoleBody.Contains("GOOD") ? Json("""{"status":"approved","sessionId":"S1","token":"tok-console"}""") : Json("""{"error":"LOGIN_CODE_INVALID"}""", HttpStatusCode.Forbidden); }
            if (path == "/api/sessions/S1") return Json("""{"id":"S1","status":"ended"}""");
            if (path == "/api/login/requests") return Json(Requests);
            if (path is "/api/login/L9/approve" or "/api/login/L9/deny") { Requests = """{"requests":[]}"""; return Json("""{"loginId":"L9","status":"waiting_phone"}"""); }
            if (path == "/api/login/code") return CodeLimited ? Json("""{"error":"LOGIN_RATE_LIMITED"}""", (HttpStatusCode)429) : Json("""{"code":"ABCD-EFGH-JKLMN","expiresAt":"2999-01-01T00:10:00.000Z"}""");
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
        await new LoginApi(api).EndSessionAsync("S1");
        Assert.Equal("DELETE /api/sessions/S1", server.Calls.Last());
    }

    [Fact]
    public void TheTokenFileIsDpapiProtectedPerServerAndAnUnreadableOneMeansNoToken()
    {
        var directory = Directory.CreateTempSubdirectory("bellteam-session-").FullName; var store = new DpapiSessionTokenStore(directory);
        var a = new Uri("https://a.example/"); var b = new Uri("https://b.example/");
        store.Save(a, "secret-ta"); store.Save(b, "tb");
        Assert.Equal("secret-ta", store.Load(a)); Assert.Equal("tb", new DpapiSessionTokenStore(directory).Load(b));
        Assert.DoesNotContain("secret-ta", Encoding.UTF8.GetString(File.ReadAllBytes(Path.Combine(directory, "sessions.bin"))));
        store.Clear(a); Assert.Null(store.Load(a)); Assert.Equal("tb", store.Load(b));
        File.WriteAllBytes(Path.Combine(directory, "sessions.bin"), [1, 2, 3]); Assert.Null(store.Load(b));
        Directory.Delete(directory, true);
    }

    [Fact]
    public void TheConnectScreenShowsTheCodeAndCheckNumberAndAConsoleCodeSignsIn() => RunSta(() =>
    {
        var server = new Server(Phone); var tokens = new MemorySessionTokenStore(); var origin = new Uri("http://localhost/"); var signedIn = 0;
        var view = new ConnectView(Api(server), "windows", origin, tokens, () => signedIn++, () => { });
        Until(() => Texts(view).Contains("0123-4567"));
        Assert.Contains("確認番号 042", Texts(view));
        Assert.Contains("スマホで承認する", Texts(view)); Assert.Contains("サーバーのコードで入る", Texts(view));
        Assert.Contains("このアプリは購読が必要です。購読していない場合は、ブラウザー版が無料で使えます。サーバーのコンソールで出したコード、またはすでに入っているアプリの「アプリを追加」で出したコードで、ブラウザー版に入れます。", Texts(view));
        var field = Descendants<TextBox>(view).Single();
        field.Text = "BAD"; Click(view, "コードでログイン"); Until(() => Texts(view).Contains("コードが正しくないか、すでに使われています。")); Assert.Equal(0, signedIn);
        field.Text = "GOOD"; Click(view, "コードでログイン"); Until(() => signedIn == 1);
        Assert.Equal("tok-console", tokens.Load(origin)); Assert.Contains("\"kind\":\"windows\"", server.ConsoleBody);
        view.Dispose();
    });

    [Fact]
    public void TheRequestsRowAsksForTheHandAndAnAnswerPostsOnceThenTheListIsReadAgain() => RunSta(() =>
    {
        var server = new Server(); var changes = 0;
        var view = new LoginRequestsView(Api(server), () => changes++, default);
        var read = view.RefreshAsync(); Until(() => read.IsCompleted);
        Assert.Contains("iosからのログイン要求（ネットワークは不明）", Texts(view)); Assert.Contains(SessionText.RequestHint, Texts(view)); Assert.True(view.HasContent);
        Click(view, "許可する"); Until(() => !view.HasContent);
        Assert.Equal(1, server.Calls.Count(call => call == "POST /api/login/L9/approve")); Assert.DoesNotContain("POST /api/login/L9/deny", server.Calls);
    });

    [Fact]
    public void AFailedRequestsReadShowsItsReasonAndAsksForARetry() => RunSta(() =>
    {
        var view = new LoginRequestsView(Api(new Server { Requests = "<html>" }), () => { }, default);
        var read = view.RefreshAsync(); Until(() => read.IsCompleted);
        Assert.True(view.NeedsRetry); Assert.True(view.HasContent); Assert.Contains(Texts(view), text => text.StartsWith("ログイン要求を読み込めませんでした。"));
    });

    [Fact]
    public void TheSessionListSignsOutThisAppRevokesAnotherAndAddAnAppShowsTheCodeOnceWithItsNote() => RunSta(() =>
    {
        var server = new Server(); var signedOut = 0;
        var view = new AppSessionsView(Api(server), () => signedOut++, default);
        Until(() => view.Ready.IsCompleted);
        Assert.Contains("windows（このアプリ）", Texts(view)); Assert.Contains("web", Texts(view));
        Click(view, "ログアウト"); Assert.Equal(1, signedOut); Assert.DoesNotContain("DELETE /api/sessions/S1", server.Calls);   // sign-out belongs to the window, which ends the session and clears the token
        Click(view, "取り消す"); Until(() => Texts(view).Contains("入っているアプリはありません。"));
        Assert.Equal(1, server.Calls.Count(call => call == "DELETE /api/sessions/S2"));
        Click(view, "アプリを追加するコードを出す"); Until(() => Texts(view).Contains("ABCD-EFGH-JKLMN"));
        Assert.Contains(SessionText.AddAppNote, Texts(view)); Assert.Equal(1, server.Calls.Count(call => call == "POST /api/login/code"));
        server.CodeLimited = true; Click(view, "アプリを追加するコードを出す"); Until(() => Texts(view).Contains(SessionText.CodeLimit));
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
