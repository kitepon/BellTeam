using Avalonia.Controls;
using BellTeam.Core;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Linux;

public sealed partial class MainWindow
{
    // First run order (app-sessions.md 7e): the account (sign-in or the phone's QR handoff) comes before any server. A device that already has a contract goes straight on; when the library cannot be asked
    // (offline, no Worker configured) the app goes on too: an unknown state is not a reason to stop. Android does the same.
    public async Task StartAfterAccountAsync(string? savedServer, bool forceGate = false)
    {
        AccountDeletion.Run = DeleteAccountAsync;
        if (!forceGate && !await NeedsAccountAsync()) { await Begin(savedServer); return; }
        (startupHost.Child as IDisposable)?.Dispose();
        startupHost.Child = new LinuxAccountGate(() => _ = Begin(savedServer)); startupHost.IsVisible = true;
    }

    // 「アカウントを削除」 (a485 switch; the order is Rapi's Mac reference, docs/architecture/modules/apple/account-deletion.md): this device's Approval Box keys and sign-out, then the server connection
    // (home session, tokens, window state, saved address), then the library's sign-out (pass, K, purchase mark), then the first screen with one result alert. It never stops the other devices.
    // A sign-out that reaches a server and fails keeps its record (the library's rule) and is listed in the result instead of 「削除しました」; pressing again finishes it, so a failure shows the account screen again.
    private async Task DeleteAccountAsync()
    {
        var failed = new DeletionFailures();
        if (approvalBox is { } box) try { await box.DeleteLocalAsync(); } catch (LoginBillingException error) { failed.Add("決裁箱のサインイン", StoreAccountText.Failure(error.Code, error.Status)); }
        var homeEnded = true;
        if (home is not null) try { await home.EndAsync(CancellationToken.None); } catch (HomeLinkException error) { homeEnded = false; failed.Add("サーバーのサインイン", StoreAccountText.Failure(error.Code, error.Status)); }
        if (homeEnded)
        {
            if (model.Server is { Length: > 0 } server && Uri.TryCreate(server, UriKind.Absolute, out _)) tokens.Clear(ServerOrigin.Parse(server));
            LinuxAccountStore.ForgetHome();
        }
        FileSessionTokenStore.DeleteAll(SettingsStore.UserDirectory);
        model.SignOut();
        settingsStore.Save(settingsStore.Load() with { ServerUrl = null });
        if (LinuxAccountStore.Billing is { } lb) try { await lb.SignOutAsync(); } catch (LoginBillingException error) { failed.Add("BellTeamのサインイン", StoreAccountText.Failure(error.Code, error.Status)); }
        if (settingsPage is not null) ShowConversation();
        deletedLayer.Children.Clear();
        deletedLayer.Children.Add(FormKit.AlertFrame(failed.Any ? AccountDeletionText.FailedTitle : AccountDeletionText.ResultTitle, failed.Any ? failed.Text : LinuxAccountCard.DoneText, () => deletedLayer.IsVisible = false, new AlertChoice("閉じる", Bold: true)));
        deletedLayer.IsVisible = true;
        await StartAfterAccountAsync(null, forceGate: failed.Any);
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
