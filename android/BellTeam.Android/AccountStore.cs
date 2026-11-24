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
        new LocalConfig([.. LocalFormIds.GoogleClientIds, LocalFormIds.AppleBundleId, LocalFormIds.AppleServicesId], Apple: new LocalAppleRules([LocalFormIds.AppleBundleId], [LocalFormIds.ProductId]),
            Play: new LocalPlayRules(LocalFormIds.PlayPackage, [LocalFormIds.ProductId], LocalFormIds.PlayPublicKey), AppleWeb: new LocalAppleWeb(LocalFormIds.AppleServicesId, LocalFormIds.AppleReturnUrl), AppId: LocalFormIds.AppleBundleId),
        log: AppleReturnLine);
    // One line per Apple return (the library builds it: time, fields, Apple's error code; never a token, code or subject) goes to the app's own log file in its private files folder, and nowhere else.
    internal static string AppleReturnLogPath => Path.Combine(global::Android.App.Application.Context.FilesDir!.AbsolutePath, "apple-return.log");
    private static void AppleReturnLine(string line) => AppleReturnLog.Append(AppleReturnLogPath, line);

    // Raised on every foreground: the account card reads the kept period and Play's purchases again.
    public static event Action? Foreground;
    public static void NoteForeground() => Foreground?.Invoke();
}

// Approval Box's origin (child-join.md; the form of the child join is AndroidChildJoinForm): product.json's address. A debug build's file files/approval-box-device may hold an auth URL: a lab run against approval-box's local dev server
// (http://127.0.0.1:8788/auth/v1 through adb reverse); no file or an empty one = product.json's address. A release build ignores the file's content: it is only the switch.
public static class ApprovalBoxAccount
{
#if DEBUG
    internal static string? LabUrl => File.Exists(Switch) && File.ReadAllText(Switch).Trim() is { Length: > 0 } lab ? lab : null;
#else
    internal static string? LabUrl => null;
#endif
    internal static string? AuthUrl => LabUrl ?? AccountStore.Product("approvalBoxAuthUrl");
    internal static string Switch => Path.Combine(global::Android.App.Application.Context.FilesDir!.AbsolutePath, "approval-box-device");
}
