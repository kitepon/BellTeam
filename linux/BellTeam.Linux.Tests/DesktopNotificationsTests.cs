using BellTeam.Core;

namespace BellTeam.Linux;

// The sink against a stand-in for the notification daemon: what Notify is called with, and how a click is routed back.
public sealed class DesktopNotificationsTests
{
    private sealed class FakeBus : INotificationBus
    {
        public readonly List<NotifyCall> Calls = [];
        public readonly List<uint> Closed = [];
        public bool Disposed, FailConnect;
        public Exception? FailNotify;
        private Action<uint, string> actionInvoked = (_, _) => { };
        private Action<uint, uint> closed = (_, _) => { };
        private uint next = 100;
        public Task ConnectAsync(Action<uint, string> actionInvoked, Action<uint, uint> closed)
        {
            if (FailConnect) throw new InvalidOperationException("模擬の接続失敗");
            this.actionInvoked = actionInvoked; this.closed = closed; return Task.CompletedTask;
        }
        public Task<uint> NotifyAsync(NotifyCall call)
        {
            if (FailNotify is not null) throw FailNotify;
            Calls.Add(call);
            return Task.FromResult(next++);
        }
        public Task CloseAsync(uint id) { Closed.Add(id); return Task.CompletedTask; }
        public void Dispose() => Disposed = true;
        public void Click(uint id, string action = "default") => actionInvoked(id, action);
        public void Dismiss(uint id) => closed(id, 2);
    }

    private static async Task WaitUntil(Func<bool> condition)
    {
        for (var attempt = 0; attempt < 500 && !condition(); attempt++) await Task.Delay(10);
        Assert.True(condition(), "条件が時間内に満たされませんでした。");
    }
    private static readonly MessageNotification Message = new("https://example.test/", new("bot-one", false), "ユキ", "返信が届きました。");

    private static (FreedesktopNotificationSink Sink, FakeBus Bus, List<(string Server, ChatTarget? Target)> Opened) Started()
    {
        var bus = new FakeBus(); var sink = new FreedesktopNotificationSink(() => bus);
        var opened = new List<(string, ChatTarget?)>();
        sink.Start((server, target) => opened.Add((server, target)), _ => { });
        return (sink, bus, opened);
    }

    [Fact]
    public async Task NotifyCarriesTheTitleBodyAndTheDefaultAction()
    {
        var (sink, bus, _) = Started();
        await sink.ShowAsync(Message);
        var call = Assert.Single(bus.Calls);
        Assert.Equal("BellTeam", call.AppName); Assert.Equal("ユキ", call.Summary); Assert.Equal("返信が届きました。", call.Body);
        Assert.Equal(new[] { "default", "開く" }, call.Actions); Assert.Equal("bellteam", call.Hints["desktop-entry"]);
        Assert.Equal(0u, call.ReplacesId); Assert.Equal(-1, call.ExpireTimeout);
    }

    [Fact]
    public async Task TheDefaultActionOpensThatConversationOnceAndOtherActionsAreIgnored()
    {
        var (sink, bus, opened) = Started();
        await sink.ShowAsync(Message); await sink.ShowAsync(Message with { Target = new("room", true) });
        bus.Click(100, "other"); Assert.Empty(opened);
        bus.Click(101); bus.Click(101);
        Assert.Equal([("https://example.test/", (ChatTarget?)new ChatTarget("room", true))], opened);
        bus.Click(100); Assert.Equal(new ChatTarget("bot-one", false), opened[1].Target);
    }

    [Fact]
    public async Task AnUpdateNotificationActivatesWithoutAConversation()
    {
        var (sink, bus, opened) = Started();
        await sink.ShowAsync(new("https://example.test/", null, "BellTeam", "更新があります。Updateで確認してください。", "update", new string('a', 64)));
        bus.Click(100);
        Assert.Equal(("https://example.test/", (ChatTarget?)null), Assert.Single(opened));
    }

    [Fact]
    public async Task ADismissedNotificationIsForgotten()
    {
        var (sink, bus, opened) = Started();
        await sink.ShowAsync(Message);
        bus.Dismiss(100); bus.Click(100);
        Assert.Empty(opened);
    }

    [Fact]
    public async Task StopClosesTheOpenNotificationsAndReleasesTheBus()
    {
        var (sink, bus, _) = Started();
        await sink.ShowAsync(Message); await sink.ShowAsync(Message);
        bus.Dismiss(100);
        await sink.StopAsync();
        Assert.Equal(new uint[] { 101 }, bus.Closed); Assert.True(bus.Disposed);
    }

    [Fact]
    public async Task ABusFailureIsReportedAndTurnsTheSettingOffWithTheReason()
    {
        var directory = Path.Combine(Path.GetTempPath(), "BellTeam-linux-notifications-" + Guid.NewGuid()); var store = new SettingsStore(directory);
        try
        {
            var bus = new FakeBus { FailConnect = true };
            await using var notifications = new DesktopNotifications(new FreedesktopNotificationSink(() => bus), store, (_, _) => { });
            await notifications.InitializeAsync(); Assert.False(notifications.Enabled);
            await notifications.SetEnabledAsync(true);
            await WaitUntil(() => !notifications.Enabled);
            Assert.Contains("デスクトップ通知を表示できませんでした。模擬の接続失敗", notifications.Status);
            await WaitUntil(() => bus.Disposed);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public async Task AFailedNotifyIsReportedToo()
    {
        var bus = new FakeBus { FailNotify = new InvalidOperationException("模擬の送信失敗") };
        var sink = new FreedesktopNotificationSink(() => bus); var failures = new List<string>();
        sink.Start((_, _) => { }, failures.Add);
        await sink.ShowAsync(Message);
        Assert.Equal("デスクトップ通知を表示できませんでした。模擬の送信失敗", Assert.Single(failures));
    }
}
