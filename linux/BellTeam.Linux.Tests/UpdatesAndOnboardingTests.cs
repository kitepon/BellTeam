using System.Net;
using System.Text;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Input;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

public sealed class UpdatesAndOnboardingTests
{
    private const string Setup = """{"phase":"select_harness","harness":null,"harnesses":[{"id":"codex","name":"Codex"},{"id":"claude","name":"Claude"}],"guideBotId":null,"complete":false,"auth":null}""";
    private const string Waiting = """{"phase":"authenticate","harness":"codex","harnesses":[{"id":"codex","name":"Codex"}],"guideBotId":null,"complete":false,"auth":{"status":"waiting","input_required":false,"message":"待っています"}}""";
    private static string Updates(string comparison) => """
        {"schema":"bellteam.updates.v1","notice":{"state":"ready","message":"確認できました"},"plans":[],"operation":null,"previousOperation":null,
         "components":[{"id":"notifications","name":"通知","description":"通知","current":{"version":"aaaaaaaaaaaa","origin":"published"},"published":{"version":"bbbbbbbbbbbb","origin":"published"},
         "comparison":{"state":"COMPARISON"},"changes":["機能を更新します。"],"capability":{"supported":true},"availability":{"available":true},"publication":{}}]}
        """.Replace("COMPARISON", comparison);

    // The L1 fake server, with the setup and update answers this group needs.
    private sealed class Server(string? setup = null, string? updates = null) : HttpMessageHandler
    {
        public readonly List<string> Posts = [];
        private readonly HttpMessageInvoker inner = new(new FakeServer());
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (request.Method != HttpMethod.Get) Posts.Add(request.Method + " " + path);
            string? body = path switch { "/api/setup" when setup is not null => setup, "/api/setup/harness" => Waiting, "/api/updates" when updates is not null => updates, _ => null };
            if (body is not null) return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            return await inner.SendAsync(request, cancellationToken);
        }
    }

    private static MainWindow Open(Server server, out LinuxWorkspace workspace)
    {
        workspace = new LinuxWorkspace(origin => new BellApi(origin, server));
        var window = new MainWindow(workspace, persistPlacement: false, settings: new SettingsStore(Path.Combine(Path.GetTempPath(), "BellTeam-linux-updates-" + Guid.NewGuid()))) { AutoRetry = false };
        window.Show();
        return window;
    }

    [Fact]
    public Task TheUpdateBadgeShowsOnlyWhileAPartCanBeUpdatedAndOpensTheSheetThatEscCloses() => Ui.Run(async () =>
    {
        var window = Open(new Server(updates: Updates("update_available")), out var workspace);
        await window.ConnectAsync("http://localhost:1/");
        await window.UpdateNoticeReady; Dispatcher.UIThread.RunJobs();
        Assert.True(window.UpdateBadgeVisible);
        window.ShowUpdates(); await window.SheetReady;
        Assert.Equal(UpdateKind.Available, window.UpdateSheet!.Kind);
        window.KeyPressQwerty(PhysicalKey.Escape, RawInputModifiers.None);
        Assert.Null(window.UpdateSheet);
        window.Close(); workspace.Dispose();
    });

    [Fact]
    public Task NoBadgeWhenEverythingIsCurrent() => Ui.Run(async () =>
    {
        var window = Open(new Server(updates: Updates("up_to_date")), out var workspace);
        await window.ConnectAsync("http://localhost:1/");
        await window.UpdateNoticeReady;
        Assert.False(window.UpdateBadgeVisible);
        window.Close(); workspace.Dispose();
    });

    [Fact]
    public Task AnUnfinishedSetupShowsTheHarnessChoiceAndOnlyAChoicePostsOnce() => Ui.Run(async () =>
    {
        var server = new Server(setup: Setup); var window = Open(server, out var workspace);
        await window.ConnectAsync("http://localhost:1/");
        Assert.Equal(StartupPhase.Onboarding, window.Startup);
        var view = Assert.IsType<OnboardingView>(window.StartupContent);
        Assert.Equal("select_harness", view.State.Phase); Assert.Empty(server.Posts);
        window.UpdateLayout(); Dispatcher.UIThread.RunJobs();
        var codex = view.GetVisualDescendants().OfType<Button>().First(button => Avalonia.Automation.AutomationProperties.GetName(button) == "Codex");
        codex.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
        for (var attempt = 0; attempt < 200 && view.State.Phase == "select_harness"; attempt++) { await Task.Delay(10); Dispatcher.UIThread.RunJobs(); }
        Assert.Equal(["POST /api/setup/harness"], server.Posts);
        Assert.Equal("authenticate", view.State.Phase); Assert.True(view.Polling);
        window.Close(); workspace.Dispose();
    });
}
