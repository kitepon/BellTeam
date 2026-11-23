using System.Net.Http;
using BellTeam.PeerChannel;
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

    /// <summary>Approval Box's /v1 (the same origin as /auth/v1): every request carries the pass as Authorization: Bearer and a renewed pass replaces the kept one (library handler). The pass is never logged.</summary>
    internal Uri V1Base => new(origin, "/v1/");
    internal HttpClient CreateV1Client(HttpMessageHandler? inner = null) => new(billing.CreateHttpHandler(inner ?? new HttpClientHandler())) { BaseAddress = V1Base, Timeout = Timeout.InfiniteTimeSpan };
    /// <summary>The handoff sign-in (library 1.20): this PC shows a QR the Approval Box app on a signed-in phone reads and approves; the pass comes back to this PC. Works for an Apple account too (no Apple sign-in on Windows).</summary>
    internal Task<LoginStart?> StartHandoffAsync(string label, CancellationToken ct) => billing.StartLoginAsync(label, ct);
    internal Task WaitForHandoffAsync(CancellationToken ct) => billing.WaitForPassAsync(ct);
    /// <summary>GET /v1/auth/config (no pass): the switch Approval Box owns. true = the app moved to /pc/v1; false or no such field = /v1 (client-v0.5 5.3). null = could not be read.</summary>
    internal async Task<bool?> ReadPeerChannelAsync(HttpMessageHandler? inner, CancellationToken ct)
    {
        using var http = new HttpClient(inner ?? new HttpClientHandler(), disposeHandler: inner is null) { BaseAddress = V1Base, Timeout = TimeSpan.FromSeconds(15) };
        using var response = await http.GetAsync("auth/config", ct);
        if (!response.IsSuccessStatusCode) return null;
        using var document = System.Text.Json.JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        return document.RootElement.TryGetProperty("peer_channel", out var field) && field.ValueKind is System.Text.Json.JsonValueKind.True or System.Text.Json.JsonValueKind.False ? field.GetBoolean() : false;
    }
    /// <summary>The pass was refused or ended (a 401): it is dropped and the sign-in screen opens.</summary>
    internal void DropPass() => store.Delete();
    internal bool SignedIn { get { try { return billing.PassKind != PassKind.None; } catch (LoginBillingException) { return false; } } }

    /// <summary>The system browser opens Approval Box's web sign-in and the loopback return brings the pass back (Windows, Nayuta/Delta).</summary>
    // open = null: the system browser. A test passes its own opener (approval-box's dev server answers the browser's part itself).
    internal Task SignInAsync(string provider, CancellationToken ct, Func<Uri, Task>? open = null) => billing.SignInWebAsync(provider, open ?? TestBrowser.Open, false, ct);
    internal Task SignOutAsync(CancellationToken ct) => billing.SignOutAsync(ct);
    // The account was deleted (4410): the pass of this instance goes too.
    internal void ClearPass() => store.Delete();

    // The pass for /pc/v1: not signed in is the SignedOut state; no header for the Approval Box origin would be a wiring error, never papered over.
    internal Task<ServerAccess> AccessAsync(CancellationToken ct)
    {
        if (!SignedIn) throw new SignedOutException();
        var header = billing.PassHeader(origin.GetLeftPart(UriPartial.Authority)) ?? throw new InvalidOperationException("the library hands out no pass for " + origin);
        return Task.FromResult(new ServerAccess(origin, new Dictionary<string, string> { ["authorization"] = header }));
    }

    // K of the Approval Box account, for a first registry only; it never leaves this process except in that registry on Approval Box's own server.
    internal async Task<string> AccountAsync(CancellationToken ct) => (await billing.CheckAsync(ct)).K;
}
