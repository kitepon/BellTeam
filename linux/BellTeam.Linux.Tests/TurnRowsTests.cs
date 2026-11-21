using System.Net;
using System.Text;
using System.Text.Json;
using Avalonia.LogicalTree;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

// A machine seat's turn on the first screen (a471-thinking-linux, a471-tune-answer-linux).
public sealed class TurnRowsTests
{
    private static string Words(string id, string text, bool bubble = false) =>
        "{\"id\":\"" + id + "\",\"kind\":\"machine_event\",\"direction\":\"incoming\",\"at\":\"2026-11-21T06:35:00Z\",\"message\":\"" + text + "\",\"sender\":{\"id\":\"b1\",\"name\":\"ベル\"},\"machine_event\":{\"seq\":1,\"part\":0,\"view\":\"words\",\"display\":\"show\",\"text\":\"" + text + "\"" + (bubble ? ",\"bubble\":true" : "") + "}}";
    private static string Hook(int n) =>
        "{\"id\":\"me-h" + n + "-0\",\"kind\":\"machine_event\",\"direction\":\"incoming\",\"at\":\"2026-11-21T06:35:00Z\",\"message\":\"hook\",\"sender\":{\"id\":\"b1\",\"name\":\"ベル\"},\"machine_event\":{\"seq\":" + n + ",\"part\":0,\"view\":\"hook\",\"display\":\"fold\",\"title\":\"hook\",\"text\":\"Stop\",\"fold_group\":\"hook\"}}";

    // The newest page is a folded run and one line, far less than the screen; the thinking row of the turn is on the older page.
    private sealed class Server : HttpMessageHandler
    {
        public readonly List<string> Reads = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.PathAndQuery;
            if (path.Contains("/messages")) Reads.Add(path);
            var thinking = """{"id":"me-286-0","kind":"machine_event","direction":"incoming","at":"2026-11-21T06:35:00Z","message":"thinking: x","sender":{"id":"b1","name":"ベル"},"machine_event":{"seq":286,"part":0,"view":"thinking","display":"show","text":"I am on Linux."}}""";
            var body = path switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""",
                "/api/setup" => """{"phase":"ready","harnesses":[],"complete":true}""",
                "/api/bots?avatar=omit" => """{"bots":[{"id":"b1","name":"ベル","displayName":"ベル","online":true}]}""",
                "/api/rooms?avatar=omit" => """{"rooms":[]}""",
                "/api/queue" => """{"items":[]}""",
                "/api/owner?avatar=omit" => """{"owner":{"name":"利用者"}}""",
                "/api/bots/b1/messages?limit=30" or "/api/bots/b1/messages?limit=100" => "{\"items\":[" + Hook(5) + "," + Hook(6) + "," + Words("me-7-0", "done") + "],\"has_more\":true}",
                var p when p.StartsWith("/api/bots/b1/messages?limit=500&before=me-h5-0") => "{\"items\":[" + thinking + "],\"has_more\":false}",
                _ => null
            };
            return Task.FromResult(body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    [Fact]
    public Task AShortFirstPageReadsOlderPagesUntilTheScreenIsFull() => Ui.Run(async () =>
    {
        var server = new Server();
        var model = new LinuxWorkspace(origin => new BellApi(origin, server));
        var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false }; window.Show();
        await model.ConnectAsync("http://localhost:1/", listen: false);
        await model.SelectAsync(model.Entries.Single());
        for (var round = 0; round < 100 && model.Messages.All(item => item.Message.Id != "me-286-0"); round++) { Dispatcher.UIThread.RunJobs(); await Task.Delay(20); }
        using (model)
        {
            Assert.Contains(model.Messages, item => item.Message.Id == "me-286-0");   // nobody scrolled or pressed the button
            Assert.False(model.HasMore);
        }
        window.Close();
    });

    [Fact]
    public Task OnlyTheWordsRowTheBodyMarkedIsABubbleAndTheMarkArrivesOnTheSameId() => Ui.Run(async () =>
    {
        var model = new LinuxWorkspace(origin => new BellApi(origin, new Server()));
        using (model)
        {
            TimelineMessage Row(string json) => JsonSerializer.Deserialize<TimelineMessage>(json, BellApi.Json)!;
            var item = new MessageItem(Row(Words("me-7-0", "**done**")));
            var card = new MessageCard(item, model);
            var host = new Avalonia.Controls.Window { Content = card }; host.Show();   // attached, so the card follows its item
            Assert.Single(card.GetLogicalDescendants().OfType<Avalonia.Controls.SelectableTextBlock>());
            Assert.Empty(card.GetLogicalDescendants().OfType<MarkdownView>());
            item.Update(Row(Words("me-7-0", "**done**", bubble: true)));   // the result line arrived: the same row, now marked
            Assert.NotEmpty(card.GetLogicalDescendants().OfType<MarkdownView>());   // the message bubble's own Markdown view, so ** is never raw
            host.Close();
        }
    });
}
