using BellTeam.Core;
using BellTeam.Linux;
using BellTeam.PeerChannel;
using Kitepon.LoginBilling;

namespace BellTeam.Android;

// a520a: the Approval Box device of this phone. The device part is the Linux one on the shared C# pc/1 core (LinuxApprovalBoxDevice with platform "android"); this file is only Android's account:
// the SECOND, foreign login-library instance (ApprovalBoxAccount: its own storage, web sign-in only, no purchase or receipt) as IApprovalBoxAccount.
internal sealed class AndroidApprovalBoxAccount(LoginBilling billing, Uri origin) : IApprovalBoxAccount
{
    // The pass is handed out for the Approval Box origin only (the library's own rule); not signed in is the SignedOut state, never papered over.
    public Task<ServerAccess> AccessAsync(CancellationToken ct)
    {
        // WIP: Android's LoginBilling 0.20.1 has no PassHeader(url) (Desktop has); asked of Purika. Until then the device cannot authorize.
        string? header = null; if (header is null) throw new SignedOutException();
        return Task.FromResult(new ServerAccess(origin, new Dictionary<string, string> { ["authorization"] = header }));
    }

    // K of the Approval Box account, for a first registry only; it never leaves this process except in that registry on Approval Box's own server.
    public async Task<string> AccountAsync(CancellationToken ct) => throw new NotSupportedException("WIP: CheckResult.K is not in the Android binding 0.20.1 (Desktop has PassCheck.K); asked of Purika");
    public Task SignInAsync(CancellationToken ct) => billing.SignInWebAsync(MainActivity.Current, "google", false).WaitAsync(ct);
    public Task SignOutAsync(CancellationToken ct) => billing.SignOutAsync().WaitAsync(ct);
    // The account was deleted (4410): the pass goes too. A record the library cannot remove stays; the next sign-out or sign-in replaces it.
    public void ClearPass() => _ = Task.Run(async () => { try { await billing.SignOutAsync(); } catch (LoginBillingException) { } });
    public bool TryDescribe(Exception error, out string? note) { note = error is LoginBillingException e && e.Code != "signin_cancelled" ? StoreAccountText.Failure(e.Code, e.Status) : null; return error is LoginBillingException; }
}

internal static class AndroidApprovalBoxDevice
{
    // shortcut: until the go-live ruling of Delta and Nayuta the part is off, like the PC's BELLTEAM_APPROVAL_BOX_DEVICE; a debug build switches it on with a file in the app's files (adb shell run-as dev.kitepon.bellbot touch files/approval-box-device). Replace with the product's own switch at go-live.
    internal static bool Enabled => ApprovalBoxAccount.Billing is not null && File.Exists(Path.Combine(FilesDir, "approval-box-device"));

    private static string FilesDir => global::Android.App.Application.Context.FilesDir!.AbsolutePath;

    internal static LinuxApprovalBoxDevice? Create()
    {
        if (!Enabled || ApprovalBoxAccount.Billing is not { } billing || AccountStore.Product("approvalBoxAuthUrl") is not { } url) return null;
        return new LinuxApprovalBoxDevice(Path.Combine(FilesDir, "approval-box"), new AndroidApprovalBoxAccount(billing, new Uri(url)), "android");
    }
}
