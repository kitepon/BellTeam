using System.Text.Json;
using BellTeam.Core;
using BellTeam.Linux;
using Kitepon.LoginBilling;
using LbLocalForm = Kitepon.LoginBilling.LocalForm;   // BellTeam.Core also has a LocalForm (the period rule)

namespace BellTeam.Android;

// a540 (login-billing contract 1.36 section 10, the local form): this phone is both the device that wants in (it shows a QR) and the phone that holds the purchase (it checks its own Play purchase and answers another
// device's QR). No server of any kind takes part in sign-in or payment. serverClientId is the Web client of Google project bellteam-515414 (not a secret); the store rules and the audiences are LocalFormIds. null while the Play key is missing.
public static class AccountStore
{
    public const string ServerClientId = "316260984663-ktbg3e8931u0jv94c2fhccrig8ppau78.apps.googleusercontent.com";
    private static LbLocalForm? local;
    internal static string? Product(string key) { using var product = JsonDocument.Parse(EmbeddedAsset.Text("product.json")); return product.RootElement.TryGetProperty(key, out var value) ? value.GetString() : null; }
    public static LbLocalForm? Local => local ??= !LocalFormIds.AndroidReady ? null : new LbLocalForm(MainActivity.Current, ServerClientId,
        new LocalConfig([.. LocalFormIds.GoogleClientIds, LocalFormIds.AppleBundleId], Apple: new LocalAppleRules([LocalFormIds.AppleBundleId], [LocalFormIds.ProductId]),
            Play: new LocalPlayRules(LocalFormIds.PlayPackage, [LocalFormIds.ProductId], LocalFormIds.PlayPublicKey)));

    // Raised on every foreground: the account card reads the kept period and Play's purchases again.
    public static event Action? Foreground;
    public static void NoteForeground() => Foreground?.Invoke();
}

// a515n (login-billing 0.18.0, contract 1.24): Approval Box's own instance, "foreign": its own base origin, its own storage (storageName: folder and Keystore alias apart from BellTeam's), web sign-in only,
// never a native sheet, a purchase or a receipt. The application context (what the library keeps anyway): the device part is made in Application.OnCreate, before any activity exists. The two instances share nothing; signing out of one leaves the other. product.json: approvalBoxAuthUrl, approvalBoxWebReturn (the address Approval Box's operator lists:
// exactly approvalbox-websignin://return, Nayuta 2026-11-22: the server compares only the scheme, one fixed string for every BellTeam app; never the https /app/websignin link, which is for Approval Box's own apps). serverClientId is empty: the native Google route is never used here.
public static class ApprovalBoxAccount
{
    public const string StorageName = "approvalbox";
    private static LoginBilling? billing;
    // The device part's switch file (files/approval-box-device) may hold an auth URL: a lab run against approval-box's local dev server (http://127.0.0.1:8788/auth/v1 through adb reverse). Empty file = product.json's address.
#if DEBUG
    internal static string? LabUrl => File.Exists(Switch) && File.ReadAllText(Switch).Trim() is { Length: > 0 } lab ? lab : null;
#else
    internal static string? LabUrl => null;   // a release build ignores the file's content: it is only the switch
#endif
    internal static string? AuthUrl => LabUrl ?? AccountStore.Product("approvalBoxAuthUrl");
    internal static string Switch => Path.Combine(global::Android.App.Application.Context.FilesDir!.AbsolutePath, "approval-box-device");
    public static LoginBilling? Billing => billing ??= AuthUrl is { } url ? new LoginBilling(global::Android.App.Application.Context, "", url, AccountStore.Product("approvalBoxWebReturn"), StorageName) : null;
}
