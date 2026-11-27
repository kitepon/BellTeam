using Android.Content;
using Kitepon.LoginBilling;
using LbLocalForm = Kitepon.LoginBilling.LocalForm;   // BellTeam.Core also has a LocalForm

namespace BellTeam.Android;

// login-billing 1.49 (11.12): the QR is https://login-billing.kitepon.dev/join/dev.kitepon.bellbot#<lbq4>, so the phone's own camera opens this app (App Link, autoVerify). The link goes untouched to the library's answer,
// which takes the link and the bare QR text alike; the lbq4 text is in the fragment and never reaches a server. A link is kept for two minutes for the page that answers it.
// 1.53 (11.12): the app does not match the link's host or path itself; the library's IsLibraryQR says whether a text is its own (the manifest's App Link filter decides only which links reach this app).
public static class JoinLink
{
    private static string? pending;
    private static DateTime at;
    public static event Action? Changed;
    public static bool HasPending => pending is not null && DateTime.UtcNow - at < TimeSpan.FromMinutes(2);

    // MainActivity hands every launch/new intent here.
    public static void Accept(Intent? intent)
    {
        if (intent?.Action != Intent.ActionView || intent.DataString is not { } link || !LbLocalForm.IsLibraryQR(link)) return;
        _ = RouteAsync(link);
    }
    // 1.60: a return link (lbr1) answers a request THIS phone made. A wanting form lists a taker here while its request is open; the link goes to them first and only an untaken link waits for the approve panel.
    public static readonly List<Func<string, Task<bool>>> Takers = [];
    public static Func<string, Task<bool>> Taker(Func<string, Task> take) => async link =>
    {
        try { await take(link); return true; }
        catch (LoginBillingException error) when (error.Code is "qr_invalid" or "request_gone") { return false; }   // not a return link of this request: the next taker, then the approve panel
        catch (LoginBillingException) { return true; }   // it was this request's return link and failed; the request's own wait ends with the same refusal
    };
    private static async Task RouteAsync(string link)
    {
        foreach (var taker in Takers.ToArray()) if (await taker(link)) return;
        pending = link; at = DateTime.UtcNow; Changed?.Invoke();
    }
    public static string? Take() { var link = HasPending ? pending : null; pending = null; return link; }
}
