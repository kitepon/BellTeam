using System.Net.Http;
using BellTeam.Core;
using Kitepon.ApprovalBox.Client;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.App;

/// <summary>
/// Wires the Approval Box account of this PC to the 決裁箱 page (client-v0.5): the second sign-in (login-billing against /auth/v1, its own pass, no purchase) and the one <see cref="ApprovalBoxClient"/> of Kitepon.ApprovalBox.Client
/// (the package reads /v1 now and the peer channel when GET /v1/auth/config says peer_channel; its device files are DPAPI-sealed in <c>directory</c>). Sign-in, sign-out and the screens stay here.
/// </summary>
public sealed class ApprovalBoxDevice : IAsyncDisposable
{
    internal ApprovalBoxAccount Account { get; }
    /// <summary>The one source the page reads (named Device for the 決裁箱 hub).</summary>
    internal ClientApprovalSource Device { get; }
    private readonly ApprovalBoxClient client;
    private ApprovalsHub? hub;
    private CancellationTokenSource? signIn;
    private ApprovalOffer? shownOffer; private string? shownNote;

    public ApprovalBoxDevice(string directory) : this(directory, null) { }
    internal ApprovalBoxDevice(string directory, ApprovalBoxAccount? account, HttpMessageHandler? transport = null)
    {
        Account = account ?? new ApprovalBoxAccount();
        client = new ApprovalBoxClient(new ApprovalBoxClientOptions
        {
            BaseUri = Account.Origin, PassProvider = (_, _) => ValueTask.FromResult(Account.PassHeader()), PassRejected = _ => Account.DropPass(), Transport = Account.Transport(transport),
            Peer = new DpapiPeerStorage(directory, Environment.MachineName)
        });
        Device = new ClientApprovalSource(client);
        client.Changed += OnClientChanged;
    }

    // 4410: the Approval Box account is gone (the package cleared the device files); the pass of this instance goes too. The offer (code, QR) the package shows while a verified device admits this one is the hub's to draw.
    private void OnClientChanged()
    {
        var state = client.State;
        if (state is { Status: ClientStatus.SignedOut, Reason: "account_deleted" }) Account.ClearPass();
        var offer = state.Offer is { } o ? new ApprovalOffer(o.Code, o.QrPayload, o.ExpiresAt) : null;
        var note = state.Status == ClientStatus.NeedsApproval ? state.Note switch { "offer_expired" => Approvals.DeviceApprovalExpired, "offer_failed" => Approvals.DeviceApprovalFailed, _ => null } : null;
        if (offer == shownOffer && note == shownNote) return;
        shownOffer = offer; shownNote = note; hub?.SetOffer(offer, note);
    }

    internal void Attach(ApprovalsHub hub)
    {
        this.hub = hub; hub.SignInApprovalBox = () => _ = SignInAsync(); hub.SignInByHandoff = () => _ = HandoffAsync(); hub.CancelSignIn = () => signIn?.Cancel();
        hub.RequestApproval = client.RequestApproval; hub.CancelApproval = client.CancelApproval;
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

    // a485 「アカウントを削除」: this PC's Approval Box sign-in (the library's signOut reaches the server as far as it can) and the package's device files (keys, registry head, history, attachments); the files go even when the sign-out fails.
    internal async Task DeleteLocalDataAsync(CancellationToken ct)
    {
        signIn?.Cancel(); client.CancelApproval();
        try { await Account.SignOutAsync(ct); } finally { client.DeleteLocalData(); }
    }

    public ValueTask DisposeAsync() { signIn?.Cancel(); return Device.DisposeAsync(); }
}
