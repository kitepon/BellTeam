using Kitepon.LoginBilling.Desktop;

namespace BellTeam.App;

// The one DesktopLocal of the app (a540, login-billing contract 1.36 s10: the local form). No server of any kind takes part: the accepted period and the Google sign-in (provider and subject) are kept by the library in this Windows user's protected storage.
internal static class AccountStore
{
    // Providers the Approval Box sign-in offers (its own library instance, ApprovalBoxAccount); BellTeam itself signs in with Google only (Apple comes in the iPhone's reply).
    public static readonly string[] Providers = ["google"];
    // Opens Google's sign-in page; null = the library's own (the default browser). Test seam: a check never opens a real browser (BELLTEAM_TEST_CHROME_PROFILE picks a test one).
    public static Func<Uri, Task>? OpenBrowser { get; set; } = TestBrowser.Open;
    private static DesktopLocal? local;
    // Test and render seam: the window under check gets a DesktopLocal with a memory store.
    public static DesktopLocal Local
    {
        get => local ??= new DesktopLocal(LocalFormConfig.Build(), LocalStore.ForApp("BellTeam"));
        set => local = value;
    }
    // First-run routing and every opening: the accepted period that has not ended on this device's clock (the library re-checks the kept reply against now), else null. A store that cannot be read is no period: the account screen says why.
    public static LocalPaid? Paid
    {
        get { try { return Local.PaidUntil(); } catch (LoginBillingException) { return null; } }
    }
}
