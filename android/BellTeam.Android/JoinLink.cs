using Android.Content;

namespace BellTeam.Android;

// login-billing 1.49 (11.12): the QR is https://login-billing.kitepon.dev/join/dev.kitepon.bellbot#<lbq4>, so the phone's own camera opens this app (App Link, autoVerify). The link goes untouched to the library's answer,
// which takes the link and the bare QR text alike; the lbq4 text is in the fragment and never reaches a server. A link is kept for two minutes for the page that answers it.
public static class JoinLink
{
    private const string Host = "login-billing.kitepon.dev", Prefix = "/join/dev.kitepon.bellbot";
    private static string? pending;
    private static DateTime at;
    public static event Action? Changed;
    public static bool HasPending => pending is not null && DateTime.UtcNow - at < TimeSpan.FromMinutes(2);

    // MainActivity hands every launch/new intent here.
    public static void Accept(Intent? intent)
    {
        if (intent?.Data is not { } data || data.Scheme != "https" || data.Host != Host || data.Path?.StartsWith(Prefix, StringComparison.Ordinal) != true) return;
        pending = intent.DataString; at = DateTime.UtcNow; Changed?.Invoke();
    }
    public static string? Take() { var link = HasPending ? pending : null; pending = null; return link; }
}
