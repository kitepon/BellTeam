using System.Text.Json.Serialization;
using System.Web;

namespace BellTeam.Core;

public sealed record PushChannelRegistration(string Server, string ChannelUri, DateTimeOffset ExpiresAt);
public sealed record WindowsPushRegistered(bool Registered);

// Contract owned by Mika (usage): /api/notifications/windows/{devices,unregister}.
public sealed class WindowsPushApi(BellApi api)
{
    public async Task RegisterAsync(string server, string channelUri, DateTimeOffset expiresAt, string? previousChannelUri, CancellationToken token = default)
    {
        var result = await api.PostAsync<WindowsPushRegistered>("/api/notifications/windows/devices", new DeviceBody(channelUri, expiresAt.ToString("O"), Origin(server), previousChannelUri), token);
        if (!result.Registered) throw new BellApiException("このPCの終了中の通知を登録できませんでした。");
    }
    public async Task UnregisterAsync(string channelUri, CancellationToken token = default)
    {
        var result = await api.PostAsync<WindowsPushRegistered>("/api/notifications/windows/unregister", new { channelUri }, token);
        if (result.Registered) throw new BellApiException("このPCの終了中の通知を解除できませんでした。");
    }
    // The server canonicalizes with URL.origin, which has no trailing slash.
    public static string Origin(string server) => ServerOrigin.Parse(server).GetLeftPart(UriPartial.Authority);
    private sealed record DeviceBody(string ChannelUri, string ExpiresAt, string Server, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? PreviousChannelUri);
}

// Toast tap target from Mika's fixed WNS XML: bellteam-update:?server=<percent-encoded origin>.
public static class UpdateLaunch
{
    public const string Scheme = "bellteam-update";
    public static bool IsLaunch(string argument) => argument.StartsWith(Scheme + ":", StringComparison.OrdinalIgnoreCase);
    // Returns the normalized server (ServerOrigin AbsoluteUri) or null when the URI is not a valid update launch.
    public static string? Server(string argument)
    {
        if (!IsLaunch(argument)) return null;
        var query = argument[(Scheme.Length + 1)..];
        if (!query.StartsWith('?')) return null;
        var values = HttpUtility.ParseQueryString(query[1..]);
        if (values.Count != 1 || values.GetValues("server") is not [var server]) return null;
        try { return ServerOrigin.Parse(server).AbsoluteUri; } catch (ArgumentException) { return null; }
    }
}
