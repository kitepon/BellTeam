using System.Net.Http;
using BellTeam.PeerChannel;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.App;

/// <summary>
/// Wires the Approval Box account of this PC to the 決裁箱 page (client-v0.5): the second sign-in (login-billing against /auth/v1, its own pass, no purchase) and the one <see cref="ApprovalSelector"/> that reads /v1 now and the pc/1 core (peer-channel-signin.md)
/// when GET /v1/auth/config says peer_channel. Always on: the old environment switch BELLTEAM_APPROVAL_BOX_DEVICE is gone, the selector decides.
/// </summary>
public sealed class ApprovalBoxDevice : IAsyncDisposable
{
    internal ApprovalBoxAccount Account { get; }
    /// <summary>The one source the page reads (named Device for the 決裁箱 hub; it is the selector).</summary>
    internal ApprovalSelector Device { get; }
    private readonly string directory;
    private ApprovalsHub? hub;
    private CancellationTokenSource? signIn, approve;

    public ApprovalBoxDevice(string directory) : this(directory, null) { }
    internal ApprovalBoxDevice(string directory, ApprovalBoxAccount? account, HttpMessageHandler? transport = null)
    {
        this.directory = directory; Account = account ?? new ApprovalBoxAccount();
        Device = new ApprovalSelector(
            () => new V1ApprovalSource(Account.CreateV1Client(transport), () => Account.SignedIn, Account.DropPass),
            CreatePeer,
            ct => Account.ReadPeerChannelAsync(transport, ct));
    }

    // Built only when the switch says peer_channel: the keys, the registry head and the history of this device are made now, never before.
    private IApprovalSource CreatePeer()
    {
        var peer = new DeviceApprovals(directory, Account.AccessAsync, Account.AccountAsync, Environment.MachineName);
        // 4410: the Approval Box account is gone; DeviceApprovals cleared the device keys, the pass of this instance goes too.
        peer.Runtime.StateChanged += () => { if (peer.State is { Status: RuntimeStatus.SignedOut, Reason: "account_deleted" }) Account.ClearPass(); };
        return peer;
    }

    internal void Attach(ApprovalsHub hub)
    {
        this.hub = hub; hub.SignInApprovalBox = () => _ = SignInAsync(); hub.SignInByHandoff = () => _ = HandoffAsync(); hub.CancelSignIn = () => signIn?.Cancel();
        hub.RequestApproval = () => _ = RequestApprovalAsync(); hub.CancelApproval = () => approve?.Cancel();
        Device.Start();
    }

    private async Task SignInAsync()
    {
        if (signIn is not null) return;
        var mine = signIn = new CancellationTokenSource(); hub?.SetSignIn(true);
        string? note = null;
        try { await Account.SignInAsync(AccountStore.Providers[0], mine.Token); Device.Refresh(); }   // the switch is read again after every sign-in
        catch (OperationCanceledException) { }
        catch (LoginBillingException error) { note = AccountView.Describe(error); }   // signin_cancelled says nothing (the person's own choice)
        finally { signIn = null; mine.Dispose(); hub?.SetSignIn(false, note); }
    }

    // Sign in by handoff: the QR is shown until the phone's Approval Box app approves, the pass comes back, the code expires or the person stops.
    private async Task HandoffAsync()
    {
        if (signIn is not null) return;
        var mine = signIn = new CancellationTokenSource(); hub?.SetSignIn(true);
        string? note = null;
        try
        {
            if (await Account.StartHandoffAsync(Environment.MachineName, mine.Token) is not { } start) { Device.Refresh(); return; }   // no QR is needed: the pass is already there
            hub?.SetHandoff(new ApprovalHandoff(start.QrPayload, start.ShortCode, start.CheckNumber, start.ExpiresAt));
            await Account.WaitForHandoffAsync(mine.Token); Device.Refresh();
        }
        catch (OperationCanceledException) { }
        catch (LoginBillingException error) { note = AccountView.Describe(error); }
        finally { signIn = null; mine.Dispose(); hub?.SetHandoff(null); hub?.SetSignIn(false, note); }
    }

    // NeedsApproval -> Waiting (pc/1 core only): show the code and QR until a verified device admits this one, the 5 minutes pass or the person stops.
    private async Task RequestApprovalAsync()
    {
        if (approve is not null || Device.Peer is not { } peer) return;
        var mine = approve = new CancellationTokenSource();
        var admission = peer.NewAdmission();
        hub?.SetOffer(new ApprovalOffer(admission.TypedCode, admission.QrText, admission.ExpiresAt));
        string? note = null;
        try { await peer.AdmitAsync(admission, mine.Token); }
        catch (OperationCanceledException) { }
        catch (AdmissionException error) { note = error.Code == "binding_expired" ? Approvals.DeviceApprovalExpired : Approvals.DeviceApprovalFailed; }
        finally { approve = null; mine.Dispose(); hub?.SetOffer(null, note); }
    }

    // a485 「アカウントを削除」: this PC's Approval Box sign-in (the library's signOut reaches the server as far as it can) and the pc/1 files (keys, registry head, history, attachments); the files go even when the sign-out fails.
    internal async Task DeleteLocalDataAsync(CancellationToken ct)
    {
        signIn?.Cancel(); approve?.Cancel();
        try { await Account.SignOutAsync(ct); } finally { DeviceApprovals.ClearLocalFiles(directory, strict: true); }
    }

    public ValueTask DisposeAsync() { signIn?.Cancel(); approve?.Cancel(); return Device.DisposeAsync(); }
}
