using System.Net;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

public sealed class ReconnectTests
{
    private const string Ended = "更新の接続が切れました。再接続しています。", Failed = "更新へ接続できません。再接続しています。";

    [Fact]
    public void BackoffFollowsTheWebSchedule()
    {
        Assert.Equal([0, 1000, 2000, 4000, 8000, 15000, 15000, 15000], Enumerable.Range(0, 8).Select(attempt => ReconnectBackoff.Ms(attempt, () => 0.5)));
        Assert.Equal(0, ReconnectBackoff.Ms(-3, () => 1));
        Assert.Equal([0, 800, 1600, 3200, 6400, 12000], Enumerable.Range(0, 6).Select(attempt => ReconnectBackoff.Ms(attempt, () => 0)));
        Assert.Equal([0, 1200, 2400, 4800, 9600, 18000], Enumerable.Range(0, 6).Select(attempt => ReconnectBackoff.Ms(attempt, () => 1)));
        for (var index = 0; index < 200; index++) { var ms = ReconnectBackoff.Ms(5); Assert.InRange(ms, 12000, 18000); }
    }

    private sealed class Harness : IDisposable
    {
        public readonly List<int> Delays = [];
        public readonly List<string?> Errors = [];
        public int EventRequests;
        public readonly Workspace Workspace;
        private readonly Queue<Func<CancellationToken, Task<HttpResponseMessage>>> script;
        private readonly SemaphoreSlim progress = new(0);
        public Harness(IEnumerable<Func<CancellationToken, Task<HttpResponseMessage>>> events, Func<int, CancellationToken, Task>? onDelay = null)
        {
            script = new(events);
            Workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, token) =>
            {
                var path = request.RequestUri!.AbsolutePath;
                if (path == "/api/events") { Interlocked.Increment(ref EventRequests); progress.Release(); return script.Dequeue()(token); }
                return Task.FromResult(StubHandler.Json(path switch { "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/bots" => ApiTests.Bots, "/api/rooms" => ApiTests.Rooms, "/api/queue" => ApiTests.EmptyQueue, "/api/owner" => ApiTests.Owner, _ => ApiTests.Page }));
            })), retryDelay: async (attempt, token) => { lock (Delays) Delays.Add(attempt); progress.Release(); await (onDelay?.Invoke(attempt, token) ?? Task.CompletedTask); });
        }
        public async Task StartAsync()
        {
            // Subscribed first: the stream starts inside ConnectAsync. The leading null is ConnectAsync clearing the error.
            Workspace.PropertyChanged += (_, args) => { if (args.PropertyName == nameof(Workspace.ConnectionError)) lock (Errors) Errors.Add(Workspace.ConnectionError); };
            await Workspace.ConnectAsync("http://localhost");
        }
        public async Task UntilAsync(Func<bool> done) { for (var turn = 0; turn < 500 && !done(); turn++) { await progress.WaitAsync(TimeSpan.FromMilliseconds(20)); } Assert.True(done()); }
        public void Dispose() => Workspace.Dispose();
    }

    private static Func<CancellationToken, Task<HttpResponseMessage>> Stream(string text) => _ =>
    {
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new MemoryStream(Encoding.UTF8.GetBytes(text))) };
        response.Content.Headers.ContentType = new MediaTypeHeaderValue("text/event-stream");
        return Task.FromResult(response);
    };
    private static Func<CancellationToken, Task<HttpResponseMessage>> Status(HttpStatusCode status) => _ => Task.FromResult(StubHandler.Json("{}", status));
    private static Func<CancellationToken, Task<HttpResponseMessage>> Throws(Exception error) => _ => Task.FromException<HttpResponseMessage>(error);
    // The last connection stays open until the workspace cancels it.
    private static Func<CancellationToken, Task<HttpResponseMessage>> Hangs() => async token => { await Task.Delay(Timeout.Infinite, token); return new HttpResponseMessage(); };

    [Fact]
    public async Task StreamReconnectsAfterEndAndAfterFailuresWithTheMacTexts()
    {
        using var harness = new Harness([Stream("event: ready\ndata: {}\n\n"), Status(HttpStatusCode.ServiceUnavailable), Throws(new HttpRequestException("down")), Stream("event: ready\ndata: {}\n\n"), Hangs()]);
        await harness.StartAsync();
        await harness.UntilAsync(() => harness.EventRequests == 5);
        Assert.Equal([0, 1, 2, 3], harness.Delays);
        Assert.Equal(new string?[] { null, Ended, Failed, Failed, null, Ended }, harness.Errors);
    }

    [Fact]
    public async Task TooManyRequestsReconnects()
    {
        using var harness = new Harness([Status(HttpStatusCode.TooManyRequests), Hangs()]);
        await harness.StartAsync();
        await harness.UntilAsync(() => harness.EventRequests == 2);
        Assert.Equal(new string?[] { null, Failed }, harness.Errors);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Found)]
    public async Task ARefusedLoginStopsWithoutLooping(HttpStatusCode status)
    {
        using var harness = new Harness([Status(status)]);
        await harness.StartAsync();
        await harness.UntilAsync(() => harness.Errors.Count == 2);
        await Task.Delay(50);
        Assert.Equal(1, harness.EventRequests); Assert.Empty(harness.Delays);
        Assert.True(harness.Workspace.NeedsLogin);
        Assert.NotEqual(Failed, harness.Errors[1]);
    }

    [Fact]
    public async Task AnUnexpectedRefusalIsShownAndStillReconnects()
    {
        using var harness = new Harness([Status(HttpStatusCode.NotFound), Hangs()]);
        await harness.StartAsync();
        await harness.UntilAsync(() => harness.EventRequests == 2);
        Assert.StartsWith(Failed + "（", harness.Errors[1]);
        Assert.False(harness.Workspace.NeedsLogin);
    }

    [Fact]
    public async Task SignOutAndDisposeCancelAPendingReconnect()
    {
        var waiting = new TaskCompletionSource(); var cancelled = new TaskCompletionSource();
        using var harness = new Harness([Stream("data: {}\n\n"), Hangs()], async (_, token) => { waiting.TrySetResult(); try { await Task.Delay(Timeout.Infinite, token); } catch (OperationCanceledException) { cancelled.TrySetResult(); throw; } });
        await harness.StartAsync();
        await waiting.Task.WaitAsync(TimeSpan.FromSeconds(5));
        harness.Workspace.SignOut();
        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Task.Delay(50);
        Assert.Equal(1, harness.EventRequests); Assert.Equal([0], harness.Delays);
    }

    [Fact]
    public async Task AReconnectSupersededByANewConnectionDoesNotOverlap()
    {
        var waiting = new TaskCompletionSource();
        using var harness = new Harness([Stream("data: {}\n\n"), Stream("data: {}\n\n"), Hangs()], async (attempt, token) => { if (waiting.TrySetResult()) await Task.Delay(Timeout.Infinite, token); });
        await harness.StartAsync();
        await waiting.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await harness.Workspace.ConnectAsync("http://localhost");
        await harness.UntilAsync(() => harness.EventRequests == 3 && harness.Delays.Count == 2);
        // The old loop ended with its connection: the new one started its own schedule at 0 and is the only one running.
        Assert.Equal([0, 0], harness.Delays);
    }
}
