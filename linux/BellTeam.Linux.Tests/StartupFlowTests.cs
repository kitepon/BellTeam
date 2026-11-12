using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

public sealed class StartupFlowTests
{
    private static MainWindow Open(FakeServer server, out LinuxWorkspace workspace)
    {
        workspace = new LinuxWorkspace(origin => new BellApi(origin, server));
        var window = new MainWindow(workspace, persistPlacement: false) { AutoRetry = false };
        window.Show();
        return window;
    }

    [Fact]
    public Task AConnectedServerEntersTheWorkspaceAndListsTheMembers() => Ui.Run(async () =>
    {
        var window = Open(new FakeServer(), out var workspace);
        await window.ConnectAsync("http://localhost:1/");
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(StartupPhase.Ready, window.Startup);
        Assert.Single(window.GetVisualDescendants().OfType<ConversationRow>());
        Assert.Equal("1人オンライン", workspace.OnlineSummary);
        window.Close(); workspace.Dispose();
    });

    [Fact]
    public Task AnUnreachableServerShowsTheFailureScreenAndStaysThereWithoutAutoRetry() => Ui.Run(async () =>
    {
        var window = Open(new FakeServer(down: true), out var workspace);
        await window.ConnectAsync("http://localhost:1/");
        Assert.Equal(StartupPhase.Failure, window.Startup);
        Assert.IsType<StartupFailureView>(window.StartupContent);
        window.Close(); workspace.Dispose();
    });

    [Fact]
    public Task AServerThatNeedsACloudflareLoginShowsTheLoginScreen() => Ui.Run(async () =>
    {
        var window = Open(new FakeServer("""{"authenticated":false,"authMode":"cloudflare"}"""), out var workspace);
        await window.ConnectAsync("http://localhost:1/");
        Assert.Equal(StartupPhase.SignIn, window.Startup);
        Assert.IsType<LoginView>(window.StartupContent);
        window.Close(); workspace.Dispose();
    });
}
