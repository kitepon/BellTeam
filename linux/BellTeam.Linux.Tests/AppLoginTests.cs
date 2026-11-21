using System.Net;
using System.Text;
using Avalonia.Controls;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// a485, shape 2 (app-sessions.md section 7): start, show the code, poll, keep the token; the Bearer header; the token file.
public sealed class AppLoginTests
{
    private sealed class Server(params string[] polls) : HttpMessageHandler
    {
        public readonly List<string> Calls = []; public string? Authorization, ConsoleBody; public int PollCount; public int FailPolls;
        private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var path = request.RequestUri!.AbsolutePath; Calls.Add(request.Method + " " + path);
            Authorization = request.Headers.Authorization?.ToString();
            if (path == "/api/login/start") return Json("""{"loginId":"L1","status":"waiting_second_hand","expiresAt":"2999-01-01T00:00:00.000Z","pollAfterMs":3000}""");
            if (path == "/api/login/L1/cancel") return Json("""{"loginId":"L1","status":"cancelled"}""");
            if (path == "/api/login/console") { ConsoleBody = await request.Content!.ReadAsStringAsync(token); return ConsoleBody.Contains("GOOD") ? Json("""{"status":"approved","sessionId":"S1","token":"tok-console"}""") : Json("""{"error":"LOGIN_CODE_INVALID"}""", HttpStatusCode.Forbidden); }
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
    private static readonly Func<int, CancellationToken, Task> NoWait = (_, _) => Task.Yield().GetAwaiter().IsCompleted ? Task.CompletedTask : Task.CompletedTask;

    [Fact]
    public async Task ItWaitsForTheSecondHandThenThePhoneAndReceivesTheTokenOnce()
    {
        var server = new Server("""{"loginId":"L1","status":"waiting_second_hand"}""", Phone, """{"loginId":"L1","status":"approved","token":"tok-1"}""");
        var flow = new LoginFlow(Api(server), "linux", NoWait); var seen = new List<LoginPhase>(); string? code = null; flow.Changed += () => { seen.Add(flow.Phase); if (flow.Phase == LoginPhase.WaitingPhone) code = flow.Status!.Phone!.ShortCode; };
        await flow.RunAsync(default);
        Assert.Equal(LoginPhase.Approved, flow.Phase); Assert.Equal("tok-1", flow.Token);
        Assert.Contains(LoginPhase.WaitingPhone, seen); Assert.Equal("0123-4567", code);
        Assert.Equal(1, server.Calls.Count(call => call == "POST /api/login/start"));   // start is never resent
    }

    [Fact]
    public async Task ARefusedExpiredOrLostLoginEndsWithItsSentenceAndAFailedPollIsRetriedWithoutLimit()
    {
        var refused = new LoginFlow(Api(new Server("""{"loginId":"L1","status":"refused","reason":"not_owner_account"}""")), "linux", NoWait); await refused.RunAsync(default);
        Assert.Equal(LoginPhase.Refused, refused.Phase); Assert.Equal(LoginFlow.RefusedText("not_owner_account"), refused.Message);
        var delivered = new LoginFlow(Api(new Server("""{"loginId":"L1","status":"delivered"}""")), "linux", NoWait); await delivered.RunAsync(default);
        Assert.Equal(LoginPhase.Failed, delivered.Phase);   // the token comes once; a later "delivered" without it means it was lost
        var flaky = new Server("""{"loginId":"L1","status":"approved","token":"tok-2"}""") { FailPolls = 5 };
        var retried = new LoginFlow(Api(flaky), "linux", NoWait); await retried.RunAsync(default);
        Assert.Equal("tok-2", retried.Token); Assert.True(flaky.Calls.Count(call => call == "GET /api/login/L1") >= 6);
    }

    private sealed class Probe(string session, HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
            => Task.FromResult(new HttpResponseMessage(request.RequestUri!.AbsolutePath == "/api/session" ? status : HttpStatusCode.NotFound) { Content = new StringContent(session, Encoding.UTF8, "application/json") });
    }

    [Fact]
    public async Task AnEnforcingServerThatDoesNotKnowTheAppRoutesToItsOwnLoginAndAnUnjudgeableOneKeepsTheToken()
    {
        using var enforced = new LinuxWorkspace(origin => new BellApi(origin, new Probe("""{"authenticated":false,"authMode":"local","login":{"capability":true,"bound":true,"enforced":true}}""")));
        await enforced.ConnectAsync("http://localhost:1/", listen: false);
        Assert.True(enforced.NeedsLogin); Assert.True(enforced.SessionLoginRequired);
        // An old server has no login key: today's paths (Access) are untouched.
        using var old = new LinuxWorkspace(origin => new BellApi(origin, new Probe("""{"authenticated":false,"authMode":"cloudflare"}""")));
        await old.ConnectAsync("http://localhost:1/", listen: false);
        Assert.True(old.NeedsLogin); Assert.False(old.SessionLoginRequired);
        // 503 SESSION_STORE_UNAVAILABLE is not a login need: the page says the server is getting ready and retries.
        using var busy = new LinuxWorkspace(origin => new BellApi(origin, new Probe("""{"error":"SESSION_STORE_UNAVAILABLE"}""", HttpStatusCode.ServiceUnavailable)));
        await busy.ConnectAsync("http://localhost:1/", listen: false);
        Assert.False(busy.NeedsLogin); Assert.True(busy.ConnectionRetryable); Assert.Equal("サーバーの準備中です。", busy.ConnectionError);
    }

    [Fact]
    public void BellApiSendsTheSessionTokenAsABearerHeader()
    {
        var server = new Server(); using var api = new BellApi(new("http://localhost/"), server) { SessionToken = "abc" };
        _ = api.GetAsync<System.Text.Json.JsonElement>("/api/login/L1");
        Assert.Equal("Bearer abc", server.Authorization);
    }

    [Fact]
    public void TheTokenFileIsPrivateAndPerServer()
    {
        var directory = Directory.CreateTempSubdirectory("bellteam-session-").FullName; var store = new FileSessionTokenStore(directory);
        var a = new Uri("https://a.example/"); var b = new Uri("https://b.example/");
        store.Save(a, "ta"); store.Save(b, "tb");
        Assert.Equal("ta", store.Load(a)); Assert.Equal("tb", new FileSessionTokenStore(directory).Load(b));
        if (!OperatingSystem.IsWindows()) Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(Path.Combine(directory, "sessions.json")));
        store.Clear(a); Assert.Null(store.Load(a)); Assert.Equal("tb", store.Load(b));
    }

    [Fact]
    public Task TheConnectScreenShowsTheCodeAndCheckNumberAndAConsoleCodeSignsIn() => Ui.Run(async () =>
    {
        var server = new Server(Phone); var tokens = new MemorySessionTokenStore(); var origin = new Uri("http://localhost/"); var signedIn = 0;
        var view = new ConnectView(Api(server), "linux", origin, tokens, () => signedIn++, () => { });
        var window = new Window { Content = view }; window.Show();
        await Until(() => Texts(view).Contains("0123-4567"));
        Assert.Contains("確認番号 042", Texts(view));
        Assert.Contains("スマホで承認する", Texts(view)); Assert.Contains("サーバーのコードで入る", Texts(view));
        Assert.DoesNotContain(Texts(view), text => text.Contains("ブラウザー版"));
        // a wrong console code says so and keeps the screen; a right one stores the token and connects
        view.GetVisualDescendants().OfType<TextBox>().Single().Text = "BAD";
        Click(view, "コードでログイン"); await Until(() => Texts(view).Contains("コードが正しくないか、すでに使われています。")); Assert.Equal(0, signedIn);
        view.GetVisualDescendants().OfType<TextBox>().Single().Text = "GOOD";
        Click(view, "コードでログイン"); await Until(() => signedIn == 1);
        Assert.Equal("tok-console", tokens.Load(origin)); Assert.Contains("\"kind\":\"linux\"", server.ConsoleBody);
        view.Dispose(); window.Close();
    });

    private sealed class Subscription(string body, HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
    }

    // a485 7e (Tronie): only entitlementState "none" shows the paywall; active, unknown, no field and a failed read show the app.
    [Theory]
    [InlineData("""{"subscription":{"entitlementState":"none"}}""", 200, true)]
    [InlineData("""{"subscription":{"entitlementState":"active"}}""", 200, false)]
    [InlineData("""{"subscription":{"entitlementState":"unknown"}}""", 200, false)]
    [InlineData("""{"subscription":{"entitled":false}}""", 200, false)]
    [InlineData("""{"error":"x"}""", 500, false)]
    public async Task OnlyAnEntitlementStateOfNoneIsPaywalled(string body, int status, bool paywalled)
        => Assert.Equal(paywalled, await new SubscriptionApi(new BellApi(new("http://localhost/"), new Subscription(body, (HttpStatusCode)status))).PaywalledAsync());

    [Fact]
    public void ThePaywallComesAfterLoginAndFailureAndBeforeOnboardingAndTheWorkspace()
    {
        var ready = new SetupState { Phase = "ready", Harnesses = [], Complete = true };
        Assert.Equal(StartupPhase.Paywall, StartupRoute.AfterConnect(false, true, ready, paywalled: true));
        Assert.Equal(StartupPhase.Ready, StartupRoute.AfterConnect(false, true, ready));
        Assert.Equal(StartupPhase.SignIn, StartupRoute.AfterConnect(true, true, ready, paywalled: true));
        Assert.Equal(StartupPhase.Failure, StartupRoute.AfterConnect(false, false, null, paywalled: true));
    }

    [Fact]
    public Task ThePaywallScreenShowsTheRuledTextWithNoBrowserButton() => Ui.Run(async () =>
    {
        int rechecked = 0, changed = 0; var view = new PaywallView(() => rechecked++, () => changed++);
        var window = new Window { Content = view }; window.Show();
        Assert.Contains("このアプリは購読が必要です。無料で使うには、公開されているソースコードから自分でビルドしたものを使ってください。", Texts(view)); Assert.DoesNotContain("ブラウザーで開く", Texts(view));
        Click(view, "再確認"); Click(view, "接続先を変更"); Assert.Equal((1, 1), (rechecked, changed));
        window.Close(); await Task.CompletedTask;
    });

    private static string[] Texts(Control root) => root.GetVisualDescendants().OfType<TextBlock>().Select(text => text.Text ?? "").ToArray();
    private static void Click(Control root, string name) => root.GetVisualDescendants().OfType<TextBlock>().First(text => text.Text == name).FindAncestorOfType<Button>()!.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
    private static async Task Until(Func<bool> condition) { var until = DateTime.UtcNow.AddSeconds(5); while (!condition()) { if (DateTime.UtcNow > until) throw new TimeoutException(); await Task.Delay(5); Avalonia.Threading.Dispatcher.UIThread.RunJobs(); } }
}
