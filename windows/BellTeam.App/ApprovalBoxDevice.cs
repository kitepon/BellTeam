using System.Diagnostics;
using System.IO;
using System.Net.Http;
using BellTeam.Core;
using Kitepon.ApprovalBox.Client;

namespace BellTeam.App;

/// <summary>
/// Wires the 決裁箱 page of this PC to the one <see cref="ApprovalBoxClient"/> of Kitepon.ApprovalBox.Client 0.5.2 (client-component section 9, child-join.md): this PC joins the Owner's Approval Box as a CHILD device,
/// signed with its own key (the component's Desktop form: Windows CNG key and kept sign-in under <c>approval-box-child</c>, apart from BellTeam's own login-billing stores and from the device history); the package reads /v1 now and the peer channel when
/// GET /v1/auth/config says peer_channel. The join (<see cref="IChildJoin"/>) and the screens stay here; no pass, no lbq1 handoff, no PassProvider.
/// </summary>
public sealed class ApprovalBoxDevice : IAsyncDisposable
{
    internal const string ProductOrigin = "https://approval-box.kitepon.dev";
    /// <summary>The one source the page reads (named Device for the 決裁箱 hub).</summary>
    internal ClientApprovalSource Device { get; }
    internal IChildJoin Join { get; }
    private readonly ApprovalBoxClient client;
    private ApprovalsHub? hub;
    private ApprovalOffer? shownOffer; private string? shownNote;
    private bool wasJoined;

    public ApprovalBoxDevice(string directory) : this(directory, null) { }
    /// <param name="origin">Development runs point it at approval-box's local dev server (BELLTEAM_APPROVAL_BOX_URL).</param>
    internal ApprovalBoxDevice(string directory, string? origin, HttpMessageHandler? transport = null, Func<Uri, Task>? openBrowser = null, string? stateDirectory = null)
    {
        client = new ApprovalBoxClient(new ApprovalBoxClientOptions
        {
            BaseUri = new Uri((origin ?? Environment.GetEnvironmentVariable("BELLTEAM_APPROVAL_BOX_URL") ?? ProductOrigin).TrimEnd('/')), Transport = transport,
            Peer = new DpapiPeerStorage(directory, Environment.MachineName),
            Join = new ChildJoinOptions
            {
                StateDirectory = stateDirectory ?? Path.Combine(directory, "approval-box-child"),
                // The sign-in runs in this process, so the identifiers are BellTeam's own (the same Google and Apple clients as BellTeam's sign-in); the parent verifies the token against its own audiences.
                Audiences = [.. LocalFormIds.GoogleClientIds, LocalFormIds.AppleBundleId, LocalFormIds.AppleServicesId],
                GoogleClientId = LocalFormIds.GoogleDesktopClientId, GoogleClientSecret = LocalFormConfig.GoogleSecret,
                AppleServicesId = LocalFormIds.AppleServicesId, AppleReturnUrl = LocalFormIds.AppleReturnUrl,
                OpenBrowser = openBrowser, Log = line => Trace.WriteLine("approval-box-child: " + line),
            },
        });
        Device = new ClientApprovalSource(client); Join = new ClientChildJoin(client);
        wasJoined = client.JoinState.Status == JoinStatus.Joined;
        client.Changed += OnClientChanged;
    }

    // The offer (code, QR) the package shows while a verified device admits this one (the peer channel) is the hub's to draw. A join that just completed starts the reads (the package's start() after joined).
    private void OnClientChanged()
    {
        var joined = client.JoinState.Status == JoinStatus.Joined;
        if (joined && !wasJoined) _ = client.StartAsync();
        wasJoined = joined;
        var state = client.State;
        var offer = state.Offer is { } o ? new ApprovalOffer(o.Code, o.QrPayload, o.ExpiresAt) : null;
        var note = state.Status == ClientStatus.NeedsApproval ? state.Note switch { "offer_expired" => Approvals.DeviceApprovalExpired, "offer_failed" => Approvals.DeviceApprovalFailed, _ => null } : null;
        if (offer == shownOffer && note == shownNote) return;
        shownOffer = offer; shownNote = note; hub?.SetOffer(offer, note);
    }

    internal void Attach(ApprovalsHub hub)
    {
        this.hub = hub; hub.SetJoin(Join);
        hub.RequestApproval = client.RequestApproval; hub.CancelApproval = client.CancelApproval;
        Device.Start();
    }

    // a485 「アカウントを削除」: this PC leaves the Owner's Approval Box (the key goes, whatever the server answers) and the package's device files go (keys, registry head, history, attachments); the files go even when leaving fails.
    internal async Task DeleteLocalDataAsync(CancellationToken ct)
    {
        Join.CancelJoin(); client.CancelApproval();
        try { if (Join.Phase == ChildJoinPhase.Joined) await Join.LeaveAsync(); } finally { client.DeleteLocalData(); }
    }

    public ValueTask DisposeAsync() { Join.CancelJoin(); return Device.DisposeAsync(); }
}
