using System.Reflection;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.App;

// a540: the library's LocalConfig of this app (login-billing contract 1.36 s10, 1.37), from the public ids in Core (LocalFormIds). Never put a token or a pass here.
internal static class LocalFormConfig
{
    // The Desktop client's secret reaches the build from the host vault (scripts/install-windows.ps1 -GoogleDesktopOAuthRef -> BELLTEAM_GOOGLE_DESKTOP_SECRET -> assembly metadata, BellTeam.App.csproj): GitHub's push protection refuses it in a commit.
    // Google treats a Desktop client's secret as non-confidential; it is sent with the token request only and never logged. A build without it (a source build with no vault) signs in with Google's refusal, "client_secret is missing".
    internal static string? GoogleSecret =>
        typeof(LocalFormConfig).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(a => a.Key == "GoogleDesktopSecret")?.Value is { Length: > 0 } secret ? secret : null;

    // Audiences: every Google client id of BellTeam (the phone's token may carry any), Apple's own app id and the Services ID of the PC's own Apple sign-in (1.46: it must be among them). Apple's root: null takes the library's built-in Apple Root CA - G3 (1.37).
    // No keyholes (1.47) and no freeAccounts (1.43): BellTeam does not use them. Sandbox: a TestFlight purchase on the paying phone is taken (Owner ruling 2026-11-24).
    public static LocalConfig Build() => new(
        [.. LocalFormIds.GoogleClientIds, LocalFormIds.AppleBundleId, LocalFormIds.AppleServicesId], LocalFormIds.GoogleDesktopClientId,
        new AppleRules([LocalFormIds.AppleBundleId], [LocalFormIds.ProductId], LocalFormIds.AppleAcceptsSandbox, null!),
        new PlayRules(LocalFormIds.PlayPackage, [LocalFormIds.ProductId], LocalFormIds.PlayPublicKey), 31, GoogleSecret,
        AppleServicesId: LocalFormIds.AppleServicesId, AppleReturnUrl: LocalFormIds.AppleReturnUrl, AppId: AppId);
    // 1.49: the app id of the QR's join link (https://login-billing.kitepon.dev/join/dev.kitepon.bellbot#lbq4:...), so the phone's own camera opens BellTeam (Apple applinks, Android App Link).
    internal const string AppId = "dev.kitepon.bellbot";
}
