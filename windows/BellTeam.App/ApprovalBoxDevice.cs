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
    private CancellationTokenSource? signIn, approve;

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
        hub.RequestApproval = () => _ = RequestApprovalAsync(); hub.CancelApproval = () => approve?.Cancel();
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

    // NeedsApproval -> Waiting: show the code and QR until a verified device admits this one, the 5 minutes pass or the person stops.
    private async Task RequestApprovalAsync()
    {
        if (approve is not null) return;
        var mine = approve = new CancellationTokenSource();
        var admission = Device.NewAdmission();
        hub?.SetOffer(new ApprovalOffer(admission.TypedCode, admission.QrText, admission.ExpiresAt));
        string? note = null;
        try { await Device.AdmitAsync(admission, mine.Token); }
        catch (OperationCanceledException) { }
        catch (AdmissionException error) { note = error.Code == "binding_expired" ? Approvals.DeviceApprovalExpired : Approvals.DeviceApprovalFailed; }
        finally { approve = null; mine.Dispose(); hub?.SetOffer(null, note); }
    }

    // a485 「アカウントを削除」: this PC's Approval Box sign-in (the library's signOut reaches the server as far as it can) and the device's keys, registry head, history and attachments; the files go even when the sign-out fails.
    internal async Task DeleteLocalDataAsync(CancellationToken ct)
    {
        signIn?.Cancel(); approve?.Cancel();
        try { await Account.SignOutAsync(ct); } finally { Device.ClearLocal(); }
    }

    public ValueTask DisposeAsync() { signIn?.Cancel(); approve?.Cancel(); return Device.DisposeAsync(); }
}
