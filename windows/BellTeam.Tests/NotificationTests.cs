using System.Net;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;
public sealed class NotificationTests
{
    private static RecentMessage Recent(string id, string direction = "incoming", string? kind = "message", string? sender = null) => new() { Id = id, At = DateTimeOffset.UtcNow, Direction = direction, Kind = kind, Message = "新しい文", Sender = sender is null ? null : new Member { Id = sender } };
    [Fact]
    public void NewIncomingOnlyAndFirstMessageAfterEmptyConversationAreEligible()
    {
        var direct = new ChatTarget("one", false); var previous = Recent("old");
        Assert.NotNull(MessageNotification.FromRecent("https://example.test/", direct, "ユキ", previous, Recent("new")));
        Assert.NotNull(MessageNotification.FromRecent("https://example.test/", direct, "ユキ", null, Recent("first")));
        Assert.Null(MessageNotification.FromRecent("https://example.test/", direct, "ユキ", previous, previous));
        Assert.Null(MessageNotification.FromRecent("https://example.test/", direct, "ユキ", previous, Recent("peer", kind: "peer")));
        Assert.Null(MessageNotification.FromRecent("https://example.test/", direct, "ユキ", previous, Recent("working", kind: "interim")));
        Assert.Null(MessageNotification.FromRecent("https://example.test/", direct, "ユキ", previous, Recent("mine", "outgoing")));
        var room = new ChatTarget("room", true); Assert.NotNull(MessageNotification.FromRecent("https://example.test/", room, "部屋", previous, Recent("new", sender: "one"))); Assert.Null(MessageNotification.FromRecent("https://example.test/", room, "部屋", previous, Recent("mine", sender: "user")));
    }
    [Fact]
    public async Task InitialAndManualReadsDoNotNotifyButSseChangeDoes()
    {
        var latest = "old"; var arrivals = new List<MessageNotification>(); var received = new TaskCompletionSource();
        using var workspace = new Workspace(origin => new BellApi(origin, new StubHandler((request, _) =>
        {
            if (request.RequestUri!.AbsolutePath == "/api/events") { latest = "new"; var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new MemoryStream(Encoding.UTF8.GetBytes("data: {\"at\":\"2026-10-13T00:00:00Z\"}\n\n"))) }; response.Content.Headers.ContentType = new MediaTypeHeaderValue("text/event-stream"); return Task.FromResult(response); }
            return Task.FromResult(StubHandler.Json(request.RequestUri.AbsolutePath switch { "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/bots" => JsonSerializer.Serialize(new { bots = new[] { new { id = "one", name = "ユキ", displayName = "ユキ", recent = Recent(latest) } } }, BellApi.Json), "/api/rooms" => """{"rooms":[]}""", "/api/queue" => ApiTests.EmptyQueue, "/api/owner" => ApiTests.Owner, _ => ApiTests.Page }));
        })));
        workspace.MessageArrived += notification => { arrivals.Add(notification); received.TrySetResult(); };
        await workspace.ConnectAsync("http://localhost", listen: false); Assert.Empty(arrivals);
        latest = "manual"; await workspace.RefreshManagementAsync(); Assert.Empty(arrivals);
        await workspace.ConnectAsync("http://localhost"); await received.Task.WaitAsync(TimeSpan.FromSeconds(5)); Assert.Single(arrivals); Assert.Equal("ユキ", arrivals[0].Title); Assert.Equal("one", arrivals[0].Target.Id);
    }
    [Fact]
    public async Task DefaultOffEnableDisableAndExitReleaseTheSinkAndPreserveOtherSettings()
    {
        var directory = Path.Combine(Path.GetTempPath(), "BellTeam-notifications-" + Guid.NewGuid()); var store = new SettingsStore(directory);
        try
        {
            store.Save(new() { ServerUrl = "https://example.test/" }); var sink = new FakeSink(); await using var notifications = new DesktopNotifications(sink, store, (_, _) => { });
            await notifications.InitializeAsync(); Assert.False(notifications.Enabled); Assert.Equal(0, sink.Starts);
            await notifications.NotifyAsync(new("https://example.test/", new("one", false), "ユキ", "本文")); Assert.Equal(0, sink.Shows);
            await notifications.SetEnabledAsync(true); Assert.True(store.Load().NotificationsEnabled); Assert.Equal("https://example.test/", store.Load().ServerUrl);
            await notifications.NotifyAsync(new("https://example.test/", new("one", false), "ユキ", "本文")); Assert.Equal(1, sink.Shows);
            await notifications.SetEnabledAsync(false); Assert.False(store.Load().NotificationsEnabled); Assert.Equal(1, sink.Stops);
            await notifications.SetEnabledAsync(true);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }
    [Theory]
    [InlineData(true)] [InlineData(false)]
    public async Task NativeFailureIsVisibleAndStopsWithoutRetry(bool onStart)
    {
        var directory = Path.Combine(Path.GetTempPath(), "BellTeam-notifications-" + Guid.NewGuid()); var store = new SettingsStore(directory);
        try
        {
            var sink = new FakeSink { FailStart = onStart, FailShow = !onStart }; await using var notifications = new DesktopNotifications(sink, store, (_, _) => { });
            await notifications.SetEnabledAsync(true); if (!onStart) await notifications.NotifyAsync(new("https://example.test/", new("one", false), "ユキ", "本文"));
            Assert.False(notifications.Enabled); Assert.Contains("模擬の失敗", notifications.Status); Assert.Equal(1, sink.Starts); Assert.Equal(1, sink.Stops);
            await notifications.NotifyAsync(new("https://example.test/", new("one", false), "ユキ", "次の本文")); Assert.Equal(onStart ? 0 : 1, sink.Shows);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
    }
    [Fact]
    public async Task AsynchronousWindowsFailureStopsAndExitReleasesTheSink()
    {
        var directory = Path.Combine(Path.GetTempPath(), "BellTeam-notifications-" + Guid.NewGuid()); var store = new SettingsStore(directory); var sink = new FakeSink();
        try
        {
            await using (var notifications = new DesktopNotifications(sink,store,(_,_)=>{}))
            {
                await notifications.SetEnabledAsync(true); sink.Failure!("模擬の非同期エラー");
                Assert.False(notifications.Enabled); Assert.Contains("模擬の非同期エラー",notifications.Error); Assert.Equal(1,sink.Stops);
                await notifications.SetEnabledAsync(true);
            }
            Assert.Equal(2,sink.Stops);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory,recursive:true); }
    }
    private sealed class FakeSink : INotificationSink
    {
        public int Starts; public int Shows; public int Stops; public bool FailStart; public bool FailShow; public Action<string>? Failure;
        public void Start(Action<string, ChatTarget> activated, Action<string> failed) { Failure = failed; Starts++; if (FailStart) throw new InvalidOperationException("模擬の失敗"); }
        public void Show(MessageNotification message) { Shows++; if (FailShow) throw new InvalidOperationException("模擬の失敗"); }
        public Task StopAsync() { Stops++; return Task.CompletedTask; }
    }
}
