using System.Net;
using System.Text;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// a471-scrollback-linux (machine-stream.md "History pages of a long stream" and "Fill rule", 11/21 ruling): pages ask 1000 with before_at; the open reads older pages only until one screen is drawn
// (what is drawn, never a row count), then reading stops although the history goes on; a long first page reads none; scrolling up reads while less than one screen is above the view.
public sealed class ScrollbackTests
{
    private sealed class Server(int firstRows = 3) : HttpMessageHandler
    {
        public readonly List<string> Reads = [];
        private static string Rows(string prefix, int count, int minuteStart) => string.Join(",", Enumerable.Range(0, count).Select(index =>
            "{\"id\":\"" + prefix + index + "\",\"kind\":\"message\",\"direction\":\"incoming\",\"at\":\"" + new DateTimeOffset(2026, 11, 21, 0, 0, 0, TimeSpan.Zero).AddMinutes(minuteStart + index).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") + "\",\"message\":\"短い行\",\"sender\":{\"id\":\"b1\",\"name\":\"ベル\"}}"));
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.PathAndQuery;
            if (path.Contains("/messages")) Reads.Add(path);
            var older = Reads.Count(read => read.Contains("before="));
            var body = path switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""",
                "/api/setup" => """{"phase":"ready","harnesses":[],"complete":true}""",
                "/api/bots?avatar=omit" => """{"bots":[{"id":"b1","name":"ベル","displayName":"ベル","online":true}]}""",
                "/api/rooms?avatar=omit" => """{"rooms":[]}""",
                "/api/queue" => """{"items":[]}""",
                "/api/owner?avatar=omit" => """{"owner":{"name":"利用者"}}""",
                var p when p.Contains("/messages?limit=1000") && !p.Contains("before=") => "{\"items\":[" + Rows("first", firstRows, 5000) + "],\"has_more\":true}",
                var p when p.Contains("/messages?limit=1000&before=") => "{\"items\":[" + Rows("old" + older + "-", 40, 5000 - 100 * older) + "],\"has_more\":true}",
                _ => null
            };
            return Task.FromResult(body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    [Fact]
    public Task TheOpenReadsOlderPagesOnlyUntilOneScreenIsDrawnAndStops() => Ui.Run(async () =>
    {
        var server = new Server();
        var model = new LinuxWorkspace(origin => new BellApi(origin, server));
        var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false }; window.Show();
        await model.ConnectAsync("http://localhost:1/", listen: false);
        await model.SelectAsync(model.Entries.Single());
        for (var round = 0; round < 150; round++) { Dispatcher.UIThread.RunJobs(); await Task.Delay(20); }
        using (model)
        {
            var older = server.Reads.Where(read => read.Contains("before=")).ToArray();
            Assert.StartsWith("/api/bots/b1/messages?limit=1000", server.Reads[0]);
            Assert.NotEmpty(older);                                              // the first page (3 rows) does not fill one screen
            Assert.All(older, read => Assert.Matches(@"limit=1000&before=[^&]+&before_at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$", read));
            var settled = older.Length; for (var round = 0; round < 25; round++) { Dispatcher.UIThread.RunJobs(); await Task.Delay(20); }
            Assert.Equal(settled, server.Reads.Count(read => read.Contains("before=")));   // enough is loaded above the view: no more reads
            Assert.True(model.HasMore);                                          // the history goes on; reading stopped because the view has enough
            // a471-fill-drawn-linux: the first screen was short (3 rows), so the view was at the bottom; after older pages arrive it is still at the bottom (Avalonia keeps it, so no ScrollToEnd as on Windows).
            var scroll = window.GetVisualDescendants().OfType<ScrollViewer>().First(candidate => Avalonia.Automation.AutomationProperties.GetName(candidate) == "会話");
            Assert.True(scroll.Offset.Y + scroll.Viewport.Height >= scroll.Extent.Height - 2, $"offset {scroll.Offset.Y} viewport {scroll.Viewport.Height} extent {scroll.Extent.Height}");
            // a471-linux-android-older-button: with more history to read there is still no button; the scroll motion is the only way.
            Assert.DoesNotContain(window.GetVisualDescendants().OfType<Button>(), button => button.Content as string == "以前のメッセージを読む");
        }
        window.Close();
    });

    [Fact]
    public Task ALongFirstPageReadsNoOlderPageAtTheOpenAndScrollingUpReadsWhenLessThanOneScreenIsAbove() => Ui.Run(async () =>
    {
        var server = new Server(100);
        var model = new LinuxWorkspace(origin => new BellApi(origin, server));
        var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false }; window.Show();
        await model.ConnectAsync("http://localhost:1/", listen: false);
        await model.SelectAsync(model.Entries.Single());
        for (var round = 0; round < 60; round++) { Dispatcher.UIThread.RunJobs(); await Task.Delay(20); }
        using (model)
        {
            Assert.DoesNotContain(server.Reads, read => read.Contains("before="));   // the open shows the newest page and reads no older one
            var scroll = window.GetVisualDescendants().OfType<ScrollViewer>().First(candidate => Avalonia.Automation.AutomationProperties.GetName(candidate) == "会話");
            Assert.True(scroll.Extent.Height > scroll.Viewport.Height * 3, "a long first page");
            scroll.Offset = new Vector(0, scroll.Viewport.Height * 1.5);             // more than one screen above the view: still nothing to read
            for (var round = 0; round < 15; round++) { Dispatcher.UIThread.RunJobs(); await Task.Delay(20); }
            Assert.DoesNotContain(server.Reads, read => read.Contains("before="));
            scroll.Offset = new Vector(0, scroll.Viewport.Height * 0.5);             // less than one screen above the view: an older page is read
            for (var round = 0; round < 40; round++) { Dispatcher.UIThread.RunJobs(); await Task.Delay(20); }
            Assert.Contains(server.Reads, read => read.Contains("before="));
        }
        window.Close();
    });
}
