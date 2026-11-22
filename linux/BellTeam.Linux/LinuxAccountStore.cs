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
    public static event Action? Foreground;
    public static void NoteForeground() => Foreground?.Invoke();
    public static DesktopLoginBilling? Billing => billing ??= Product("loginBillingWorkerUrl") is { } worker ? new DesktopLoginBilling(worker, FilePassStore.ForApp("BellTeam")) : null;
}
