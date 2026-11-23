using System.Net.Http;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.App;

/// <summary>
/// The SECOND, foreign login-library instance (Mint, contract 1.24): base https://approval-box.kitepon.dev/auth/v1, its own pass store, web sign-in only, no purchase, no receipt.
/// Nothing of the BellTeam sign-in (AccountStore) is shared: not the store, not the K. This instance hands its pass out for the Approval Box origin only (the library's own rule).
/// </summary>
internal sealed class ApprovalBoxAccount
{
    internal const string ProductOrigin = "https://approval-box.kitepon.dev", StoreName = "BellTeam-ApprovalBox";
    private readonly DesktopLoginBilling billing; private readonly IPassStore store; private readonly Uri origin;

    /// <param name="origin">Development runs point it at approval-box's local dev server (BELLTEAM_APPROVAL_BOX_URL), like BELLTEAM_LOGIN_BILLING_URL does for BellTeam's own sign-in.</param>
    internal ApprovalBoxAccount(string? origin = null, IPassStore? store = null, HttpMessageHandler? handler = null)
    {
        this.origin = new Uri((origin ?? Environment.GetEnvironmentVariable("BELLTEAM_APPROVAL_BOX_URL") ?? ProductOrigin).TrimEnd('/'));
        this.store = store ?? FilePassStore.ForApp(StoreName);
        billing = new DesktopLoginBilling(new Uri(this.origin, "/auth/v1").ToString(), this.store, handler);
    }

    internal Uri Origin => origin;
    /// <summary>The library's own handler for every request to the package's client: it attaches the pass as Authorization: Bearer for the Approval Box origin only and keeps a renewed pass (never logged).</summary>
    internal HttpMessageHandler Transport(HttpMessageHandler? inner = null) => billing.CreateHttpHandler(inner ?? new HttpClientHandler());
    /// <summary>The Authorization header value the package asks for (PassProvider), null when not signed in: it then says SignedOut and sends nothing.</summary>
    internal string? PassHeader() { try { return SignedIn ? billing.PassHeader(origin.GetLeftPart(UriPartial.Authority)) : null; } catch (LoginBillingException) { return null; } }
    /// <summary>The handoff sign-in (library 1.20): this PC shows a QR the Approval Box app on a signed-in phone reads and approves; the pass comes back to this PC. Works for an Apple account too (no Apple sign-in on Windows).</summary>
    internal Task<LoginStart?> StartHandoffAsync(string label, CancellationToken ct) => billing.StartLoginAsync(label, ct);
    internal Task WaitForHandoffAsync(CancellationToken ct) => billing.WaitForPassAsync(ct);
    /// <summary>The pass was refused or ended (a 401): it is dropped and the sign-in screen opens.</summary>
    internal void DropPass() => store.Delete();
    internal bool SignedIn { get { try { return billing.PassKind != PassKind.None; } catch (LoginBillingException) { return false; } } }

    /// <summary>The system browser opens Approval Box's web sign-in and the loopback return brings the pass back (Windows, Nayuta/Delta).</summary>
    // open = null: the system browser. A test passes its own opener (approval-box's dev server answers the browser's part itself).
    internal Task SignInAsync(string provider, CancellationToken ct, Func<Uri, Task>? open = null) => billing.SignInWebAsync(provider, open ?? TestBrowser.Open, false, ct);
    internal Task SignOutAsync(CancellationToken ct) => billing.SignOutAsync(ct);
    // The account was deleted (4410): the pass of this instance goes too.
    internal void ClearPass() => store.Delete();

}
