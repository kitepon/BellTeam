using System.Net;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;
public sealed class NotificationTests
{
    private static RecentMessage Recent(string id, string direction = "incoming", string? kind = "message", string? sender = null) => new() { Id = id, At = DateTimeOffset.UtcNow, Direction = direction, Kind = kind, Message = "新しい文", Sender = sender is null ? null : new Member { Id = sender } };
    [Theory]
    [InlineData(false,"message","返信が届きました。")]
    [InlineData(true,"message","ルームに新しいメッセージが届きました。")]
    [InlineData(false,"secret_request","秘密情報の入力が必要です。")]
    [InlineData(false,"owner_question","選んでほしいことがあります。")]
    public void NotificationContainsOnlyNamesAndFixedText(bool room,string kind,string expected)
    {
        var source = Recent("new",kind:kind,sender:"bot-haru") with { Message = "通知へ載せない会話本文と入力依頼の説明", Sender = new Member { Id = "bot-haru",Name="ハル" } };
        var notification = MessageNotification.FromRecent("https://example.test/",new("target",room),room?"計画室":"ユキ",Recent("old"),source)!;
        Assert.Equal(expected,notification.Body); Assert.Equal(room?"ハル · 計画室":"ユキ",notification.Title); Assert.DoesNotContain(source.Message,JsonSerializer.Serialize(notification,BellApi.Json));
    }
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
        await workspace.ConnectAsync("http://localhost"); await received.Task.WaitAsync(TimeSpan.FromSeconds(5)); Assert.Single(arrivals); Assert.Equal("ユキ", arrivals[0].Title); Assert.Equal("one", arrivals[0].Target!.Id);
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
    [Fact]
    public async Task ServerProjectedCandidatesDriveOnlyOneNotification()
    {
        var directory = Path.Combine(Path.GetTempPath(), "BellTeam-update-wire-" + Guid.NewGuid());
        try
        {
            var fixture = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "fixtures", "update-notification-wire.json")))!;
            var response = fixture["none"]!.DeepClone(); var calls = new List<string>();
            using var api = new BellApi(new("http://localhost/"), new StubHandler((request, _) => { calls.Add(request.Method + " " + request.RequestUri!.AbsolutePath); return Task.FromResult(StubHandler.Json(response.ToJsonString())); }));
            var store = new SettingsStore(directory); var sink = new FakeSink();
            await using var notifications = new DesktopNotifications(sink, store, (_, _) => { });
            await notifications.SetEnabledAsync(true);
            var center = new UpdateCenter(api, store);
            response.AsObject().Remove("notificationCandidates");
            await notifications.NotifyUpdatesAsync(center.Server, (await center.InventoryAsync()).NotificationCandidates);
            Assert.Empty(sink.Messages);
            response = fixture["none"]!.DeepClone();
            await notifications.NotifyUpdatesAsync(center.Server, (await center.InventoryAsync()).NotificationCandidates);
            Assert.Empty(sink.Messages);
            response = fixture["candidate"]!.DeepClone();
            await notifications.NotifyUpdatesAsync(center.Server, (await center.InventoryAsync()).NotificationCandidates);
            await notifications.NotifyUpdatesAsync(center.Server, (await center.InventoryAsync()).NotificationCandidates);
            Assert.Single(sink.Messages); Assert.Equal(new string('b', 64), sink.Messages[0].MessageId);
            Assert.All(calls, call => Assert.Equal("GET /api/updates", call));
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }
    [Fact]
    public async Task UpdatesUseOnlyCandidatesKeepDigestAndDoNotRepeatAfterFailure()
    {
        var directory = Path.Combine(Path.GetTempPath(), "BellTeam-update-notification-" + Guid.NewGuid());
        try
        {
            var store = new SettingsStore(directory); var sink = new FakeSink(); string? openedServer = null; ChatTarget? openedTarget = new("old", false);
            await using var notifications = new DesktopNotifications(sink, store, (server, target) => { openedServer = server; openedTarget = target; });
            var first = new UpdateCandidate("usage", new string('a', 64));
            await notifications.NotifyUpdatesAsync("http://localhost/", [first]); Assert.Equal(0, sink.Shows);
            await notifications.SetEnabledAsync(true);
            await Task.WhenAll(notifications.NotifyUpdatesAsync("http://localhost/", [first]), notifications.NotifyUpdatesAsync("http://localhost/", [first]));
            Assert.Single(sink.Messages); Assert.Null(sink.Messages[0].Target); Assert.Equal("update", sink.Messages[0].Kind); Assert.Equal(first.Id, sink.Messages[0].MessageId); Assert.Equal("BellTeam", sink.Messages[0].Title); Assert.Equal("更新があります。Updateで確認してください。", sink.Messages[0].Body);
            sink.Activated!(sink.Messages[0].Server, sink.Messages[0].Target); Assert.Equal("http://localhost/", openedServer); Assert.Null(openedTarget);
            await notifications.NotifyUpdatesAsync("http://localhost/", []);
            await notifications.NotifyUpdatesAsync("http://localhost/", [first]); Assert.Single(sink.Messages);
            sink.FailShow = true;
            var second = new UpdateCandidate("usage", new string('b', 64));
            await notifications.NotifyUpdatesAsync("http://localhost/", [second]); Assert.Equal(2, sink.Shows);
            sink.FailShow = false; await notifications.SetEnabledAsync(true);
            await notifications.NotifyUpdatesAsync("http://localhost/", [second]); Assert.Equal(2, sink.Shows);
            await notifications.NotifyUpdatesAsync("http://other/", [second]); Assert.Equal(3, sink.Shows);
            await Assert.ThrowsAsync<BellApiException>(() => notifications.NotifyUpdatesAsync("http://localhost/", [new("usage", "bad")]));
            await Assert.ThrowsAsync<BellApiException>(() => notifications.NotifyUpdatesAsync("http://localhost/", [new("other", new string('a', 64))]));
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    private sealed class FakeSink : INotificationSink
    {
        public int Starts; public int Shows; public int Stops; public bool FailStart; public bool FailShow; public Action<string>? Failure;
        public Action<string, ChatTarget?>? Activated;
        public List<MessageNotification> Messages { get; } = [];
        public void Start(Action<string, ChatTarget?> activated, Action<string> failed) { Activated = activated; Failure = failed; Starts++; if (FailStart) throw new InvalidOperationException("模擬の失敗"); }
        public void Show(MessageNotification message) { Shows++; Messages.Add(message); if (FailShow) throw new InvalidOperationException("模擬の失敗"); }
        public Task StopAsync() { Stops++; return Task.CompletedTask; }
    }
}
