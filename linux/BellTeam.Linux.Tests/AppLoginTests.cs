using System.Net;
using System.Text;
using Avalonia.Controls;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// a485, C-04 (app-sessions.md sections 2 and 4): the console code once, the token kept, the Bearer header, the token file, sign-out of the own row.
public sealed class AppLoginTests
{
    // The home part of a server: the console code answers once, the session list has this app's own row.
    private sealed class Server : HttpMessageHandler
    {
        public readonly List<string> Calls = []; public string? Authorization, ConsoleBody; public bool Refuse;
        private readonly HttpMessageInvoker rest = new(new FakeServer());
        private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var path = request.RequestUri!.AbsolutePath; Calls.Add(request.Method + " " + path);
            Authorization = request.Headers.Authorization?.ToString();
            if (path == "/api/home/session") return Json("""{"capability":"login-billing-home/1","bound":true,"enforced":true}""");
            if (path == "/api/home/login/console") { ConsoleBody = await request.Content!.ReadAsStringAsync(token); return ConsoleBody.Contains("GOOD") ? Json("""{"sessionId":"S1","token":"tok-console"}""") : Json("""{"error":"LOGIN_CODE_INVALID"}""", HttpStatusCode.Forbidden); }
            if (path == "/api/home/sessions" && request.Method == HttpMethod.Get) return Json("""{"sessions":[{"id":"S0","kind":"console","current":false},{"id":"S1","kind":"app","appKind":"linux","current":true}]}""");
            if (path.StartsWith("/api/home/sessions/") && request.Method == HttpMethod.Delete) return Refuse ? Json("""{"error":"SESSION_STORE_UNAVAILABLE"}""", HttpStatusCode.ServiceUnavailable) : new HttpResponseMessage(HttpStatusCode.NoContent);
            return await rest.SendAsync(request, token);
        }
    }

    // home: what GET /api/home/session answers (null = a server without the home part: 404).
    private sealed class Probe(string session, HttpStatusCode status = HttpStatusCode.OK, string? home = null) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/api/home/session" && home is not null) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(home, Encoding.UTF8, "application/json") });
            return Task.FromResult(new HttpResponseMessage(path == "/api/session" ? status : HttpStatusCode.NotFound) { Content = new StringContent(session, Encoding.UTF8, "application/json") });
        }
    }

    [Fact]
    public async Task AnEnforcingServerThatDoesNotKnowTheAppRoutesToItsOwnLoginAndAnUnjudgeableOneKeepsTheToken()
    {
        using var enforced = new LinuxWorkspace(origin => new BellApi(origin, new Probe("""{"authenticated":false,"authMode":"local"}""", home: """{"capability":"login-billing-home/1","bound":true,"enforced":true}""")));
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
        _ = api.GetAsync<System.Text.Json.JsonElement>("/api/home/session");
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
    public Task TheConnectScreenTakesAConsoleCodeOnceAndKeepsTheToken() => Ui.Run(async () =>
    {
        var server = new Server(); var tokens = new MemorySessionTokenStore(); var origin = new Uri("http://localhost/"); var signedIn = 0;
        var view = new ConnectView(new BellApi(origin, server), origin, tokens, () => signedIn++, () => { });
        var window = new Window { Content = view }; window.Show();
        Assert.Contains("サーバーのコードで入る", Texts(view)); Assert.DoesNotContain(Texts(view), text => text.Contains("スマホで承認"));
        // a wrong code says so and keeps the screen (one POST, never resent); a right one stores the token and connects
        view.GetVisualDescendants().OfType<TextBox>().Single().Text = "BAD";
        Click(view, "コードでログイン"); await view.Running; Avalonia.Threading.Dispatcher.UIThread.RunJobs();
        Assert.Contains(HomeLoginText.CodeInvalid, Texts(view)); Assert.Equal(0, signedIn); Assert.Null(tokens.Load(origin));
        Assert.Equal(1, server.Calls.Count(call => call == "POST /api/home/login/console"));
        view.GetVisualDescendants().OfType<TextBox>().Single().Text = " GOOD ";
        Click(view, "コードでログイン"); await view.Running;
        Assert.Equal(1, signedIn); Assert.Equal("tok-console", tokens.Load(origin)); Assert.Equal("{\"code\":\"GOOD\"}", server.ConsoleBody);
        view.Dispose(); window.Close();
    });

    // Sign-out of a home server ends this app's own row and forgets the token, whether or not the server answers.
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SigningOutEndsTheOwnRowAndForgetsTheToken(bool refuse)
    {
        var server = new Server { Refuse = refuse }; var tokens = new MemorySessionTokenStore(); var origin = new Uri("http://localhost/"); tokens.Save(origin, "tok");
        using var workspace = new LinuxWorkspace(o => new BellApi(o, server) { SessionToken = tokens.Load(o) });
        await workspace.ConnectAsync("http://localhost/", listen: false);
        Assert.True(workspace.Connected); Assert.True(workspace.SessionLoginRequired);
        await HomeSessionEnd.EndAsync(workspace, tokens);
        Assert.Contains("DELETE /api/home/sessions/S1", server.Calls); Assert.DoesNotContain("DELETE /api/home/sessions/S0", server.Calls);
        Assert.Null(tokens.Load(origin)); Assert.Equal(refuse, workspace.ActionError is not null);
    }

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
        Assert.Contains(SubscriptionText.Paywall, Texts(view)); Assert.DoesNotContain("ブラウザーで開く", Texts(view));
        Click(view, "再確認"); Click(view, "接続先を変更"); Assert.Equal((1, 1), (rechecked, changed));
        window.Close(); await Task.CompletedTask;
    });

    private static string[] Texts(Control root) => root.GetVisualDescendants().OfType<TextBlock>().Select(text => text.Text ?? "").ToArray();
    private static void Click(Control root, string name) => root.GetVisualDescendants().OfType<TextBlock>().First(text => text.Text == name).FindAncestorOfType<Button>()!.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
    private static async Task Until(Func<bool> condition) { var until = DateTime.UtcNow.AddSeconds(5); while (!condition()) { if (DateTime.UtcNow > until) throw new TimeoutException(); await Task.Delay(5); Avalonia.Threading.Dispatcher.UIThread.RunJobs(); } }
}
