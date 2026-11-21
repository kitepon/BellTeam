using System.Net;
using System.Text;
using Avalonia.Controls;
using BellTeam.Core;

namespace BellTeam.Linux;

// a480-pin-linux (members/profiles.md): pinned members come first by pinnedAt, then the old order; right-click pins/unpins with PATCH /api/bots/:id {pinned}.
public sealed class PinTests
{
    private sealed class Server : HttpMessageHandler
    {
        public string? Patch;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.PathAndQuery;
            if (request.Method == HttpMethod.Patch) Patch = path + " " + await request.Content!.ReadAsStringAsync(cancellationToken);
            static string Bot(string id, string at, string? pinned) => $$"""{"id":"{{id}}","name":"{{id}}","displayName":"{{id}}","online":true,"recent":{"id":"m-{{id}}","at":"{{at}}","message":"x","direction":"incoming"},"pinnedAt":{{(pinned is null ? "null" : "\"" + pinned + "\"")}}}""";
            var body = path switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""",
                "/api/setup" => """{"phase":"ready","harnesses":[],"complete":true}""",
                "/api/bots?avatar=omit" => "{\"bots\":[" + string.Join(",", Bot("new", "2026-11-21T09:00:00Z", null), Bot("second", "2026-11-01T00:00:00Z", "2026-11-21T02:00:00Z"), Bot("first", "2026-10-01T00:00:00Z", "2026-11-21T01:00:00Z"), Bot("old", "2026-09-01T00:00:00Z", null)) + "]}",
                "/api/rooms?avatar=omit" => """{"rooms":[]}""",
                "/api/queue" => """{"items":[]}""",
                "/api/owner?avatar=omit" => """{"owner":{"name":"利用者"}}""",
                "/api/bots/new" => """{"bot":{"id":"new","name":"new","harness":"codex","session":"s","pinnedAt":"2026-11-21T03:00:00Z"}}""",
                _ => null
            };
            return body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        }
    }

    [Fact]
    public Task PinnedMembersComeFirstByPinTimeAndTheRowMenuPinsAndUnpins() => Ui.Run(async () =>
    {
        var server = new Server();
        using var workspace = new LinuxWorkspace(origin => new BellApi(origin, server));
        await workspace.ConnectAsync("http://localhost:1/", listen: false);
        Assert.Equal(["first", "second", "new", "old"], workspace.Entries.Select(entry => entry.Target.Id));
        var row = new ConversationRow(workspace, workspace.Entries.Single(entry => entry.Target.Id == "new"), _ => { });
        var item = Assert.IsType<MenuItem>(Assert.Single(row.ContextMenu!.Items));
        Assert.Equal("ピン留め", item.Header);
        item.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        for (var round = 0; round < 100 && server.Patch is null; round++) { Avalonia.Threading.Dispatcher.UIThread.RunJobs(); await Task.Delay(20); }
        Assert.Equal("/api/bots/new {\"pinned\":true}", server.Patch);
        var pinned = new ConversationRow(workspace, workspace.Entries.Single(entry => entry.Target.Id == "first"), _ => { });
        Assert.Equal("ピン留めを外す", Assert.IsType<MenuItem>(Assert.Single(pinned.ContextMenu!.Items)).Header);
    });
}
