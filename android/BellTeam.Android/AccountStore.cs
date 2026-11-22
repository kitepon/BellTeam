using System.Text.Json;
using BellTeam.Linux;
using Kitepon.LoginBilling;

namespace BellTeam.Android;

// BellTeam's own LoginBilling (library rule 1.24: one instance per deployment; Approval Box's second one is ApprovalBoxAccount below). serverClientId is the Web client of Google project bellteam-515414 (not a secret). baseUrl is the operator's Worker,
// never the user's own server; it is the product.json key loginBillingWorkerUrl, and while Bready has not set it the store screens stay off (the Apple design does the same).
public static class AccountStore
{
    public const string ServerClientId = "316260984663-ktbg3e8931u0jv94c2fhccrig8ppau78.apps.googleusercontent.com";
    private static LoginBilling? billing;
    internal static string? Product(string key) { using var product = JsonDocument.Parse(EmbeddedAsset.Text("product.json")); return product.RootElement.TryGetProperty(key, out var value) ? value.GetString() : null; }
    public static string ProductId => Product("productId") ?? throw new InvalidOperationException("product.json に productId がありません。");
    // The web sign-in's return address the operator lists: product.json loginBillingWebReturn (a verified https App Link, or a session scheme only the Auth Tab sees).
    private static string? WebReturn()
    {
        return Product("loginBillingWebReturn");
    }
    private static IHomeLink? home;
    // The one home connection of the app (library rule: one per home server).
    public static IHomeLink? Home => home ??= Billing is { } lb ? new AndroidHomeLink(lb, new KeystoreHomeStore()) : null;
    private static string? WorkerUrl()
    {
#if DEBUG
        if (DevOperator.Url is { } dev) return dev;
#endif
        return Product("loginBillingWorkerUrl");
    }
    public static LoginBilling? Billing => billing ??= WorkerUrl() is { } worker ? new LoginBilling(MainActivity.Current, ServerClientId, worker, WebReturn()) : null;

    // At launch and on every foreground; a failure is not swallowed into a screen state here, it surfaces on the account card by the next action.
    public static async Task StartAsync()
    {
        if (Billing is not { } lb) return;
        try { await lb.StartAsync(); }
        catch (LoginBillingException error) { global::Android.Util.Log.Warn("BellTeam", "login-billing start: " + error.Code); }
    }
}

// a515n (login-billing 0.18.0, contract 1.24): Approval Box's own instance, "foreign": its own base origin, its own storage (storageName: folder and Keystore alias apart from BellTeam's), web sign-in only,
// never a native sheet, a purchase or a receipt. The two instances share nothing; signing out of one leaves the other. product.json: approvalBoxAuthUrl, approvalBoxWebReturn (the address Approval Box's operator lists:
// exactly approvalbox-websignin://return, Nayuta 2026-11-22: the server compares only the scheme, one fixed string for every BellTeam app; never the https /app/websignin link, which is for Approval Box's own apps). serverClientId is empty: the native Google route is never used here.
public static class ApprovalBoxAccount
{
    public const string StorageName = "approvalbox";
    private static LoginBilling? billing;
    public static LoginBilling? Billing => billing ??= AccountStore.Product("approvalBoxAuthUrl") is { } url ? new LoginBilling(MainActivity.Current, "", url, AccountStore.Product("approvalBoxWebReturn"), StorageName) : null;
}

#if DEBUG
// Contract 1.25, dev servers and test sign-in: compiled into DEBUG builds only. With files/dev-operator.txt present (adb run-as; the file holds the dev operator's /auth/v1 base, reached by adb reverse on localhost)
// the account runs against Bready's DEV operator: the Credential Manager sheet is replaced by an id token the operator's own process makes for the server's nonce (SignInForTestingAsync). Fake stores and keys only.
internal static class DevOperator
{
    public static string? Url
    {
        get { var path = Path.Combine(global::Android.App.Application.Context.FilesDir!.AbsolutePath, "dev-operator.txt"); return File.Exists(path) ? File.ReadAllText(path).Trim() : null; }
    }

    public static Func<string, Task<string>> IdToken(string provider) => async nonce =>
    {
        var origin = new Uri(Url!).GetLeftPart(UriPartial.Authority);
        using var http = new HttpClient();
        using var response = await http.PostAsync(origin + "/dev/id-token", new StringContent(JsonSerializer.Serialize(new { provider, nonce, sub = "dev-person" }), System.Text.Encoding.UTF8, "application/json"));
        response.EnsureSuccessStatusCode();
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("id_token").GetString()!;
    };
}
#endif
