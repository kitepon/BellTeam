using System.Text.Json;
using BellTeam.Linux;
using Kitepon.LoginBilling;

namespace BellTeam.Android;

// The one LoginBilling of the app (library rule: one instance per app). serverClientId is the Web client of Google project bellteam-515414 (not a secret). baseUrl is the operator's Worker,
// never the user's own server; it is the product.json key loginBillingWorkerUrl, and while Bready has not set it the store screens stay off (the Apple design does the same).
public static class AccountStore
{
    public const string ServerClientId = "316260984663-ktbg3e8931u0jv94c2fhccrig8ppau78.apps.googleusercontent.com";
    private static LoginBilling? billing;
    private static string? Product(string key) { using var product = JsonDocument.Parse(EmbeddedAsset.Text("product.json")); return product.RootElement.TryGetProperty(key, out var value) ? value.GetString() : null; }
    public static string ProductId => Product("productId") ?? throw new InvalidOperationException("product.json に productId がありません。");
    // The web sign-in's return address the operator lists: product.json loginBillingWebReturn (a verified https App Link, or a session scheme only the Auth Tab sees).
    private static string? WebReturn()
    {
        return Product("loginBillingWebReturn");
    }
    public static LoginBilling? Billing => billing ??= Product("loginBillingWorkerUrl") is { } worker ? new LoginBilling(MainActivity.Current, ServerClientId, worker, WebReturn()) : null;

    // At launch and on every foreground; a failure is not swallowed into a screen state here, it surfaces on the account card by the next action.
    public static async Task StartAsync()
    {
        if (Billing is not { } lb) return;
        try { await lb.StartAsync(); }
        catch (LoginBillingException error) { global::Android.Util.Log.Warn("BellTeam", "login-billing start: " + error.Code); }
    }
}
