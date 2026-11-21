using Avalonia.Controls;
using BellTeam.Core;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Linux;

public sealed partial class MainWindow
{
    // First run order (app-sessions.md 7e): the account (sign-in or the phone's QR handoff) comes before any server. A device that already has a contract goes straight on; when the library cannot be asked
    // (offline, no Worker configured) the app goes on too: an unknown state is not a reason to stop. Android does the same.
    public async Task StartAfterAccountAsync(string? savedServer)
    {
        if (!await NeedsAccountAsync()) { await Begin(savedServer); return; }
        (startupHost.Child as IDisposable)?.Dispose();
        startupHost.Child = new LinuxAccountGate(() => _ = Begin(savedServer)); startupHost.IsVisible = true;
    }

    private static async Task<bool> NeedsAccountAsync()
    {
        if (LinuxAccountStore.Billing is not { } lb) return false;
        try { return lb.PassKind == PassKind.None || (await lb.CheckAsync()).Entitlements.Count == 0; }   // asked of the server: the library keeps no entitlement list across a restart
        catch (LoginBillingException) { return false; }
    }

    private Task Begin(string? savedServer)
    {
        if (StartupRoute.Initial(savedServer) != StartupPhase.Setup) return ConnectAsync(savedServer!);
        ShowServerSetup(); return Task.CompletedTask;
    }
}
