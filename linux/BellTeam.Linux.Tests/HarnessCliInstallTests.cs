using System.Net;
using System.Text;
using BellTeam.Core;

namespace BellTeam.Linux;

// a451 (harness-cli.md): the install object, its two routes, the setup route and the 要対応 rule, as Core reads them.
public sealed class HarnessCliInstallTests
{
    private const string NotInstalled = """{"state":"not_installed","version":null,"source":null,"busy":false,"lastError":null,"message":"まだ入っていません。「最新版を入れる」で入れてください。","action":"install","label":"最新版を入れる"}""";
    private const string Installed = """{"state":"installed","version":"2.1.0","source":"image","busy":false,"lastError":{"code":"CLI_INSTALL_NETWORK","message":"通信できませんでした。"},"message":"前回、最新版を入れられませんでした。","action":"install","label":"最新版を入れる"}""";

    private sealed class Handler(Func<HttpRequestMessage, string> answer) : HttpMessageHandler
    {
        public readonly List<string> Calls = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls.Add(request.Method + " " + request.RequestUri!.AbsolutePath);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(answer(request), Encoding.UTF8, "application/json") });
        }
    }

    [Fact]
    public async Task TheListItemInstallAndBothInstallRoutesAreReadAsTheContractSays()
    {
        var handler = new Handler(request => request.RequestUri!.AbsolutePath == "/api/harness-auth"
            ? "{\"harnesses\":[{\"id\":\"codex\",\"name\":\"Codex\",\"members\":1,\"install\":" + NotInstalled + "},{\"id\":\"grok\",\"name\":\"Grok\",\"members\":0}]}"
            : "{\"harness\":\"codex\",\"install\":" + NotInstalled + "}");
        var auth = new HarnessAuthenticationApi(new BellApi(new("http://localhost/"), handler));
        var items = (await auth.ListAsync()).Harnesses;
        var install = items[0].Install!;
        Assert.Equal("not_installed", install.State); Assert.True(install.CanPress); Assert.True(install.NeedsAttention); Assert.False(HarnessCliInstall.Ready(install));
        Assert.Null(items[1].Install); Assert.True(HarnessCliInstall.Ready(items[1].Install));
        Assert.Equal("codex", (await auth.InstallStatusAsync("codex")).Harness); await auth.InstallAsync("codex");
        Assert.Equal(["GET /api/harness-auth", "GET /api/harness-auth/codex/install", "POST /api/harness-auth/codex/install"], handler.Calls);
    }

    [Fact]
    public async Task OnboardingInstallPostsToTheSetupRouteAndReadsTheSnapshotInstall()
    {
        var handler = new Handler(_ => "{\"phase\":\"authenticate\",\"harness\":\"codex\",\"harnesses\":[{\"id\":\"codex\",\"name\":\"Codex\",\"install\":" + NotInstalled + "}],\"complete\":false,\"auth\":{\"status\":\"blocked\",\"message\":\"Codexがまだ入っていません\"},\"install\":" + NotInstalled + "}");
        var state = await new SetupApi(new BellApi(new("http://localhost/"), handler)).InstallAsync();
        Assert.Equal(["POST " + SetupApi.InstallPath], handler.Calls);
        Assert.Equal("not_installed", state.Install!.State); Assert.Equal("not_installed", state.Harnesses[0].Install!.State);
    }

    [Fact]
    public void OnlyAnAbsentCliNeedsAttentionAndAFailedUpdateOfAWorkingOneDoesNot()
    {
        static HarnessCliInstall Of(string state) => new() { State = state };
        Assert.All(new[] { "not_installed", "installing", "failed" }, state => Assert.True(Of(state).NeedsAttention));
        Assert.All(new[] { "checking", "installed" }, state => Assert.False(Of(state).NeedsAttention));
        var lastError = System.Text.Json.JsonSerializer.Deserialize<HarnessCliInstall>(Installed, BellApi.Json)!;
        Assert.Equal("CLI_INSTALL_NETWORK", lastError.LastError!.Code); Assert.False(lastError.NeedsAttention); Assert.True(lastError.CanPress);
        Assert.Equal("最新版を入れる", new HarnessCliInstall { State = "installed", Action = "install" }.ButtonLabel);
        Assert.Equal(new HarnessRowState("未導入", HarnessTone.Warning, "最新版を入れる"), HarnessRowState.FromInstall(Of("not_installed")));
    }

    [Fact]
    public void TheHomeBandCountsANotInstalledAiFirstWithTheSameWordsEverywhere()
    {
        var done = AuthenticationProgress.Done;
        var absent = new HarnessCliInstall { State = "not_installed" };
        var status = SettingsSummary.Ai([new("claude", "Claude", null, done), new("codex", "Codex", null, AuthenticationProgress.Unknown, Install: absent), new("grok", "Grok", null, AuthenticationProgress.NeedsLogin)]);
        Assert.Equal("Codexがまだ入っていません（ほか1件）", status.Line); Assert.Equal("未導入", status.Badge); Assert.True(status.NeedsAttention);
        Assert.Equal(new SettingsRoute(BellTeam.Core.SettingsPage.Ai, "codex", null), status.AttentionRoute);
        Assert.Equal("Codexを入れています", SettingsSummary.Ai([new("codex", "Codex", null, AuthenticationProgress.Unknown, Install: absent with { State = "installing" })]).Line);
        Assert.Equal("Codexを入れられませんでした", SettingsSummary.Ai([new("codex", "Codex", null, AuthenticationProgress.Unknown, Install: absent with { State = "failed" })]).Line);
        var calm = SettingsSummary.Ai([new("codex", "Codex", null, done, Install: new() { State = "installed", LastError = new("CLI_INSTALL_FAILED", "x") }), new("grok", "Grok", null, done, Install: new() { State = "checking" })]);
        Assert.Equal("すべて認証済み", calm.Line); Assert.False(calm.NeedsAttention);
    }
}
