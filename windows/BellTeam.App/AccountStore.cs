using Kitepon.LoginBilling.Desktop;

namespace BellTeam.App;

// The one DesktopLocal of the app (a540, login-billing contract 1.36 s10: the local form). No server of any kind takes part: the accepted period and the Google sign-in (provider and subject) are kept by the library in this Windows user's protected storage.
internal static class AccountStore
{
    // Providers the Approval Box sign-in offers (its own library instance, ApprovalBoxAccount); BellTeam itself signs in with Google only (Apple comes in the iPhone's reply).
    public static readonly string[] Providers = ["google"];
    // Opens Google's sign-in page; null = the library's own (the default browser). Test seam: a check never opens a real browser (BELLTEAM_TEST_CHROME_PROFILE picks a test one).
    // Contract 1.46 (Mint, Tronie 2026-11-24): the library hands one line per Apple return (time, which fields arrived, Apple's error code; never the token, the code or the subject) to the product, which keeps it on this device
    // in the app's local data folder and sends it nowhere. A line a day at most in practice: no rotation (shortcut: add one if it ever grows). A failed write never fails the sign-in; it is traced.
    internal static string AppleReturnLogPath { get; set; } = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BellTeam", "apple-return.log");
    private static readonly object AppleReturnLogGate = new();
    internal static void WriteAppleReturnLine(string line)
    {
        try { lock (AppleReturnLogGate) { System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(AppleReturnLogPath)!); System.IO.File.AppendAllText(AppleReturnLogPath, line + Environment.NewLine); } }
        catch (Exception error) when (error is System.IO.IOException or UnauthorizedAccessException) { System.Diagnostics.Trace.TraceWarning("the Apple-return line was not written: " + error.Message); }
    }
    internal static DesktopLocal Create(IPassStore store) => new(LocalFormConfig.Build(), store) { Log = WriteAppleReturnLine };
    public static Func<Uri, Task>? OpenBrowser { get; set; } = TestBrowser.Open;
    private static DesktopLocal? local;
    // Test and render seam: the window under check gets a DesktopLocal with a memory store.
    public static DesktopLocal Local
    {
        get => local ??= Create(LocalStore.ForApp("BellTeam"));
        set => local = value;
    }
    // First-run routing and every opening: the accepted period that has not ended on this device's clock (the library re-checks the kept reply against now), else null. A store that cannot be read is no period: the account screen says why.
    public static LocalPaid? Paid
    {
        get { try { return Local.PaidUntil(); } catch (LoginBillingException) { return null; } }
    }
}
