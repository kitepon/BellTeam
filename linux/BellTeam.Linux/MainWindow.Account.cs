using Avalonia.Controls;
using BellTeam.Core;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Linux;

public sealed partial class MainWindow
{
    // First run order (app-sessions.md 7e): the account (the phone's QR, contract 1.36 s10) comes before any server. A device whose kept period holds goes straight on; when the form is not configured yet
    // (LocalFormIds) the app goes on too: an unknown state is not a reason to stop. Android does the same.
    public async Task StartAfterAccountAsync(string? savedServer, bool forceGate = false)
    {
        if (!forceGate && !NeedsAccount()) { await Begin(savedServer); return; }
        (startupHost.Child as IDisposable)?.Dispose();
        startupHost.Child = new LinuxAccountGate(() => _ = Begin(savedServer)); startupHost.IsVisible = true;
    }

    // The kept reply checked against this device's clock; a store the library cannot read is not a reason to stop (the card shows it).
    private static bool NeedsAccount()
    {
        if (LinuxAccountStore.Local is not { } local) return false;
        try { return local.PaidUntil() is null; }
        catch (LoginBillingException) { return false; }
    }

    private Task Begin(string? savedServer)
    {
        if (StartupRoute.Initial(savedServer, signedIn: true) == StartupPhase.Checking) return ConnectAsync(savedServer!);   // the account gate has run before Begin
        ShowServerSetup(); return Task.CompletedTask;
    }
}
