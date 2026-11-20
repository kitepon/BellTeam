using System.Net;
using System.Text;
using System.Text.Json;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// The machine seat's question card (conversation machine-stream.md), over an in-memory server that records what was posted.
public sealed class MachineCardTests
{
    private sealed class Server : HttpMessageHandler
    {
        public readonly List<string> Sent = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.PathAndQuery;
            if (request.Method != HttpMethod.Get) Sent.Add(request.Method + " " + path + " " + (request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken)));
            var body = path switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""",
                "/api/setup" => """{"phase":"ready","harnesses":[],"complete":true}""",
                "/api/bots?avatar=omit" => """{"bots":[{"id":"b1","name":"ベル","displayName":"ベル","online":true}]}""",
                "/api/rooms?avatar=omit" => """{"rooms":[]}""",
                "/api/queue" => """{"items":[]}""",
                "/api/owner?avatar=omit" => """{"owner":{"name":"利用者"}}""",
                var p when p.EndsWith("/answer") => """{"request":{"id":"r1","status":"answered"}}""",
                _ => null
            };
            return body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        }
    }

    private static TimelineMessage Row(string status, bool multi, string extra = "") => JsonSerializer.Deserialize<TimelineMessage>("""
        {"id":"me-3-0","kind":"machine_event","direction":"incoming","at":"2026-11-20T11:00:00Z","message":"q","machine_event":{"view":"question","display":"show","title":"q","text":"","request":{"request_id":"r1","status":"@STATUS@",
        "questions":[{"header":"Area","question":"どれにしますか。","multiSelect":@MULTI@,"allowOther":true,"options":[{"index":1,"label":"画面","description":"見た目"},{"index":2,"label":"通信"}]}]@EXTRA@}}}
        """.Replace("@STATUS@", status).Replace("@MULTI@", multi ? "true" : "false").Replace("@EXTRA@", extra), BellApi.Json)!;

    private static Button Find(Control root, string name) => root.GetVisualDescendants().OfType<Button>().First(button => AutomationProperties.GetName(button) == name);
    private static async Task<(MachineRequestCard Card, Server Server, LinuxWorkspace Workspace)> OpenAsync(TimelineMessage row)
    {
        var server = new Server(); var workspace = new LinuxWorkspace(origin => new BellApi(origin, server));
        await workspace.ConnectAsync("http://localhost:1/", listen: false);
        var card = new MachineRequestCard(workspace, "ベル"); card.Update(row.MachineEvent!, "ベル");
        return (card, server, workspace);
    }

    [Fact]
    public void TheEntryReadsIntoQuestionsOptionsAndAnswers()
    {
        var request = Row("answered", false, ",\"answers\":[{\"indexes\":[2],\"other\":null}]").MachineEvent!.Request!;
        Assert.Equal("answered", request.Status);
        Assert.Equal(["画面", "通信"], request.Questions![0].Options.Select(option => option.Label));
        Assert.Equal("通信", request.AnswerLine(0));
    }

    [Fact]
    public Task OneChoiceOfASingleQuestionAnswersAtOnce() => Ui.Run(async () =>
    {
        var (card, server, workspace) = await OpenAsync(Row("pending", false)); using var _ = workspace;
        Find(card, "通信").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        await Task.Delay(300);
        Assert.Equal(["POST /api/seat-requests/r1/answer {\"answers\":[{\"indexes\":[2],\"other\":null}]}"], server.Sent);
    });

    [Fact]
    public Task MultiSelectPicksFirstAndSendsTheChosenOptionsAndTheFreeText() => Ui.Run(async () =>
    {
        var (card, server, workspace) = await OpenAsync(Row("pending", true)); using var _ = workspace;
        var send = Find(card, "送る");
        Assert.False(send.IsEnabled);
        Find(card, "通信").RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Find(card, "画面").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        card.GetVisualDescendants().OfType<TextBox>().First(box => !box.IsReadOnly).Text = "他にも";
        Assert.True(send.IsEnabled);
        send.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        await Task.Delay(300);
        var sent = Assert.Single(server.Sent); Assert.StartsWith("POST /api/seat-requests/r1/answer ", sent);
        var answer = JsonDocument.Parse(sent[(sent.IndexOf('{'))..]).RootElement.GetProperty("answers")[0];
        Assert.Equal([1, 2], answer.GetProperty("indexes").EnumerateArray().Select(n => n.GetInt32()));
        Assert.Equal("他にも", answer.GetProperty("other").GetString());
    });

    [Fact]
    public Task AnExpiredRequestOffersNoChoice() => Ui.Run(async () =>
    {
        var (card, _, workspace) = await OpenAsync(Row("expired", false)); using var _ = workspace;
        Assert.Empty(card.GetVisualDescendants().OfType<Button>());
    });
}
