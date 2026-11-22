using Android.App;
using Android.Content;
using Android.Gms.Extensions;
using Android.OS;
using Android.Runtime;
using Android.Util;
using BellTeam.Core;
using Firebase;
using Firebase.Messaging;
using BellTeam.Linux;
using BellTeam.Android;

[assembly: UsesPermission(Android.Manifest.Permission.PostNotifications)]

namespace BellTeam.Android;

// Closed-app notifications through FCM (docs/architecture/modules/usage/fcm-push.md, Mika a378): the system shows title and body while the app is closed, a tap starts MainActivity with the
// message data as extras (PushRouter routes it), and while the app is open BellPushService shows the banner itself unless it is for the conversation being viewed.
public static class PushChannel
{
    public const string Id = "bellteam_messages";
    public static void Ensure(Context context)
    {
        if (Build.VERSION.SdkInt < BuildVersionCodes.O) return;
        var channel = new NotificationChannel(Id, "メッセージ", NotificationImportance.High) { Description = "メンバーの返信・秘密情報の入力・選んでほしいこと" };
        ((NotificationManager?)context.GetSystemService(Context.NotificationService))?.CreateNotificationChannel(channel);
    }
}

// What a tap or a foreground message names; the data keys are the contract's (all strings, a missing key is null).
public sealed record PushTarget(string? Server, string Kind, string? BotId, string? RoomId, string? RequestId)
{
    public static PushTarget? From(Func<string, string?> read) => read("kind") is { Length: > 0 } kind ? new(read("server"), kind, read("botId"), read("roomId"), read("requestId")) : null;
    // The conversation it belongs to: the room when there is one, else the member.
    public ChatTarget? Conversation => RoomId is { Length: > 0 } room ? new(room, true) : BotId is { Length: > 0 } bot ? new(bot, false) : null;
}

public static class PushRouter
{
    public static readonly string[] Keys = ["server", "kind", "messageId", "botId", "senderId", "senderName", "roomId", "roomName", "requestId"];
    private static PushTarget? pending;
    public static event Action? Changed;
    public static bool Foreground { get; set; }
    // The conversation on screen (null on any other page); the shell keeps it current.
    public static ChatTarget? Viewing { get; set; }
    public static string? CurrentServer { get; set; }

    // MainActivity hands every launch/new intent here; only a notification tap carries the contract's data.
    public static void Accept(Intent? intent)
    {
        if (intent?.Extras is not { } extras) return;
        var target = PushTarget.From(key => extras.GetString(key));
        if (target is null) return;
        pending = target; Changed?.Invoke();
    }
    public static PushTarget? Take() { var target = pending; pending = null; return target; }

    // A message of another server never routes or shows (the contract: ignore a message whose server is not the current connection).
    public static bool IsCurrentServer(string? server) => server is null || CurrentServer is null || Same(server, CurrentServer);
    public static string Origin(string server) => new Uri(server).GetLeftPart(UriPartial.Authority);
    private static bool Same(string a, string b) => string.Equals(a.TrimEnd('/'), b.TrimEnd('/'), StringComparison.OrdinalIgnoreCase);
}

// Registers this device's FCM token with the connected server and takes it back on logout / a changed server. Not configured (no google-services.json, or the server has no key) is a quiet state: nothing is expected.
public static class PushRegistration
{
    private const string Prefs = "bellteam_push", TokenKey = "token";
    public static Func<LinuxWorkspace?>? Workspace { get; set; }
    public static bool Configured => FirebaseApp.GetApps(MainActivity.Current).Count > 0;

    public static async Task RegisterAsync(LinuxWorkspace workspace)
    {
        if (!Configured || !workspace.Connected) return;
        try
        {
            var token = (await FirebaseMessaging.Instance.GetToken().AsAsync<Java.Lang.String>())?.ToString();
            if (token is null) return;
            await PostAsync(workspace, token);
        }
        catch (Exception error) { Log.Warn("BellPush", "registration failed: " + error.Message); }
    }

    // onNewToken: the new token replaces the old one on the server that is connected now; with no connection the next start registers it.
    public static async Task OnNewTokenAsync(string token)
    {
        if (Workspace?.Invoke() is { Connected: true } workspace) try { await PostAsync(workspace, token); } catch (Exception error) { Log.Warn("BellPush", "registration of a new token failed: " + error.Message); }
        // a492: a home server finds this session's push ticket by this value (a hash: the token itself is longer than the library's 64 bytes); a changed value proves again.
        if (AccountStore.Home is { } home)
            try { await home.ReproveIfDueAsync(System.Buffers.Text.Base64Url.EncodeToString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token))), default); }
            catch (HomeLinkException error) { Log.Warn("BellPush", "home reprove failed: " + error.Code); }
    }

    private static async Task PostAsync(LinuxWorkspace workspace, string token)
    {
        var prefs = MainActivity.Current.GetSharedPreferences(Prefs, FileCreationMode.Private)!;
        var previous = prefs.GetString(TokenKey, null);
        var body = new Dictionary<string, object?> { ["token"] = token, ["server"] = PushRouter.Origin(workspace.Server) };
        if (previous is { Length: > 0 } && previous != token) body["previousToken"] = previous;
        try { await workspace.Management.Api.PostAsync<Dictionary<string, object?>>("/api/notifications/android/devices", body, workspace.ConnectionToken); }
        // 503 PUSH_NOT_CONFIGURED: this server has no Firebase key yet (expected until a379); 400 PUSH_DEVICE_INVALID: the server refused the token. Neither is retried here; the next start asks again.
        catch (BellApiException error) when (error.Status is System.Net.HttpStatusCode.ServiceUnavailable or System.Net.HttpStatusCode.BadRequest) { Log.Warn("BellPush", $"server answered {error.Code}"); return; }
        prefs.Edit()!.PutString(TokenKey, token)!.Apply();
    }

    // Before logout or a changed server, on the connection that is still open; a server that cannot be reached does not hold the sign-out back.
    // Returns null when nothing is left registered, else why the server still holds the token (the account deletion lists it; the other callers go on).
    public static async Task<string?> UnregisterAsync(LinuxWorkspace workspace)
    {
        var prefs = MainActivity.Current.GetSharedPreferences(Prefs, FileCreationMode.Private)!;
        var token = prefs.GetString(TokenKey, null);
        if (token is null || !workspace.Connected) return null;   // shortcut: a server that is not connected cannot be told; revisit if the server expires push tokens itself
        try
        {
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(workspace.ConnectionToken); limit.CancelAfter(TimeSpan.FromSeconds(3));
            await workspace.Management.Api.PostAsync<Dictionary<string, object?>>("/api/notifications/android/unregister", new { token }, limit.Token);
            prefs.Edit()!.Remove(TokenKey)!.Apply();
            return null;
        }
        catch (Exception error) { Log.Warn("BellPush", "unregister failed: " + error.Message); return error.Message; }
    }
}

[Service(Exported = false)]
[IntentFilter(["com.google.firebase.MESSAGING_EVENT"])]
public sealed class BellPushService : FirebaseMessagingService
{
    public override void OnNewToken(string token) { base.OnNewToken(token); _ = PushRegistration.OnNewTokenAsync(token); }

    // Runs only while the app is open (the system shows the message itself when it is closed).
    public override void OnMessageReceived(RemoteMessage message)
    {
        base.OnMessageReceived(message);
        var data = message.Data;
        var target = PushTarget.From(key => data.TryGetValue(key, out var value) ? value : null);
        if (target is null || !PushRouter.IsCurrentServer(target.Server)) return;
        if (PushRouter.Foreground && target.Conversation is { } conversation && conversation == PushRouter.Viewing) return;
        var title = message.GetNotification()?.Title; var text = message.GetNotification()?.Body;
        var open = new Intent(this, typeof(MainActivity)).SetFlags(ActivityFlags.SingleTop | ActivityFlags.ClearTop);
        foreach (var key in PushRouter.Keys) if (data.TryGetValue(key, out var value)) open.PutExtra(key, value);
        var tap = PendingIntent.GetActivity(this, 0, open, PendingIntentFlags.UpdateCurrent | PendingIntentFlags.Immutable);
        var notification = new Notification.Builder(this, PushChannel.Id).SetContentTitle(title).SetContentText(text).SetSmallIcon(Resource.Drawable.ic_stat_bell).SetAutoCancel(true).SetContentIntent(tap).Build();
        var tag = data.TryGetValue("messageId", out var id) ? id : null;
        ((NotificationManager?)GetSystemService(NotificationService))?.Notify(tag, 1, notification);
    }
}
