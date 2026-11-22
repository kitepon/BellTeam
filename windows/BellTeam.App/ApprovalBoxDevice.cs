using BellTeam.PeerChannel;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.App;

/// <summary>
/// Wires the Approval Box device of this PC (peer-channel-signin.md): the foreign second sign-in, the device session and the 決裁箱 page.
/// Off unless BELLTEAM_APPROVAL_BOX_DEVICE=1 (shortcut: the go-live ruling of Delta and Nayuta is not given yet; then the product decides, not an environment variable).
/// </summary>
public sealed class ApprovalBoxDevice : IAsyncDisposable
{
    public static bool Enabled => Environment.GetEnvironmentVariable("BELLTEAM_APPROVAL_BOX_DEVICE") == "1";
    internal ApprovalBoxAccount Account { get; }
    internal DeviceApprovals Device { get; }
    private ApprovalsHub? hub;
    private CancellationTokenSource? signIn;

    public ApprovalBoxDevice(string directory) : this(directory, null) { }
    internal ApprovalBoxDevice(string directory, ApprovalBoxAccount? account)
    {
        Account = account ?? new ApprovalBoxAccount();
        Device = new DeviceApprovals(directory, Account.AccessAsync, Account.AccountAsync, Environment.MachineName);
        // 4410: the Approval Box account is gone; DeviceApprovals cleared the device keys, the pass of this instance goes too.
        Device.Runtime.StateChanged += () => { if (Device.State is { Status: RuntimeStatus.SignedOut, Reason: "account_deleted" }) Account.ClearPass(); };
    }

    internal void Attach(ApprovalsHub hub)
    {
        this.hub = hub; hub.SignInApprovalBox = () => _ = SignInAsync(); hub.CancelSignIn = () => signIn?.Cancel();
        Device.Start();
    }

    private async Task SignInAsync()
    {
        if (signIn is not null) return;
        var mine = signIn = new CancellationTokenSource(); hub?.SetSignIn(true);
        string? note = null;
        try { await Account.SignInAsync(AccountStore.Providers[0], mine.Token); Device.Refresh(); }
        catch (OperationCanceledException) { }
        catch (LoginBillingException error) { note = AccountView.Describe(error); }   // signin_cancelled says nothing (the person's own choice)
        finally { signIn = null; mine.Dispose(); hub?.SetSignIn(false, note); }
    }

    public ValueTask DisposeAsync() { signIn?.Cancel(); return Device.DisposeAsync(); }
}
