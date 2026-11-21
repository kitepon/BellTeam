using System.Net;
using System.Text;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

// a471-scrollback-linux (machine-stream.md "History pages of a long stream"): the first page asks 100, older pages ask 500 with before_at, and older pages are read ahead until
// max(3 screens, 150 rows) is loaded above the view, then reading stops although the history goes on.
public sealed class ScrollbackTests
{
    private sealed class Server : HttpMessageHandler
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
                var p when p.Contains("/messages?limit=100") => "{\"items\":[" + Rows("first", 3, 5000) + "],\"has_more\":true}",
                var p when p.Contains("/messages?limit=500&before=") => "{\"items\":[" + Rows("old" + older + "-", 40, 5000 - 100 * older) + "],\"has_more\":true}",
                _ => null
            };
            return Task.FromResult(body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    [Fact]
    public Task OlderPagesAreReadAheadWithBeforeAtAndStopOnceEnoughIsAboveTheView() => Ui.Run(async () =>
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
            Assert.StartsWith("/api/bots/b1/messages?limit=100", server.Reads[0]);
            Assert.NotEmpty(older);                                              // nobody scrolled or pressed the button
            Assert.All(older, read => Assert.Matches(@"limit=500&before=[^&]+&before_at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$", read));
            var settled = older.Length; for (var round = 0; round < 25; round++) { Dispatcher.UIThread.RunJobs(); await Task.Delay(20); }
            Assert.Equal(settled, server.Reads.Count(read => read.Contains("before=")));   // enough is loaded above the view: no more reads
            Assert.True(model.HasMore);                                          // the history goes on; reading stopped because the view has enough
            Assert.True(model.Messages.Count >= 150);
        }
        window.Close();
    });
}
