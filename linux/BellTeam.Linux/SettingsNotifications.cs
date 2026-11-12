using System.ComponentModel;
using BellTeam.Core;

namespace BellTeam.Linux;

// What the 通知 settings page needs from the notification delivery (the Windows DesktopNotifications shape). The delivery port implements it.
public interface INotificationSwitch : INotifyPropertyChanged
{
    bool Enabled { get; }
    string? Error { get; }
    string Status { get; }
    Task SetEnabledAsync(bool enabled);
}

// The page's switch before any delivery exists: it reads and writes SettingsStore.NotificationsEnabled, the value the delivery starts from.
public sealed class StoredNotificationSwitch(SettingsStore store) : INotificationSwitch
{
    public event PropertyChangedEventHandler? PropertyChanged;
    public bool Enabled { get; private set; } = store.Load().NotificationsEnabled;
    public string? Error { get; private set; }
    public string Status => Error ?? (Enabled ? "アプリが起きている間だけ通知します。" : "通知はオフです。");
    public Task SetEnabledAsync(bool enabled)
    {
        try { store.Save(store.Load() with { NotificationsEnabled = enabled }); Enabled = enabled; Error = null; }
        catch (Exception error) { Error = "通知の設定を変更できませんでした。" + error.Message; }
        foreach (var name in new[] { nameof(Enabled), nameof(Error), nameof(Status) }) PropertyChanged?.Invoke(this, new(name));
        return Task.CompletedTask;
    }
}
