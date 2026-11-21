using System.Net;
using System.Text;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;
using Xunit.Abstractions;

namespace BellTeam.Linux;

// a471-scroll-jump-linux: the row the Owner is looking at stays where it is in the view while older pages load (even while the Owner keeps scrolling) and while rows above it change height.
public sealed class ScrollJumpTests(ITestOutputHelper output)
{
    private sealed class Server : HttpMessageHandler
    {
        public int OlderDelayMs;
        public bool Fresh;   // the newest rows have changed on the server: a refresh of the latest page brings one more row
        public int Older;
        private static string Rows(string prefix, int count, int minuteStart) => string.Join(",", Enumerable.Range(0, count).Select(index =>
            "{\"id\":\"" + prefix + index + "\",\"kind\":\"message\",\"direction\":\"incoming\",\"at\":\"" + new DateTimeOffset(2026, 11, 21, 0, 0, 0, TimeSpan.Zero).AddMinutes(minuteStart + index).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") +
            "\",\"message\":\"" + prefix + index + " " + string.Concat(Enumerable.Repeat("あいうえお", 1 + index * 7 % 11)) + "\",\"sender\":{\"id\":\"b1\",\"name\":\"ベル\"}}"));
        private static string Slice(string prefix, int from, int count, int minuteStart) => string.Join(",", Enumerable.Range(from, count).Select(index =>
            "{\"id\":\"" + prefix + index + "\",\"kind\":\"message\",\"direction\":\"incoming\",\"at\":\"" + new DateTimeOffset(2026, 11, 21, 0, 0, 0, TimeSpan.Zero).AddMinutes(minuteStart + index).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") +
            "\",\"message\":\"" + prefix + index + " " + string.Concat(Enumerable.Repeat("あいうえお", 1 + index * 7 % 11)) + "\",\"sender\":{\"id\":\"b1\",\"name\":\"ベル\"}}"));
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.PathAndQuery;
            var older = path.Contains("/messages?limit=500&before=");
            if (older) { Older++; if (OlderDelayMs > 0) await Task.Delay(OlderDelayMs, cancellationToken); }
            var body = path switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""",
                "/api/setup" => """{"phase":"ready","harnesses":[],"complete":true}""",
                "/api/bots?avatar=omit" => """{"bots":[{"id":"b1","name":"ベル","displayName":"ベル","online":true}]}""",
                "/api/rooms?avatar=omit" => """{"rooms":[]}""",
                "/api/queue" => """{"items":[]}""",
                "/api/owner?avatar=omit" => """{"owner":{"name":"利用者"}}""",
                var p when p.Contains("/messages?limit=30") => "{\"items\":[" + Slice("first", 70, 30, 5000) + (Fresh ? "," + Slice("fresh", 0, 1, 6000) : "") + "],\"has_more\":true}",
                var p when p.Contains("/messages?after=") => "{\"items\":[" + (Fresh ? Slice("fresh", 0, 1, 6000) : "") + "],\"has_more\":false}",
                var p when p.Contains("/messages?limit=100") => "{\"items\":[" + Rows("first", 100, 5000) + "],\"has_more\":true}",
                var p when older => "{\"items\":[" + Rows("old" + Older + "-", 500, 5000 - 500 * Older) + "],\"has_more\":true}",
                _ => null
            };
            return body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        }
    }

    private static async Task Settle(int rounds = 40) { for (var round = 0; round < rounds; round++) { Dispatcher.UIThread.RunJobs(); await Task.Delay(20); } }
    private static ScrollViewer ScrollOf(Window window) => window.GetVisualDescendants().OfType<ScrollViewer>().First(candidate => AutomationProperties.GetName(candidate) == "会話");
    // The first card that is wholly inside the view, and where its top is in the view.
    private static (MessageCard Card, double Top) Anchor(ScrollViewer scroll) => scroll.GetVisualDescendants().OfType<MessageCard>()
        .Select(card => (Card: card, Top: card.TranslatePoint(new Point(0, 0), scroll)?.Y ?? double.NaN)).First(entry => entry.Top >= 0 && entry.Top + entry.Card.Bounds.Height <= scroll.Viewport.Height);
    private static double Top(ScrollViewer scroll, MessageCard card) => card.TranslatePoint(new Point(0, 0), scroll)?.Y ?? double.NaN;

    private async Task<(Server Server, LinuxWorkspace Model, MainWindow Window, ScrollViewer Scroll)> OpenAsync()
    {
        var server = new Server();
        var model = new LinuxWorkspace(origin => new BellApi(origin, server));
        var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false }; window.Show();
        await model.ConnectAsync("http://localhost:1/", listen: false);
        await model.SelectAsync(model.Entries.Single());
        await Settle(100);
        return (server, model, window, ScrollOf(window));
    }

    [Fact]
    public Task TheRowBeingLookedAtStaysPutWhileAnOlderPageLoads() => Ui.Run(async () =>
    {
        var (server, model, window, scroll) = await OpenAsync();
        using (model)
        {
            var reads = server.Older;
            scroll.Offset = new Vector(0, scroll.Viewport.Height);   // too little is left above the view: an older page is read
            await Settle(5);
            var (card, before) = Anchor(scroll);
            await Settle(100);
            var after = Top(scroll, card);
            output.WriteLine($"older reads {server.Older - reads}: anchor top {before:F1} -> {after:F1}");
            Assert.True(server.Older > reads, "an older page was read");
            Assert.True(Math.Abs(after - before) <= 1, $"the row moved from {before:F1} to {after:F1}");
        }
        window.Close();
    });

    [Fact]
    public Task TheRowBeingLookedAtStaysPutWhenTheOwnerKeepsScrollingWhileAnOlderPageLoads() => Ui.Run(async () =>
    {
        var (server, model, window, scroll) = await OpenAsync();
        using (model)
        {
            server.OlderDelayMs = 500; var reads = server.Older;
            scroll.Offset = new Vector(0, scroll.Viewport.Height);   // the read starts and waits 500 ms
            await Settle(5);
            scroll.Offset = new Vector(0, scroll.Offset.Y + 300);    // the Owner scrolls on while it is on its way
            await Settle(3);
            var (card, before) = Anchor(scroll);
            await Settle(100);
            var after = Top(scroll, card);
            output.WriteLine($"older reads {server.Older - reads}: anchor top {before:F1} -> {after:F1}");
            Assert.True(server.Older > reads, "an older page was read");
            Assert.True(Math.Abs(after - before) <= 1, $"the row moved from {before:F1} to {after:F1}");
        }
        window.Close();
    });

    [Fact]
    public Task TheRowBeingLookedAtStaysPutWhenARowAboveItChangesHeight() => Ui.Run(async () =>
    {
        var (server, model, window, scroll) = await OpenAsync();
        using (model)
        {
            scroll.Offset = new Vector(0, scroll.Viewport.Height * 4);
            await Settle(30);
            var (card, before) = Anchor(scroll);
            var above = scroll.GetVisualDescendants().OfType<MessageCard>().First(candidate => Top(scroll, candidate) < -200);   // an image that finished loading, a fold that opened
            above.MinHeight = above.Bounds.Height + 120;
            await Settle(10);
            var after = Top(scroll, card);
            output.WriteLine($"anchor top {before:F1} -> {after:F1}");
            Assert.True(Math.Abs(after - before) <= 1, $"the row moved from {before:F1} to {after:F1}");
        }
        window.Close();
    });
    [Fact]
    public Task TheRowBeingLookedAtStaysPutWhenNewRowsArriveBelowIt() => Ui.Run(async () =>
    {
        var (server, model, window, scroll) = await OpenAsync();
        using (model)
        {
            scroll.Offset = new Vector(0, scroll.Viewport.Height * 4);
            await Settle(30);
            var (card, before) = Anchor(scroll);
            var last = model.Messages[^1].Message;
            for (var index = 0; index < 3; index++) model.Messages.Add(new MessageItem(last with { Id = "new" + index, Message = "新着 " + index }));
            await Settle(20);
            var after = Top(scroll, card);
            output.WriteLine($"anchor top {before:F1} -> {after:F1}");
            Assert.True(Math.Abs(after - before) <= 1, $"the row moved from {before:F1} to {after:F1}");
        }
        window.Close();
    });
    [Fact]
    public Task TheRowBeingLookedAtStaysPutWhenTheLatestPageIsRefreshed() => Ui.Run(async () =>
    {
        var (server, model, window, scroll) = await OpenAsync();
        using (model)
        {
            scroll.Offset = new Vector(0, scroll.Viewport.Height * 4);
            await Settle(30);
            var (card, before) = Anchor(scroll);
            server.Fresh = true;
            await model.RefreshManagementAsync();   // the refresh of the latest page (reconnect, a gap in the event stream, the app coming back)
            await Settle(30);
            var after = Top(scroll, card);
            output.WriteLine($"refresh: rows {model.Messages.Count}, anchor top {before:F1} -> {after:F1}");
            Assert.Contains(model.Messages, item => item.Message.Id == "fresh0");
            Assert.True(Math.Abs(after - before) <= 1, $"the row moved from {before:F1} to {after:F1}");
        }
        window.Close();
    });
}
