using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using BellTeam.Core;
using Windows.UI.Notifications;

namespace BellTeam.App;

public interface INotificationSink
{
    void Start(Action<string, ChatTarget> activated, Action<string> failed);
    void Show(MessageNotification message);
    Task StopAsync();
}
public sealed class WindowsNotificationSink(string appId = DesktopShortcut.AppId, bool suppressPopup = false) : INotificationSink
{
    private ToastNotifier? notifier;
    private Action<string, ChatTarget>? activated;
    private Action<string>? failed;
    private readonly object gate = new();
    private readonly Dictionary<ToastNotification, MessageNotification> visible = [];
    public void Start(Action<string, ChatTarget> activated, Action<string> failed)
    {
        Marshal.ThrowExceptionForHR(DesktopShortcut.SetCurrentProcessExplicitAppUserModelID(appId));
        this.activated = activated; this.failed = failed;
        notifier = ToastNotificationManager.CreateToastNotifier(appId);
    }
    public void Show(MessageNotification message)
    {
        var xml = ToastNotificationManager.GetTemplateContent(ToastTemplateType.ToastText02);
        var lines = xml.GetElementsByTagName("text"); lines[0].AppendChild(xml.CreateTextNode(message.Title)); lines[1].AppendChild(xml.CreateTextNode(message.Body));
        if (suppressPopup) { var audio = xml.CreateElement("audio"); audio.SetAttribute("silent", "true"); xml.DocumentElement.AppendChild(audio); }
        var toast = new ToastNotification(xml) { SuppressPopup = suppressPopup }; toast.Activated += OnActivated; toast.Dismissed += OnDismissed; toast.Failed += OnFailed;
        lock (gate) visible.Add(toast, message);
        notifier!.Show(toast);
    }
    private void OnActivated(ToastNotification toast, object args)
    {
        MessageNotification? message; lock (gate) visible.TryGetValue(toast, out message);
        if (message is not null) activated?.Invoke(message.Server, message.Target);
        Release(toast);
    }
    private void OnDismissed(ToastNotification toast, ToastDismissedEventArgs args) => Release(toast);
    private void OnFailed(ToastNotification toast, ToastFailedEventArgs args) { Release(toast); failed?.Invoke("Windows通知を表示できませんでした。" + args.ErrorCode.Message); }
    private void Release(ToastNotification toast)
    {
        lock (gate) visible.Remove(toast);
        toast.Activated -= OnActivated; toast.Dismissed -= OnDismissed; toast.Failed -= OnFailed;
    }
    public Task StopAsync()
    {
        activated = null; failed = null;
        var current = notifier; notifier = null;
        if (current is null) return Task.CompletedTask;
        ToastNotification[] displayed; lock (gate) displayed = visible.Keys.ToArray();
        foreach (var toast in displayed) { Release(toast); current.Hide(toast); }
        ToastNotificationManager.History.Clear(appId);
        return Task.CompletedTask;
    }
}
public sealed class DesktopNotifications(INotificationSink sink, SettingsStore settings, Action<string, ChatTarget> activated) : INotifyPropertyChanged, IAsyncDisposable
{
    public bool Enabled { get; private set; }
    public string? Error { get; private set; }
    public string Status => Error ?? (Enabled ? "アプリが起きている間だけ通知します。" : "通知はオフです。");
    public event PropertyChangedEventHandler? PropertyChanged;
    private readonly SemaphoreSlim changing = new(1);
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
    private async Task HandleFailureAsync(string error)
    {
        await changing.WaitAsync();
        try { Enabled = false; Error = "通知を停止しました。" + error; try { await sink.StopAsync(); } catch (Exception cleanup) { Error += "\n通知の終了処理も完了できませんでした。" + cleanup.Message; } Changed(nameof(Enabled)); Changed(nameof(Error)); Changed(nameof(Status)); }
        finally { changing.Release(); }
    }
    public async ValueTask DisposeAsync() { await changing.WaitAsync(); try { Enabled = false; await sink.StopAsync(); } finally { changing.Release(); } }
}
