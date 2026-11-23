using BellTeam.Core;
using BellTeam.Linux;
using BellTeam.PeerChannel;
using Kitepon.LoginBilling;

namespace BellTeam.Android;

// a520a: the Approval Box device of this phone. The device part is the Linux one on the shared C# pc/1 core (LinuxApprovalBoxDevice with platform "android"); this file is only Android's account:
// the SECOND, foreign login-library instance (ApprovalBoxAccount: its own storage, web sign-in only, no purchase or receipt) as IApprovalBoxAccount.
internal sealed class AndroidApprovalBoxAccount(LoginBilling billing, Uri origin) : IApprovalBoxAccount
{
    public Uri Origin => origin;
    // The pass is handed out for the Approval Box origin only (the library's own rule); not signed in is the SignedOut state, never papered over.
    public Task<ServerAccess> AccessAsync(CancellationToken ct)
    {
        // 0.20.2: the Authorization value, only for a URL of the base origin; it goes to /pc/v1 and nowhere else, and is never logged. The binding has no NoteResponse: a renewal on this path is not kept (the library's own calls keep theirs).
        var header = billing.PassHeader(origin.GetLeftPart(UriPartial.Authority)) ?? throw new SignedOutException();
        return Task.FromResult(new ServerAccess(origin, new Dictionary<string, string> { ["authorization"] = header }));
    }

    // K of the Approval Box account, for a first registry only; it never leaves this process except in that registry on Approval Box's own server.
    public async Task<string> AccountAsync(CancellationToken ct) => (await billing.CheckAsync()).K;
#if DEBUG
    // Lab only (a debug build whose switch file names approval-box's local dev server): the dev server's fake id token in place of the web sign-in (Chrome older than the Auth Tab has no way to return).
    public async Task SignInAsync(CancellationToken ct)
    {
        if (ApprovalBoxAccount.LabUrl is not { } lab) { await billing.SignInWebAsync(MainActivity.Current, "google", false).WaitAsync(ct); return; }
        using var http = new HttpClient();
        await billing.SignInForTestingAsync("apple", async nonce =>
        {
            using var reply = await http.PostAsync(new Uri(lab).GetLeftPart(UriPartial.Authority) + "/dev/id-token", new StringContent(System.Text.Json.JsonSerializer.Serialize(new { provider = "apple", nonce, sub = "dev-person" }), System.Text.Encoding.UTF8, "application/json"), ct);
            return System.Text.Json.JsonDocument.Parse(await reply.Content.ReadAsStringAsync(ct)).RootElement.GetProperty("id_token").GetString()!;
        }, "dev-android", false, false).WaitAsync(ct);
    }
#else
    public Task SignInAsync(CancellationToken ct) => billing.SignInWebAsync(MainActivity.Current, "google", false).WaitAsync(ct);
#endif
    public Task SignOutAsync(CancellationToken ct) => billing.SignOutAsync().WaitAsync(ct);
    // The account was deleted (4410): the pass goes too. A record the library cannot remove stays; the next sign-out or sign-in replaces it.
    public void ClearPass() => _ = Task.Run(async () => { try { await billing.SignOutAsync(); } catch (LoginBillingException) { } });
    public bool TryDescribe(Exception error, out string? note) { note = error is LoginBillingException e && e.Code != "signin_cancelled" ? StoreAccountText.Failure(e.Code, e.Status) : null; return error is LoginBillingException; }
}

internal static class AndroidApprovalBoxDevice
{
    private static string FilesDir => global::Android.App.Application.Context.FilesDir!.AbsolutePath;

    // Always on (client-v0.5.md 5.3): the server's peer_channel picks /v1 or the device session. No product.json address = no client (the screen says so). The engine is in every ABI of the APK.
    internal static LinuxApprovalBoxDevice? Create(Func<IReadOnlyList<(string Id, string Name)>> roster)
    {
        if (ApprovalBoxAccount.Billing is not { } billing || ApprovalBoxAccount.AuthUrl is not { } url) return null;
        return new LinuxApprovalBoxDevice(Path.Combine(FilesDir, "approval-box"), new AndroidApprovalBoxAccount(billing, new Uri(new Uri(url).GetLeftPart(UriPartial.Authority))), roster, true, "android");
    }
}
