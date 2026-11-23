using BellTeam.Core;
using BellTeam.PeerChannel;

namespace BellTeam.Linux;

/// <summary>The second, foreign login-library instance as the device part needs it: Linux (Desktop library) and Android (Android library) each implement it; nothing of the BellTeam sign-in is shared.</summary>
internal interface IApprovalBoxAccount
{
    Task<ServerAccess> AccessAsync(CancellationToken ct);
    Task<string> AccountAsync(CancellationToken ct);
    Task SignInAsync(CancellationToken ct);
    Task SignOutAsync(CancellationToken ct);
    void ClearPass();
    /// <summary>True when the error is the library's own; then <paramref name="note"/> is its words (null: say nothing, the person's own choice).</summary>
    bool TryDescribe(Exception error, out string? note);
}

/// <summary>
/// Wires the Approval Box device of this Linux PC (port of the Windows ApprovalBoxDevice) (peer-channel-signin.md): the foreign second sign-in, the device session and the 決裁箱 page.
/// Off unless BELLTEAM_APPROVAL_BOX_DEVICE=1 (shortcut: the go-live ruling of Delta and Nayuta is not given yet; then the product decides, not an environment variable).
/// </summary>
internal sealed partial class LinuxApprovalBoxDevice : IAsyncDisposable
{
    // x64 only: the native engine (linux/native) is built for x86_64.
    public static bool Enabled => Environment.GetEnvironmentVariable("BELLTEAM_APPROVAL_BOX_DEVICE") == "1" && System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture == System.Runtime.InteropServices.Architecture.X64;
    internal IApprovalBoxAccount Account { get; }
    internal LinuxDeviceApprovals Device { get; }
    private ApprovalsHub? hub;
    private CancellationTokenSource? signIn, approve;

    // platform: what the registry records for this device (Android shares this part and passes "android").
    internal LinuxApprovalBoxDevice(string directory, IApprovalBoxAccount account, string platform = "linux")
    {
        Account = account;
        Device = new LinuxDeviceApprovals(directory, Account.AccessAsync, Account.AccountAsync, Environment.MachineName, platform);
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
        try { await Account.SignInAsync(mine.Token); Device.Refresh(); }
        catch (OperationCanceledException) { }
        catch (Exception error) when (Account.TryDescribe(error, out note)) { }   // signin_cancelled says nothing (the person's own choice)
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

    // 「アカウントを削除」 (a485): this device's keys, trusted head, history and attachments go, then the Approval Box sign-out; the Approval Box account itself is not deleted. A sign-out that fails
    // throws and the library keeps the pass, so pressing the button again finishes it.
    internal async Task DeleteLocalAsync()
    {
        signIn?.Cancel(); approve?.Cancel();
        await Device.DisposeAsync();
        Device.ClearLocal();
        await Account.SignOutAsync(CancellationToken.None);
    }

    public ValueTask DisposeAsync() { signIn?.Cancel(); approve?.Cancel(); return Device.DisposeAsync(); }
}
