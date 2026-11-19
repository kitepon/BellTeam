using System.Net;
using System.Text;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// a451 screens: the AIの認証 row, the settings home band, the Bot editor line and onboarding read the server's install object and press its button.
public sealed class HarnessInstallScreenTests
{
    private const string Absent = """{"state":"not_installed","version":null,"source":null,"busy":false,"lastError":null,"message":"まだ入っていません。「最新版を入れる」で入れてください。","action":"install","label":"最新版を入れる"}""";
    private const string Installing = """{"state":"installing","version":null,"source":null,"busy":true,"lastError":null,"message":"入れています。数分かかることがあります。","action":null,"label":null}""";
    private const string Present = """{"state":"installed","version":"2.1.0","source":"user","busy":false,"lastError":null,"message":"入っています（バージョン 2.1.0）。「最新版を入れる」で最新版にできます。","action":"install","label":"最新版を入れる"}""";
    private const string GrokInstalled = """{"state":"installed","version":"1.0.0","source":"image","busy":false,"lastError":null,"message":"入っています（バージョン 1.0.0）。BellTeamに最初から入っている物です。","action":"install","label":"最新版を入れる"}""";

    // A server whose codex starts absent; the press makes it busy, and the next read says installed.
    private sealed class Server : HttpMessageHandler
    {
        public readonly List<string> Calls = [];
        public string Codex = Absent;
        public readonly Dictionary<string, string> Extra = [];
        private readonly HttpMessageInvoker inner = new(new FakeServer());
        private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath; Calls.Add(request.Method + " " + path);
            switch (path)
            {
                case "/api/harness-auth": return Json("{\"harnesses\":[{\"id\":\"codex\",\"name\":\"Codex\",\"members\":2,\"install\":" + Codex + "},{\"id\":\"grok\",\"name\":\"Grok\",\"members\":0,\"install\":" + GrokInstalled + "}]}");
                case "/api/harness-auth/codex/install":
                    if (request.Method == HttpMethod.Post) Codex = Installing; else if (Codex == Installing) Codex = Present;
                    return Json("{\"harness\":\"codex\",\"install\":" + Codex + "}");
                case "/api/harness-auth/codex": return Codex == Present ? Json("""{"harness":"codex","auth":{"status":"blocked"}}""") : Json("""{"error":"HARNESS_NOT_INSTALLED","message":"まだ入っていません"}""", HttpStatusCode.Conflict);
                case "/api/harness-auth/grok": return Json("""{"harness":"grok","auth":{"status":"authenticated"}}""");
                case "/api/setup/install": Calls.Add("setup-install"); return Json("""{"phase":"authenticate","harness":"codex","harnesses":[{"id":"codex","name":"Codex"}],"complete":false,"auth":{"status":"blocked","message":"x"},"install":""" + Installing + "}");
                case "/api/setup": return Json("""{"phase":"authenticate","harness":"codex","harnesses":[{"id":"codex","name":"Codex"}],"complete":false,"auth":{"status":"blocked","message":"x"},"install":""" + Codex + "}");
            }
            if (Extra.TryGetValue(path, out var extra)) return Json(extra);
            return await inner.SendAsync(request, cancellationToken);
        }
    }

    private static async Task<LinuxWorkspace> Connect(Server server) { var workspace = new LinuxWorkspace(origin => new BellApi(origin, server)); await workspace.ConnectAsync("http://localhost:1/", listen: false); return workspace; }
    private static IEnumerable<string?> Lines(Control root) => root.GetVisualDescendants().OfType<TextBlock>().Select(text => text.Text);
    private static Button Find(Control root, string name) => root.GetVisualDescendants().OfType<Button>().Single(button => button.Content as string == name || Avalonia.Automation.AutomationProperties.GetName(button) == name);
    private static async Task Until(Func<bool> done) { for (var i = 0; i < 100 && !done(); i++) { await Task.Delay(100); Dispatcher.UIThread.RunJobs(); } Assert.True(done()); }

    [Fact]
    public Task TheAiRowShowsTheServersWordsPressesInstallAndFollowsTheServerWhenItCanRun() => Ui.Run(async () =>
    {
        var server = new Server(); using var workspace = await Connect(server);
        var window = new SettingsWindow(workspace); window.Show();
        await window.InitializeAsync(SettingsPage.Ai); Dispatcher.UIThread.RunJobs();
        Assert.Contains(Lines(window), line => line == "まだ入っていません。「最新版を入れる」で入れてください。");
        Assert.Contains(Lines(window), line => line == "入っています（バージョン 1.0.0）。BellTeamに最初から入っている物です。");
        Assert.Contains(Lines(window), line => line == "未導入");
        Assert.DoesNotContain("GET /api/harness-auth/codex", server.Calls); // an AI that cannot run is never asked for its login
        // The settings home band says it with the words every app shares.
        await Until(() => Lines(window).Contains("Codexがまだ入っていません"));
        // As the Mac: the press is primary for an AI that cannot run, quiet for one that runs.
        Assert.Same(SettingsUi.Violet, Find(window, "Codex 最新版を入れる").Background); Assert.Same(BellTheme.ButtonFill, Find(window, "Grok 最新版を入れる").Background);
        Find(window, "Codex 最新版を入れる").RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Dispatcher.UIThread.RunJobs();
        Assert.Contains("POST /api/harness-auth/codex/install", server.Calls);
        Assert.Contains(Lines(window), line => line == "入れています。数分かかることがあります。");
        // The next reading (3 s) says installed: the list is read again, the login state is read and the band goes.
        await Until(() => server.Calls.Contains("GET /api/harness-auth/codex"));
        await Until(() => Lines(window).Contains("入っています（バージョン 2.1.0）。「最新版を入れる」で最新版にできます。") && !Lines(window).Contains("Codexがまだ入っていません"));
        window.Close();
    });

    [Fact]
    public Task OnboardingOffersInstallForAnAiThatIsNotInstalledAndReadsUntilTheServerSaysItCanRun() => Ui.Run(async () =>
    {
        var server = new Server(); var workspace = new LinuxWorkspace(origin => new BellApi(origin, server));
        var window = new MainWindow(workspace, persistPlacement: false, settings: new SettingsStore(Path.Combine(Path.GetTempPath(), "BellTeam-linux-install-" + Guid.NewGuid()))) { AutoRetry = false }; window.Show();
        await window.ConnectAsync("http://localhost:1/");
        var view = Assert.IsType<OnboardingView>(window.StartupContent); window.UpdateLayout(); Dispatcher.UIThread.RunJobs();
        Assert.Contains(Lines(view), line => line == "まだ入っていません。「最新版を入れる」で入れてください。");
        Assert.False(Find(view, "認証を確認して始める").IsEnabled);
        view.GetVisualDescendants().OfType<Button>().Single(button => button.Name == "harness-install").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        await Until(() => server.Calls.Contains("setup-install") && view.State.Install?.Busy == true);
        Assert.True(view.Polling); Assert.Contains(Lines(view), line => line == "入れています。数分かかることがあります。");
        window.Close(); workspace.Dispose();
    });

    // a452: every item with a live line in its row, and the band counts the items the Mac counts (here the AI, the summary AI, the stop and the rules).
    [Fact]
    public Task TheListRowsShowLiveLinesAndTheBandCountsEveryItem() => Ui.Run(async () =>
    {
        var server = new Server { Codex = Present };
        server.Extra["/api/ai-control"] = """{"control":{"paused":true,"state":"stopped","unconfirmedBotIds":[]}}""";
        server.Extra["/api/settings"] = """{"backgroundAgent":{"revision":"r1","selection":{"harness":"antigravity","model":"m","reasoningEffort":""}},"backgroundAgentNotice":"このAIは使えなくなりました。"}""";
        server.Extra["/api/user-rules"] = """{"text":""}""";
        using var workspace = await Connect(server);
        var window = new SettingsWindow(workspace); window.Show();
        await window.InitializeAsync(SettingsPage.Profile); Dispatcher.UIThread.RunJobs();
        await Until(() => Lines(window).Contains("このAIは使えなくなりました。"));
        // Rows: the stop row says 停止中 in its badge, the connection row says the host, the AI row has its own state.
        Assert.Contains(Lines(window), line => line == "停止中"); Assert.Contains(Lines(window), line => line == "localhost");
        Assert.Contains(Lines(window), line => line == "Codexのログインが必要です");
        // Band: AI (login), the summary AI (notice) and the stop, each once; 設定済み items are not in it.
        var band = ((SettingsWindow)window).AttentionBand.GetVisualDescendants().OfType<TextBlock>().Select(text => text.Text).ToList();
        Assert.Contains("要対応", band); Assert.Contains("仕事の要約を書くAI", band); Assert.Contains("全体停止", band); Assert.Contains("AIの設定", band);
        Assert.DoesNotContain("端末", band);
        window.Close();
    });

    [Fact]
    public Task TheBotEditorShowsAnAiThatIsNotInstalledInTheServersWords() => Ui.Run(async () =>
    {
        var server = new Server(); using var workspace = await Connect(server);
        var picker = new ModelPicker(new BotSettings { Name = "a", Harness = "codex" }); var window = new Window { Content = picker }; window.Show();
        await picker.LoadAsync(workspace.Management, CancellationToken.None); Dispatcher.UIThread.RunJobs();
        Assert.Equal("まだ入っていません。「最新版を入れる」で入れてください。", picker.InstallText);
        Assert.Contains(Lines(picker), line => line == picker.InstallText);
        window.Close();
    });
}
