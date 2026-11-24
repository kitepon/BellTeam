using BellTeam.Core;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Linux;

// The one DesktopLocal of the app (a540, login-billing contract 1.36: the local form). No server of any kind takes part in sign-in or payment: this device shows a QR, a paying phone on the same Wi-Fi answers it directly,
// and the app checks the store's own proof itself. The record (provider, subject, the accepted reply) is a file only the user can read. null while LocalFormIds lacks Pinocchio's or Cielo's value: the card then says so.
internal static class LinuxAccountStore
{
    private static DesktopLocal? local;
    public static DesktopLocal? Local => local ??= !LocalFormIds.DesktopReady ? null : new DesktopLocal(
        new LocalConfig([.. LocalFormIds.GoogleClientIds, LocalFormIds.AppleBundleId, LocalFormIds.AppleServicesId], LocalFormIds.GoogleDesktopClientId,
            GoogleClientSecret: DesktopSecret, Apple: new AppleRules([LocalFormIds.AppleBundleId], [LocalFormIds.ProductId]), Play: new PlayRules(LocalFormIds.PlayPackage, [LocalFormIds.ProductId], LocalFormIds.PlayPublicKey),
            AppleServicesId: LocalFormIds.AppleServicesId, AppleReturnUrl: LocalFormIds.AppleReturnUrl, AppId: LocalFormIds.AppleBundleId),
        LocalStore.ForApp("BellTeam")) { Log = AppleReturnLine };
    // One line per Apple return (the library builds it: time, fields, Apple's error code; never a token, code or subject) goes to the app's own log file in ~/.local/share/BellTeam, and nowhere else.
    internal static string AppleReturnLogPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BellTeam", "apple-return.log");
    private static void AppleReturnLine(string line) => AppleReturnLog.Append(AppleReturnLogPath, line);
    // Injected at build time from the vault (BellTeam.Linux.csproj); null in a build made without it. Never logged.
    private static string? DesktopSecret => System.Reflection.CustomAttributeExtensions.GetCustomAttributes<System.Reflection.AssemblyMetadataAttribute>(typeof(LinuxAccountStore).Assembly).FirstOrDefault(a => a.Key == "GoogleDesktopClientSecret")?.Value;
    // Raised when the window comes to the front: the card reads the kept period against the clock again (a period that ended asks for a new QR).
    public static event Action? Foreground;
    public static void NoteForeground() => Foreground?.Invoke();
}
