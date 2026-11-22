using BellTeam.Core;
using BellTeam.PeerChannel;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.Linux;

/// <summary>
/// Wires the Approval Box device of this Linux PC (port of the Windows ApprovalBoxDevice) (peer-channel-signin.md): the foreign second sign-in, the device session and the 決裁箱 page.
/// Off unless BELLTEAM_APPROVAL_BOX_DEVICE=1 (shortcut: the go-live ruling of Delta and Nayuta is not given yet; then the product decides, not an environment variable).
/// </summary>
internal sealed class LinuxApprovalBoxDevice : IAsyncDisposable
{
    // x64 only: the native engine (linux/native) is built for x86_64.
    public static bool Enabled => Environment.GetEnvironmentVariable("BELLTEAM_APPROVAL_BOX_DEVICE") == "1" && System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture == System.Runtime.InteropServices.Architecture.X64;
    internal LinuxApprovalBoxAccount Account { get; }
    internal LinuxDeviceApprovals Device { get; }
    private ApprovalsHub? hub;
    private CancellationTokenSource? signIn, approve;

    public LinuxApprovalBoxDevice(string directory) : this(directory, null) { }
    internal LinuxApprovalBoxDevice(string directory, LinuxApprovalBoxAccount? account)
    {
        Account = account ?? new LinuxApprovalBoxAccount();
        Device = new LinuxDeviceApprovals(directory, Account.AccessAsync, Account.AccountAsync, Environment.MachineName);
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
        try { await Account.SignInAsync("google", mine.Token); Device.Refresh(); }
        catch (OperationCanceledException) { }
        catch (LoginBillingException error) { note = LinuxApprovalBoxDevice.Describe(error); }   // signin_cancelled says nothing (the person's own choice)
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

    // 「アカウントを削除」 (a485): this device's Approval Box sign-in, keys, trusted head, history and attachments go; the Approval Box account itself is not deleted. The sign-out call is best effort
    // (the person may be offline): the pass file goes either way.
    internal async Task DeleteLocalAsync()
    {
        signIn?.Cancel(); approve?.Cancel();
        try { await Account.SignOutAsync(CancellationToken.None); } catch (LoginBillingException) { }
        Account.ClearPass();
        await Device.DisposeAsync();
        Device.ClearLocal();
    }

    // The words of a failed sign-in; signin_cancelled says nothing (the person's own choice).
    internal static string? Describe(LoginBillingException error) => error.Code == "signin_cancelled" ? null : StoreAccountText.Failure(error.Code, error.Status);

    public ValueTask DisposeAsync() { signIn?.Cancel(); approve?.Cancel(); return Device.DisposeAsync(); }
}
