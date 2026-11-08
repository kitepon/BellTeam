using System.Runtime.InteropServices;
using BellTeam.Core;
using Windows.Networking.PushNotifications;

namespace BellTeam.App;

public static class PackageIdentity
{
    // 15700 = APPMODEL_ERROR_NO_PACKAGE: the installer build, which has no package identity and no WNS channel.
    public static bool IsPackaged { get; } = Probe();
    private static bool Probe() { var length = 0; return GetCurrentPackageFullName(ref length, IntPtr.Zero) != 15700; }
    [DllImport("kernel32.dll")] private static extern int GetCurrentPackageFullName(ref int length, IntPtr name);
}

public sealed record PushChannelInfo(string Uri, DateTimeOffset ExpiresAt);
public interface IPushChannelSource { Task<PushChannelInfo> OpenAsync(); void Close(); }

public sealed class WnsChannelSource : IPushChannelSource
{
    private PushNotificationChannel? channel;
    public async Task<PushChannelInfo> OpenAsync()
    {
        var next = await PushNotificationChannelManager.CreatePushNotificationChannelForApplicationAsync();
        if (!ReferenceEquals(next, channel)) { if (channel is not null) channel.PushNotificationReceived -= Suppress; next.PushNotificationReceived += Suppress; channel = next; }
        return new(next.Uri, next.ExpirationTime);
    }
    // While the app runs, the existing SSE path already shows the toast; WNS toasts are for the closed app only.
    private static void Suppress(PushNotificationChannel sender, PushNotificationReceivedEventArgs args) { if (args.NotificationType == PushNotificationType.Toast) args.Cancel = true; }
    public void Close() { if (channel is null) return; channel.PushNotificationReceived -= Suppress; channel.Close(); channel = null; }
}

// Registers this PC's WNS channel with the connected box so update notifications reach the closed Store app.
public sealed class ClosedAppPush(IPushChannelSource source, SettingsStore settings)
{
    private readonly SemaphoreSlim gate = new(1);
    public async Task SyncAsync(BellApi api, string server, bool enabled, CancellationToken token = default)
    {
        await gate.WaitAsync(token);
        try
        {
            var saved = settings.Load().PushChannel;
            if (!enabled)
            {
                source.Close();
                if (saved is null) return;
                if (saved.Server == server) await new WindowsPushApi(api).UnregisterAsync(saved.ChannelUri, token);
                settings.Save(settings.Load() with { PushChannel = null });
                return;
            }
            var channel = await source.OpenAsync();
            // A refreshed expiry on the same URI is re-registered too, so the box never drops a live channel as expired.
            if (saved == new PushChannelRegistration(server, channel.Uri, channel.ExpiresAt)) return;
            await new WindowsPushApi(api).RegisterAsync(server, channel.Uri, channel.ExpiresAt, saved?.Server == server && saved.ChannelUri != channel.Uri ? saved.ChannelUri : null, token);
            settings.Save(settings.Load() with { PushChannel = new(server, channel.Uri, channel.ExpiresAt) });
        }
        finally { gate.Release(); }
    }
}
