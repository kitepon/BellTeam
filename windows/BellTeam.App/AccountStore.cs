using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BellTeam.Core;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.App;

// The one DesktopLoginBilling of the app (library rule: one instance per app). baseUrl is the operator's Worker, never the user's own server: BELLTEAM_LOGIN_BILLING_URL for a development run, else product.json loginBillingWorkerUrl.
// While neither is set the account screens say so (the Android app does the same). The pass is kept by the library in a DPAPI file of this Windows user.
internal static class AccountStore
{
    private static DesktopLoginBilling? billing;
    private static bool made;
    // Providers the sign-in offers. shortcut: Apple's web sign-in waits for the Owner's Apple sitting (Tronie 2026-11-22), add "apple" then.
    public static readonly string[] Providers = ["google"];
    public static DesktopLoginBilling? Billing
    {
        get => made ? billing : (billing = Make());
        // Test and render seam: the window under check gets a billing with a memory pass store and a canned answer.
        set { billing = value; made = true; }
    }
    // First-run routing: a pass is kept. A store that cannot be read is not "signed in"; the account screen then says why.
    public static bool SignedIn
    {
        get { try { return Billing is { } b && b.PassKind != PassKind.None; } catch (LoginBillingException) { return false; } }
    }
    private static HomeConnection? home;
    // Test seam: where home.bin lives (default: this Windows user's BellTeam folder).
    internal static string HomeDirectory { get; set; } = SettingsStore.UserDirectory;
    // The one HomeConnection of the app (library rule: one per home server). Its record (base, token, session id) is sealed with DPAPI for this Windows user.
    public static HomeConnection? Home => home ??= Billing?.HomeConnection(new DpapiHomeStore(Path.Combine(HomeDirectory, "home.bin")));
    // a485 「アカウントを削除」: the record of this PC goes even when the server could not be reached to end its session.
    public static void ForgetHome() { new DpapiHomeStore(Path.Combine(HomeDirectory, "home.bin")).Delete(); home = null; }
    // The Bearer token for a URL of the home server's own origin, else null (the library hands it out for that origin only).
    public static string? HomeToken(Uri origin) => Home?.HomeHeader(origin.AbsoluteUri) is { } header ? header["Bearer ".Length..] : null;
    private static DesktopLoginBilling? Make()
    {
        made = true;
        var url = Environment.GetEnvironmentVariable("BELLTEAM_LOGIN_BILLING_URL");
        if (string.IsNullOrWhiteSpace(url))
        {
            using var product = JsonDocument.Parse(EmbeddedAsset.Text("product.json"));
            url = product.RootElement.TryGetProperty("loginBillingWorkerUrl", out var value) ? value.GetString() : null;
        }
        return string.IsNullOrWhiteSpace(url) ? null : new DesktopLoginBilling(url, FilePassStore.ForApp("BellTeam"));
    }
}

// The home record sealed with DPAPI (current user, own entropy). A file that does not unseal is no record: the library then asks to connect again.
internal sealed class DpapiHomeStore(string path) : IHomeStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("BellTeam-home-record");
    public string? Read()
    {
        if (!File.Exists(path)) return null;
        try { return Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(path), Entropy, DataProtectionScope.CurrentUser)); }
        catch (CryptographicException) { return null; }
    }
    public void Write(string record)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + ".tmp";
        File.WriteAllBytes(temp, ProtectedData.Protect(Encoding.UTF8.GetBytes(record), Entropy, DataProtectionScope.CurrentUser));
        File.Move(temp, path, overwrite: true);
    }
    public void Delete() => File.Delete(path);
}
