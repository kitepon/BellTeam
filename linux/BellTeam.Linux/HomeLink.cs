using BellTeam.Core;

namespace BellTeam.Linux;

// a492 (login-billing 0.16.0 HomeConnection, home wire v1): an app logs in to the user's own home server with its pass. Linux and Android share this file; each platform's adapter (LinuxHomeLink, AndroidHomeLink)
// maps its library's types onto IHomeLink, because the two parts have the same API in different namespaces. The token stays inside the library's record; nothing here prints or stores it.
public sealed class HomeLinkException(string code, int status) : Exception(code)
{
    public string Code { get; } = code;
    public int Status { get; } = status;
}

public interface IHomeLink
{
    // The first binding passes the setup code; a later login passes none (the pass proves the owner). The audience is the origin of baseUrl.
    Task ConnectAsync(string baseUrl, string kind, string? setupCode, CancellationToken token);
    // The Bearer token for a URL of the home server's own origin, else null.
    string? Token(string url);
    // The sign-out at the home server (the library's own signOut does not end it).
    Task EndAsync(CancellationToken token);
    Task ReproveIfDueAsync(string? ticketFor, CancellationToken token);
    // Drops the kept record when it belongs to that URL's origin: only after a definite 401.
    void Forget(string url);
}

// GET /api/home/session: capability "login-billing-home/1", bound (an account owns it), enforced.
public sealed record HomeProbe { public string? Capability { get; init; } public bool Bound { get; init; } public bool Enforced { get; init; } }

public static class HomeGate
{
    public const string Capability = "login-billing-home/1";

    // null = not a home server, or it could not be read: the normal connect goes on and says what is wrong (unreachable, old server).
    public static async Task<HomeProbe?> ProbeAsync(Uri origin, CancellationToken token)
    {
        try
        {
            using var api = new BellApi(origin);
            var probe = await api.GetAsync<HomeProbe>("/api/home/session", token);
            return probe.Capability == Capability ? probe : null;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception) { return null; }
    }

    // The probe when this app must log in first (a home server and no kept token); otherwise null. With a kept token a due reprove runs here; a failed one is not fatal: only a 401 ends the session, and the library has dropped the record then.
    public static async Task<HomeProbe?> MustBindAsync(IHomeLink home, Uri origin, CancellationToken token)
    {
        if (await ProbeAsync(origin, token) is not { } probe) return null;
        if (home.Token(origin.AbsoluteUri) is null) return probe;
        try { await home.ReproveIfDueAsync(null, token); }
        catch (HomeLinkException) { }
        return null;
    }
}

// The app's session tokens: the home server's one (from the library's record) first, the older per-server file or Keystore entry for servers that still use app sessions.
public sealed class CompositeSessionTokenStore(IHomeLink home, ISessionTokenStore older) : ISessionTokenStore
{
    public string? Load(Uri origin) => home.Token(origin.AbsoluteUri) ?? older.Load(origin);
    public void Save(Uri origin, string token) => older.Save(origin, token);   // the library keeps the home token itself
    public void Clear(Uri origin) { home.Forget(origin.AbsoluteUri); older.Clear(origin); }
}
