using System.Net;
using System.Text;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;
using Xunit.Abstractions;

namespace BellTeam.Linux;

// a471-open-newest-linux: the newest row is the anchor (NewestColumn): opening, a new row and a sent bubble are at the newest in the layout pass that adds them; reading older rows nothing moves.
public sealed class ScrollFollowTests
{
    private sealed class Server : HttpMessageHandler
    {
        private static string Rows(int count) => string.Join(",", Enumerable.Range(0, count).Select(index =>
            "{\"id\":\"r" + index + "\",\"kind\":\"message\",\"direction\":\"incoming\",\"at\":\"" + new DateTimeOffset(2026, 11, 21, 0, 0, 0, TimeSpan.Zero).AddMinutes(index).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") +
            "\",\"message\":\"r" + index + " " + string.Concat(Enumerable.Repeat("あいうえお", 1 + index * 7 % 11)) + "\",\"sender\":{\"id\":\"b1\",\"name\":\"ベル\"}}"));
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.RequestUri!.PathAndQuery switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""",
                "/api/setup" => """{"phase":"ready","harnesses":[],"complete":true}""",
                "/api/bots?avatar=omit" => """{"bots":[{"id":"b1","name":"ベル","displayName":"ベル","online":true}]}""",
                "/api/rooms?avatar=omit" => """{"rooms":[]}""",
                "/api/queue" => """{"items":[]}""",
                "/api/owner?avatar=omit" => """{"owner":{"name":"利用者"}}""",
                var p when p.EndsWith("/messages") && request.Method == HttpMethod.Post => """{"delivery_id":"sent-1"}""",
                var p when p.Contains("/messages?limit=10") => "{\"items\":[" + Rows(100) + "],\"has_more\":false}",
                var p when p.Contains("/messages?after=") => """{"items":[],"has_more":false}""",
                var p when p.Contains("/messages?limit=1000") && !p.Contains("before=") => "{\"items\":[" + Rows(100) + "],\"has_more\":false}",
                _ => null
            };
            return Task.FromResult(body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    private static async Task Settle(int rounds) { for (var round = 0; round < rounds; round++) { Dispatcher.UIThread.RunJobs(); await Task.Delay(20); } }
    private static ScrollViewer ScrollOf(Window window) => window.GetVisualDescendants().OfType<ScrollViewer>().First(candidate => AutomationProperties.GetName(candidate) == "会話");
    private static double DistanceToEnd(ScrollViewer scroll) => scroll.Extent.Height - scroll.Viewport.Height - scroll.Offset.Y;

    private static void AddRows(LinuxWorkspace model, string prefix = "new")
    {
        var last = model.Messages[^1].Message;
        for (var index = 0; index < 3; index++) model.Messages.Add(new MessageItem(last with { Id = prefix + index, At = last.At.AddMinutes(1 + index), Message = string.Concat(Enumerable.Repeat("新着の長い行です。", 30)) }));
    }

    // Every offset the view had after a layout pass with something to scroll; a catch-up would leave a value that is not the end.
    private static List<double> WatchDistances(ScrollViewer scroll)
    {
        var seen = new List<double>();
        scroll.ScrollChanged += (_, _) => { if (scroll.Extent.Height > scroll.Viewport.Height) seen.Add(DistanceToEnd(scroll)); };
        return seen;
    }

    // (a) The first frame is the newest rows at the bottom: one layout pass after the rows arrive, no scroll command and no later catch-up.
    [Fact]
    public Task OpeningShowsTheNewestAtOnce() => Ui.Run(async () =>
    {
        var model = new LinuxWorkspace(origin => new BellApi(origin, new Server()));
        var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false }; window.Show();
        using (model)
        {
            await model.ConnectAsync("http://localhost:1/", listen: false);
            var scroll = ScrollOf(window); var seen = WatchDistances(scroll);
            await model.SelectAsync(model.Entries.Single());
            window.UpdateLayout();
            Assert.True(scroll.Extent.Height > scroll.Viewport.Height * 3, "a long conversation");
            Assert.True(DistanceToEnd(scroll) < 1, $"the first frame is at the newest ({DistanceToEnd(scroll):F1} px from it)");
            await Settle(60);
            Assert.True(DistanceToEnd(scroll) < 1, "still at the newest after the background work");
            Assert.True(seen.Count != 0 && seen.All(distance => distance < 1), "every frame after the rows arrived was at the newest: " + string.Join(", ", seen.Select(distance => distance.ToString("F0"))));
        }
        window.Close();
    });

    // (b) A sent bubble and (c) a new row while following: at the newest in the layout pass that adds them, held rows stay.
    [Fact]
    public Task NewRowsWhileFollowingAreAtTheNewestInTheSamePass() => Ui.Run(async () =>
    {
        var (model, window, scroll) = await OpenAsync();
        using (model)
        {
            var seen = WatchDistances(scroll);
            for (var round = 0; round < 3; round++) { AddRows(model, "n" + round + "_"); window.UpdateLayout(); Assert.True(DistanceToEnd(scroll) < 1, $"round {round}: {DistanceToEnd(scroll):F1} px from the newest"); }
            await Settle(10);
            Assert.True(seen.All(distance => distance < 1), "no frame between: " + string.Join(", ", seen.Select(distance => distance.ToString("F0"))));
            Assert.Equal(109, model.Messages.Count);
        }
        window.Close();
    });

    // Reading older rows: a new row below and an older page above move nothing; reaching the end follows again.
    [Fact]
    public Task WhileReadingOlderNothingMoves() => Ui.Run(async () =>
    {
        var (model, window, scroll) = await OpenAsync();
        using (model)
        {
            scroll.Offset = new Vector(0, scroll.Extent.Height / 2); window.UpdateLayout(); await Settle(5);
            var offset = scroll.Offset.Y;
            AddRows(model); window.UpdateLayout(); await Settle(5);
            Assert.True(Math.Abs(scroll.Offset.Y - offset) < 1, $"a new row below moved the view by {scroll.Offset.Y - offset:F1} px");
            var card = window.GetVisualDescendants().OfType<MessageCard>().First(c => c.TranslatePoint(default, scroll) is { } at && at.Y >= 0);
            var before = card.TranslatePoint(default, scroll)!.Value.Y;
            var first = model.Messages[0].Message;
            for (var index = 0; index < 5; index++) model.Messages.Insert(0, new MessageItem(first with { Id = "old" + index, At = first.At.AddMinutes(-5 + index), Message = string.Concat(Enumerable.Repeat("古い行です。", 40)) }));
            window.UpdateLayout(); await Settle(5);
            Assert.True(Math.Abs(card.TranslatePoint(default, scroll)!.Value.Y - before) < 1, "an older page above moved the row being read");
            scroll.Offset = new Vector(0, scroll.Extent.Height); window.UpdateLayout();
            AddRows(model, "after"); window.UpdateLayout();
            Assert.True(DistanceToEnd(scroll) < 1, "back at the end the view follows again");
        }
        window.Close();
    });

    // Owner 11/21 17:2x: send = the newest edge + follow, from any position (a471-send-follow): the sent bubble is at the bottom in the layout pass that adds it, and rows after it follow.
    [Fact]
    public Task SendingWhileReadingOlderGoesToTheNewestAndFollows() => Ui.Run(async () =>
    {
        var (model, window, scroll) = await OpenAsync();
        using (model)
        {
            scroll.Offset = new Vector(0, scroll.Extent.Height / 3); window.UpdateLayout(); await Settle(5);
            Assert.True(DistanceToEnd(scroll) > scroll.Viewport.Height * 3, "reading far above the newest");
            model.DraftText = "送る文です";
            var sending = model.SendAsync();
            window.UpdateLayout();
            Assert.True(DistanceToEnd(scroll) < 1, $"the sent bubble is at the newest at once ({DistanceToEnd(scroll):F0} px away)");
            await sending; await Settle(10);
            Assert.True(DistanceToEnd(scroll) < 1, "still at the newest after the server accepted it and the refresh ran");
            AddRows(model, "answer"); window.UpdateLayout();
            Assert.True(DistanceToEnd(scroll) < 1, "rows after the send are followed");
        }
        window.Close();
    });

    private async Task<(LinuxWorkspace Model, MainWindow Window, ScrollViewer Scroll)> OpenAsync()
    {
        var model = new LinuxWorkspace(origin => new BellApi(origin, new Server()));
        var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false }; window.Show();
        await model.ConnectAsync("http://localhost:1/", listen: false);
        await model.SelectAsync(model.Entries.Single());
        await Settle(60);
        var scroll = ScrollOf(window);
        Assert.True(DistanceToEnd(scroll) < 1, "the conversation opens at the newest");
        return (model, window, scroll);
    }
}
