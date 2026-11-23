using BellTeam.Core;
using BellTeam.PeerChannel;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Linux;

/// <summary>
/// The SECOND, foreign login-library instance (Mint, contract 1.24): base https://approval-box.kitepon.dev/auth/v1, its own pass store, web sign-in only, no purchase, no receipt.
/// Nothing of the BellTeam sign-in (AccountStore) is shared: not the store, not the K. This instance hands its pass out for the Approval Box origin only (the library's own rule).
/// </summary>
// The PC's device part with the PC's account (this file is not linked into the Android app, which passes its own account).
internal sealed partial class LinuxApprovalBoxDevice { public LinuxApprovalBoxDevice(string directory, Func<IReadOnlyList<(string Id, string Name)>> roster) : this(directory, new LinuxApprovalBoxAccount(), roster, LinuxHasEngine) { } }

internal sealed class LinuxApprovalBoxAccount : IApprovalBoxAccount
{
    internal const string ProductOrigin = "https://approval-box.kitepon.dev", StoreName = "BellTeam-ApprovalBox";
    private readonly DesktopLoginBilling billing; private readonly IPassStore store; private readonly Uri origin;

    /// <param name="origin">Development runs point it at approval-box's local dev server (BELLTEAM_APPROVAL_BOX_URL), like BELLTEAM_LOGIN_BILLING_URL does for BellTeam's own sign-in.</param>
    internal LinuxApprovalBoxAccount(string? origin = null, IPassStore? store = null, HttpMessageHandler? handler = null)
    {
        this.origin = new Uri((origin ?? Environment.GetEnvironmentVariable("BELLTEAM_APPROVAL_BOX_URL") ?? ProductOrigin).TrimEnd('/'));
        this.store = store ?? FilePassStore.ForApp(StoreName);
        billing = new DesktopLoginBilling(new Uri(this.origin, "/auth/v1").ToString(), this.store, handler);
    }

    public Uri Origin => origin;
    internal bool SignedIn { get { try { return billing.PassKind != PassKind.None; } catch (LoginBillingException) { return false; } } }

    /// <summary>The system browser opens Approval Box's web sign-in and the loopback return brings the pass back (Windows and Linux, Nayuta/Delta).</summary>
    // open = null: the library's own opener (xdg-open on Linux). A test passes its own opener (approval-box's dev server answers the browser's part itself).
    internal Task SignInAsync(string provider, CancellationToken ct, Func<Uri, Task>? open = null) => billing.SignInWebAsync(provider, open, false, ct);
    public Task SignInAsync(CancellationToken ct) => SignInAsync("google", ct);
    public Task SignOutAsync(CancellationToken ct) => billing.SignOutAsync(ct);
    public bool TryDescribe(Exception error, out string? note) { note = error is LoginBillingException e && e.Code != "signin_cancelled" ? StoreAccountText.Failure(e.Code, e.Status) : null; return error is LoginBillingException; }
    // The account was deleted (4410): the pass of this instance goes too.
    public void ClearPass() => store.Delete();

    // The pass for /pc/v1: not signed in is the SignedOut state; no header for the Approval Box origin would be a wiring error, never papered over.
    public Task<ServerAccess> AccessAsync(CancellationToken ct)
    {
        if (!SignedIn) throw new SignedOutException();
        var header = billing.PassHeader(origin.GetLeftPart(UriPartial.Authority)) ?? throw new InvalidOperationException("the library hands out no pass for " + origin);
        return Task.FromResult(new ServerAccess(origin, new Dictionary<string, string> { ["authorization"] = header }));
    }

    // K of the Approval Box account, for a first registry only; it never leaves this process except in that registry on Approval Box's own server.
    public async Task<string> AccountAsync(CancellationToken ct) => (await billing.CheckAsync(ct)).K;
}
