using System.Text.Json;
using BellTeam.Core;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Linux;

// The one DesktopLoginBilling of the app (library rule: one instance per app). baseUrl is the operator's Worker (product.json loginBillingWorkerUrl), never the user's own server; while it is not set
// the account screens stay off, as on Android and in the Apple design. The pass is a file readable by its owner only (FilePassStore).
internal static class LinuxAccountStore
{
    private static DesktopLoginBilling? billing;
    private static string? Product(string key) { using var product = JsonDocument.Parse(EmbeddedAsset.Text("product.json")); return product.RootElement.TryGetProperty(key, out var value) ? value.GetString() : null; }
    private static IHomeLink? home;
    // The one home connection of the app (library rule: one per home server); its record is home.json beside the other per-user files.
    public static IHomeLink? Home => home ??= Billing is { } lb ? new LinuxHomeLink(lb, new FileHomeStore(Path.Combine(SettingsStore.UserDirectory, "home.json"))) : null;
    // Raised when the window comes to the front: the account card reads the server's answer again (Tronie 2026-11-23, same spec as the Apple app).
    // 「アカウントを削除」: the home record file goes too (the library's sign-out does not end the home session); the next connection asks to log in again.
    public static void ForgetHome() { try { File.Delete(Path.Combine(SettingsStore.UserDirectory, "home.json")); } catch (IOException) { } }
    public static event Action? Foreground;
    public static void NoteForeground() => Foreground?.Invoke();
    // BELLTEAM_LOGIN_BILLING_URL points a development or test run at another Worker (the same rule as the Windows app); a build with neither set uses product.json.
    private static string? WorkerUrl() => Environment.GetEnvironmentVariable("BELLTEAM_LOGIN_BILLING_URL") is { Length: > 0 } over ? over : Product("loginBillingWorkerUrl");
    public static DesktopLoginBilling? Billing => billing ??= WorkerUrl() is { } worker ? new DesktopLoginBilling(worker, FilePassStore.ForApp("BellTeam")) : null;
}
