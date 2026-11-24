using System.Net;
using System.Text;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// seat-approval-clients: the Bot's tool approvals on its conversation, the literal command, the server's two labels, and what each answer leaves (docs/architecture/modules/execution/seat-approvals.md).
public sealed class SeatApprovalBarTests
{
    private sealed class Server(HttpStatusCode answer) : HttpMessageHandler
    {
        public readonly List<string> Posts = [];
        private bool open = true;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (request.Method == HttpMethod.Post && path == "/api/seat-approvals/sa-b1-1/answer")
            {
                Posts.Add(await request.Content!.ReadAsStringAsync(cancellationToken)); open = false;   // the entry goes whatever the answer was: the first answer wins
                return new HttpResponseMessage(answer) { Content = new StringContent(answer == HttpStatusCode.OK ? """{"id":"sa-b1-1","status":"answered"}""" : """{"error":"closed","code":"SEAT_APPROVAL_CLOSED"}""", Encoding.UTF8, "application/json") };
            }
            var body = path switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""",
                "/api/setup" => """{"phase":"ready","harnesses":[],"complete":true}""",
                "/api/bots" => """{"bots":[{"id":"b1","name":"ベル","displayName":"ベル","online":true},{"id":"b2","name":"ラピ","displayName":"ラピ","online":true}]}""",
                "/api/rooms" => """{"rooms":[]}""",
                "/api/queue" => """{"items":[]}""",
                "/api/owner" => """{"owner":{"name":"利用者"}}""",
                "/api/seat-approvals" => open ? """{"approvals":[{"id":"sa-b1-1","botId":"b1","botName":"ベル","harness":"claude","tool":"Bash","command":"rm -rf build && git push --force","reason":"Claude Codeが承認を待っています。","since":"2026-11-24T06:00:00Z","choices":[{"decision":"approve_once","label":"1回だけ許可する"},{"decision":"deny","label":"許可しない"}],"card":"none"}]}""" : """{"approvals":[]}""",
                _ => null
            };
            return body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        }
    }

    private static async Task<(LinuxWorkspace Workspace, SeatApprovalBar Bar)> OpenAsync(Server server, string botId = "b1")
    {
        var workspace = new LinuxWorkspace(origin => new BellApi(origin, server));
        await workspace.ConnectAsync("http://localhost:1/", listen: false);
        var bar = new SeatApprovalBar(); bar.Attach(workspace);
        await workspace.SelectAsync(workspace.Entries.Single(item => item.Target.Id == botId));
        Dispatcher.UIThread.RunJobs();
        return (workspace, bar);
    }
    private static Button Find(Control root, string name) => root.GetVisualDescendants().OfType<Button>().Single(button => AutomationProperties.GetName(button) == name);
    private static string[] Texts(Control root) => root.GetVisualDescendants().OfType<TextBlock>().Select(text => text.Text ?? "").Concat(root.GetVisualDescendants().OfType<TextBox>().Select(box => box.Text ?? "")).ToArray();

    [Fact]
    public Task TheBotsEntryShowsTheLiteralCommandAndTheServersTwoLabels() => Ui.Run(async () =>
    {
        var (workspace, bar) = await OpenAsync(new Server(HttpStatusCode.OK));
        using var _ = workspace;
        Assert.True(bar.IsVisible);
        Assert.Contains("承認を待っています", Texts(bar)); Assert.Contains("rm -rf build && git push --force", Texts(bar)); Assert.Contains("Bash · Claude Code", Texts(bar));
        Assert.NotNull(Find(bar, "1回だけ許可する")); Assert.NotNull(Find(bar, "許可しない"));
        Assert.Equal("承認待ち", workspace.Entries.Single(item => item.Target.Id == "b1").SeatApprovalBadge);
        Assert.Null(workspace.Entries.Single(item => item.Target.Id == "b2").SeatApprovalBadge);
    });

    [Fact]
    public Task AnotherBotsEntryShowsNothing() => Ui.Run(async () =>
    {
        var (workspace, bar) = await OpenAsync(new Server(HttpStatusCode.OK), "b2");
        using var _ = workspace;
        Assert.False(bar.IsVisible);
    });

    [Fact]
    public Task AnApprovalIsOnePostAndTheEntryGoes() => Ui.Run(async () =>
    {
        var server = new Server(HttpStatusCode.OK);
        var (workspace, bar) = await OpenAsync(server);
        using var _ = workspace;
        Find(bar, "1回だけ許可する").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        for (var wait = 0; wait < 100 && bar.IsVisible; wait++) { await Task.Delay(50); Dispatcher.UIThread.RunJobs(); }
        Assert.Equal(["""{"decision":"approve_once"}"""], server.Posts);
        Assert.False(bar.IsVisible);
    });

    [Fact]
    public Task AnEntryAnsweredElsewhereSaysSoAndGoes() => Ui.Run(async () =>
    {
        var server = new Server(HttpStatusCode.Conflict);
        var (workspace, bar) = await OpenAsync(server);
        using var _ = workspace;
        Find(bar, "許可しない").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        for (var wait = 0; wait < 100 && !Texts(bar).Contains(SeatApprovalText.Closed); wait++) { await Task.Delay(50); Dispatcher.UIThread.RunJobs(); }
        Assert.Equal(["""{"decision":"deny"}"""], server.Posts);
        Assert.Contains(SeatApprovalText.Closed, Texts(bar));
        Assert.DoesNotContain("1回だけ許可する", bar.GetVisualDescendants().OfType<Button>().Select(button => AutomationProperties.GetName(button)));
    });
}
