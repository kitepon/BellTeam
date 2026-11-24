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
        AccountDeletion.Run = DeleteAccountAsync;
        if (!forceGate && !NeedsAccount()) { await Begin(savedServer); return; }
        (startupHost.Child as IDisposable)?.Dispose();
        startupHost.Child = new LinuxAccountGate(() => _ = Begin(savedServer)); startupHost.IsVisible = true;
    }

    // Render seam: the first screen (qr null) and the screen that waits for the parent device (qr given), with no live request.
    public void ShowAccountForRender(string? qr) { startupHost.Child = new LinuxAccountGate(() => { }, qr); startupHost.IsVisible = true; }

    // 「アカウントを削除」 (a540; Rapi's final table, Poli approved; docs/architecture/modules/apple/account-deletion.md): BellTeam holds nothing on any server, so the deletion is a local sign-out plus Approval Box's sign-out.
    // Order: both sign-outs first (each is tried; one that passed stays passed); if either fails nothing else is touched and the failure alone is shown; only when both passed the connection goes (tokens, window state, saved address)
    // and the first screen comes back under one result alert. It never stops the other devices.
    private async Task DeleteAccountAsync()
    {
        var failed = new DeletionFailures();
        if (approvalBox is { } box) try { await box.DeleteLocalAsync(); } catch (Exception error) { failed.Add("決裁箱のサインイン", error, (error as LoginBillingException)?.Status ?? 0); }
        try { LinuxAccountStore.Local?.SignOutLocal(); } catch (Exception error) { failed.Add("BellTeamの購読の確認", error); }
        if (failed.Any) { ShowDeletionResult(AccountDeletionText.FailedTitle, failed.Text); return; }
        if (model.Server is { Length: > 0 } server && Uri.TryCreate(server, UriKind.Absolute, out _)) tokens.Clear(ServerOrigin.Parse(server));
        FileSessionTokenStore.DeleteAll(SettingsStore.UserDirectory);
        model.SignOut();
        settingsStore.Save(settingsStore.Load() with { ServerUrl = null });
        if (settingsPage is not null) ShowConversation();
        ShowDeletionResult(AccountDeletionText.ResultTitle, LinuxAccountCard.DoneText);
        await StartAfterAccountAsync(null);
    }

    private void ShowDeletionResult(string title, string body)
    {
        deletedLayer.Children.Clear();
        deletedLayer.Children.Add(FormKit.AlertFrame(title, body, () => deletedLayer.IsVisible = false, new AlertChoice("閉じる", Bold: true)));
        deletedLayer.IsVisible = true;
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
