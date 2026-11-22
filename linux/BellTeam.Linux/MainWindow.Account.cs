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
        AccountDeletion.Run = DeleteAccountAsync;
        if (!await NeedsAccountAsync()) { await Begin(savedServer); return; }
        (startupHost.Child as IDisposable)?.Dispose();
        startupHost.Child = new LinuxAccountGate(() => _ = Begin(savedServer)); startupHost.IsVisible = true;
    }

    // 「アカウントを削除」 (a485 switch; the order is Rapi's Mac reference, docs/architecture/modules/apple/account-deletion.md): this device's Approval Box sign-in and keys, then the server connection
    // (home session, tokens, window state, saved address), then the library's sign-out (pass, K, purchase mark), then the first screen with one result alert. It never stops the other devices.
    private async Task DeleteAccountAsync()
    {
        if (approvalBox is { } box) await box.DeleteLocalAsync();
        if (home is not null) try { await home.EndAsync(CancellationToken.None); } catch (HomeLinkException) { }   // best effort: the server may be unreachable; the record goes below either way
        if (model.Server is { Length: > 0 } server && Uri.TryCreate(server, UriKind.Absolute, out _)) tokens.Clear(ServerOrigin.Parse(server));
        FileSessionTokenStore.DeleteAll(SettingsStore.UserDirectory);
        model.SignOut();
        settingsStore.Save(settingsStore.Load() with { ServerUrl = null });
        if (LinuxAccountStore.Billing is { } lb) await lb.SignOutAsync();
        LinuxAccountStore.ForgetHome();
        if (settingsPage is not null) ShowConversation();
        deletedLayer.Children.Clear();
        deletedLayer.Children.Add(FormKit.AlertFrame(AccountDeletionText.ResultTitle, LinuxAccountCard.DoneText, () => deletedLayer.IsVisible = false, new AlertChoice("閉じる", Bold: true)));
        deletedLayer.IsVisible = true;
        await StartAfterAccountAsync(null);
    }

    private static async Task<bool> NeedsAccountAsync()
    {
        if (LinuxAccountStore.Billing is not { } lb) return false;
        try { return lb.PassKind == PassKind.None || (await lb.CheckAsync()).Entitlements.Count == 0; }   // asked of the server: the library keeps no entitlement list across a restart
        catch (LoginBillingException) { return false; }
    }

    private Task Begin(string? savedServer)
    {
        if (StartupRoute.Initial(savedServer, signedIn: true) == StartupPhase.Checking) return ConnectAsync(savedServer!);   // the account gate has run before Begin
        ShowServerSetup(); return Task.CompletedTask;
    }
}
