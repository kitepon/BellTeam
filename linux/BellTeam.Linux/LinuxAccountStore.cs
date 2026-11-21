using System.Text.Json;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Linux;

// The one DesktopLoginBilling of the app (library rule: one instance per app). baseUrl is the operator's Worker (product.json loginBillingWorkerUrl), never the user's own server; while it is not set
// the account screens stay off, as on Android and in the Apple design. The pass is a file readable by its owner only (FilePassStore).
internal static class LinuxAccountStore
{
    private static DesktopLoginBilling? billing;
    private static string? Product(string key) { using var product = JsonDocument.Parse(EmbeddedAsset.Text("product.json")); return product.RootElement.TryGetProperty(key, out var value) ? value.GetString() : null; }
    public static DesktopLoginBilling? Billing => billing ??= Product("loginBillingWorkerUrl") is { } worker ? new DesktopLoginBilling(worker, FilePassStore.ForApp("BellTeam")) : null;
}
