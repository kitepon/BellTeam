using System.ComponentModel;
using System.Runtime.CompilerServices;
using BellTeam.Core;
using Tmds.DBus.Protocol;

namespace BellTeam.Linux;

public interface INotificationSink
{
    void Start(Action<string, ChatTarget?> activated, Action<string> failed);
    void Show(MessageNotification message);
    Task StopAsync();
}

// One org.freedesktop.Notifications.Notify call (signature susssasa{sv}i).
public sealed record NotifyCall(string AppName, uint ReplacesId, string Icon, string Summary, string Body, string[] Actions, IReadOnlyDictionary<string, string> Hints, int ExpireTimeout);

// The only D-Bus surface the sink uses, so a windowless test can stand in for the notification daemon.
public interface INotificationBus : IDisposable
{
    // Connects and subscribes to ActionInvoked(id, action_key) and NotificationClosed(id, reason). The handlers may run on any thread.
    Task ConnectAsync(Action<uint, string> actionInvoked, Action<uint, uint> closed);
    Task<uint> NotifyAsync(NotifyCall call);
    Task CloseAsync(uint id);
}

public sealed class FreedesktopNotificationSink(Func<INotificationBus>? createBus = null) : INotificationSink
{
    public const string DefaultAction = "default";
    private readonly Func<INotificationBus> createBus = createBus ?? (() => new DBusNotificationBus());
    private readonly object gate = new();
    private readonly Dictionary<uint, MessageNotification> visible = [];
    private INotificationBus? bus;
    private Task connecting = Task.CompletedTask;
    private Action<string, ChatTarget?>? activated;
    private Action<string>? failed;

    // The session bus is reached asynchronously: a failure comes back through failed, which turns the setting off and shows the reason (as the Windows toast Failed event does).
    public void Start(Action<string, ChatTarget?> activated, Action<string> failed)
    {
        this.activated = activated; this.failed = failed;
        var current = bus = createBus();
        connecting = ConnectAsync(current);
    }
    private async Task ConnectAsync(INotificationBus current)
    {
        try { await current.ConnectAsync(OnActionInvoked, OnClosed).ConfigureAwait(false); }
        catch (Exception error) { Fail(error); }
    }
    public void Show(MessageNotification message) => _ = ShowAsync(message);
    internal async Task ShowAsync(MessageNotification message)
    {
        var current = bus;
        if (current is null) return;
        try
        {
            await connecting.ConfigureAwait(false);
            var hints = new Dictionary<string, string> { ["desktop-entry"] = "bellteam" };
            var id = await current.NotifyAsync(new NotifyCall("BellTeam", 0, "", message.Title, message.Body, [DefaultAction, "開く"], hints, -1)).ConfigureAwait(false);
            lock (gate) visible[id] = message;
        }
        catch (Exception error) { Fail(error); }
    }
    private void OnActionInvoked(uint id, string action)
    {
        if (action != DefaultAction) return;
        MessageNotification? message; lock (gate) { visible.TryGetValue(id, out message); visible.Remove(id); }
        if (message is not null) activated?.Invoke(message.Server, message.Target);
    }
    private void OnClosed(uint id, uint reason) { lock (gate) visible.Remove(id); }
    private void Fail(Exception error) => failed?.Invoke("デスクトップ通知を表示できませんでした。" + error.Message);
    public async Task StopAsync()
    {
        activated = null; failed = null;
        var current = bus; bus = null;
        if (current is null) return;
        uint[] displayed; lock (gate) { displayed = visible.Keys.ToArray(); visible.Clear(); }
        try
        {
            await connecting.ConfigureAwait(false);
            foreach (var id in displayed) await current.CloseAsync(id).ConfigureAwait(false);
        }
        finally { current.Dispose(); }
    }
}

// The real bus: org.freedesktop.Notifications on the session bus, through Tmds.DBus.Protocol (the package Avalonia already uses).
internal sealed class DBusNotificationBus : INotificationBus
{
    private const string Service = "org.freedesktop.Notifications", Path = "/org/freedesktop/Notifications";
    private DBusConnection? connection;
    private readonly List<IDisposable> watches = [];
    public async Task ConnectAsync(Action<uint, string> actionInvoked, Action<uint, uint> closed)
    {
        var address = DBusAddress.Session ?? throw new InvalidOperationException("D-Busのセッションバスが見つかりません。");
        var created = new DBusConnection(address);
        await created.ConnectAsync().ConfigureAwait(false);
        connection = created;
        // Handlers run on the connection's thread (emitOnCapturedContext false); the app posts to the UI itself.
        watches.Add(await created.WatchSignalAsync<(uint Id, string Action)>(Service, Path, Service, "ActionInvoked", (message, _) => { var reader = message.GetBodyReader(); return (reader.ReadUInt32(), reader.ReadString()); },
            notification => { if (notification.HasValue) actionInvoked(notification.Value.Id, notification.Value.Action); }, ObserverFlags.None, false, null).ConfigureAwait(false));
        watches.Add(await created.WatchSignalAsync<(uint Id, uint Reason)>(Service, Path, Service, "NotificationClosed", (message, _) => { var reader = message.GetBodyReader(); return (reader.ReadUInt32(), reader.ReadUInt32()); },
            notification => { if (notification.HasValue) closed(notification.Value.Id, notification.Value.Reason); }, ObserverFlags.None, false, null).ConfigureAwait(false));
    }
    public Task<uint> NotifyAsync(NotifyCall call)
    {
        var current = connection ?? throw new InvalidOperationException("D-Busに接続していません。");
        using var writer = current.GetMessageWriter();
        writer.WriteMethodCallHeader(Service, Path, Service, "Notify", "susssasa{sv}i");
        writer.WriteString(call.AppName); writer.WriteUInt32(call.ReplacesId); writer.WriteString(call.Icon); writer.WriteString(call.Summary); writer.WriteString(call.Body);
        writer.WriteArray(call.Actions);
        writer.WriteDictionary(call.Hints.ToDictionary(item => item.Key, item => (VariantValue)item.Value));
        writer.WriteInt32(call.ExpireTimeout);
        return current.CallMethodAsync(writer.CreateMessage(), (message, _) => message.GetBodyReader().ReadUInt32(), null);
    }
    public Task CloseAsync(uint id)
    {
        var current = connection ?? throw new InvalidOperationException("D-Busに接続していません。");
        using var writer = current.GetMessageWriter();
        writer.WriteMethodCallHeader(Service, Path, Service, "CloseNotification", "u");
        writer.WriteUInt32(id);
        return current.CallMethodAsync(writer.CreateMessage());
    }
    public void Dispose() { foreach (var watch in watches) watch.Dispose(); watches.Clear(); connection?.Dispose(); connection = null; }
}

// The platform-neutral half of windows/BellTeam.App/DesktopNotifications.cs: default off, only while the app runs, and a sink failure turns it off with the reason shown.
public sealed class DesktopNotifications(INotificationSink sink, SettingsStore settings, Action<string, ChatTarget?> activated) : INotifyPropertyChanged, IAsyncDisposable, INotificationSwitch
{
    Task INotificationSwitch.SetEnabledAsync(bool enabled) => SetEnabledAsync(enabled);
    public bool Enabled { get; private set; }
    public string? Error { get; private set; }
    public string Status => Error ?? (Enabled ? "アプリが起きている間だけ通知します。" : "通知はオフです。");
    public event PropertyChangedEventHandler? PropertyChanged;
    private readonly SemaphoreSlim changing = new(1);
    private readonly SemaphoreSlim updateChanging = new(1);
    private void Changed([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
    public Task InitializeAsync() => SetEnabledAsync(settings.Load().NotificationsEnabled, persist: false);
    public async Task SetEnabledAsync(bool enabled, bool persist = true)
    {
        await changing.WaitAsync();
        try
        {
            if (enabled == Enabled) return;
            if (enabled) sink.Start(activated, error => _ = HandleFailureAsync(error)); else await sink.StopAsync();
            if (persist) settings.Save(settings.Load() with { NotificationsEnabled = enabled });
            Enabled = enabled; Error = null;
        }
        catch (Exception error)
        {
            Enabled = false; Error = "通知の設定を変更できませんでした。" + error.Message;
            try { await sink.StopAsync(); } catch (Exception cleanup) { Error += "\n通知の終了処理も完了できませんでした。" + cleanup.Message; }
        }
        finally { Changed(nameof(Enabled)); Changed(nameof(Error)); Changed(nameof(Status)); changing.Release(); }
    }
    public async Task NotifyAsync(MessageNotification message)
    {
        await changing.WaitAsync();
        try
        {
            if (!Enabled) return;
            sink.Show(message);
        }
        catch (Exception error)
        {
            Enabled = false; Error = "通知を停止しました。" + error.Message;
            try { await sink.StopAsync(); } catch (Exception cleanup) { Error += "\n通知の終了処理も完了できませんでした。" + cleanup.Message; }
            Changed(nameof(Enabled)); Changed(nameof(Error)); Changed(nameof(Status));
        }
        finally { changing.Release(); }
    }
    public async Task NotifyUpdatesAsync(string server, UpdateCandidate[]? candidates)
    {
        if (candidates is null || !Enabled) return;
        if (candidates.Length > 9 || candidates.Any(item => item is null || item.ComponentId is not ("container" or "web-gateway" or "notifications" or "members" or "conversation" or "execution" or "usage" or "memory" or "diagnostics") || item.Id is null || item.Id.Length != 64 || item.Id.Any(ch => ch is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))) || candidates.Select(item => item.ComponentId).Distinct().Count() != candidates.Length) throw new BellApiException("更新通知の候補を確認できません。");
        await updateChanging.WaitAsync();
        try
        {
            foreach (var candidate in candidates)
            {
                if (!Enabled) break;
                var saved = settings.Load();
                if (saved.UpdateNotifications.Any(item => item.Server == server && item.ComponentId == candidate.ComponentId && item.Id == candidate.Id)) continue;
                settings.Save(saved with { UpdateNotifications = saved.UpdateNotifications.Where(item => item.Server != server || item.ComponentId != candidate.ComponentId).Append(new(server, candidate.ComponentId, candidate.Id)).ToArray() });
                await NotifyAsync(new(server, null, "BellTeam", "更新があります。Updateで確認してください。", "update", candidate.Id));
            }
        }
        finally { updateChanging.Release(); }
    }
    private async Task HandleFailureAsync(string error)
    {
        await changing.WaitAsync();
        try { Enabled = false; Error = "通知を停止しました。" + error; try { await sink.StopAsync(); } catch (Exception cleanup) { Error += "\n通知の終了処理も完了できませんでした。" + cleanup.Message; } Changed(nameof(Enabled)); Changed(nameof(Error)); Changed(nameof(Status)); }
        finally { changing.Release(); }
    }
    public async ValueTask DisposeAsync() { await changing.WaitAsync(); try { Enabled = false; await sink.StopAsync(); } finally { changing.Release(); } }
}
