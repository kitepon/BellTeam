using BellTeam.Core;
using System.Net.Http;
using System.Text.Json;
using BellTeam.PeerChannel;

namespace BellTeam.Linux;

/// <summary>The second, foreign login-library instance as the device part needs it: Linux (Desktop library) and Android (Android library) each implement it; nothing of the BellTeam sign-in is shared.</summary>
internal interface IApprovalBoxAccount
{
    /// <summary>Approval Box's origin (scheme and host): where /v1 and /v1/auth/config are.</summary>
    Uri Origin { get; }
    Task<ServerAccess> AccessAsync(CancellationToken ct);
    Task<string> AccountAsync(CancellationToken ct);
    Task SignInAsync(CancellationToken ct);
    Task SignOutAsync(CancellationToken ct);
    void ClearPass();
    /// <summary>True when the error is the library's own; then <paramref name="note"/> is its words (null: say nothing, the person's own choice).</summary>
    bool TryDescribe(Exception error, out string? note);
}

/// <summary>
/// The Approval Box client of this machine (client-v0.5.md): the foreign second sign-in (<see cref="IApprovalBoxAccount"/>), the v1 adapter (Approval Box's /v1, now), this device's peer-channel session
/// (the peer adapter, created and started only when the server's <c>GET /v1/auth/config</c> says peer_channel and this build has the engine) and the switch between them (<see cref="SelectedApprovalSource"/>).
/// No flag and no environment variable decides what runs: the server does, as it does for the Approval Box app. Linux (x64 has the native engine) and Android share this file.
/// </summary>
internal sealed partial class LinuxApprovalBoxDevice : IAsyncDisposable
{
    /// <summary>The peer engine (libdatachannel) is shipped for x86_64 on Linux only; Android passes true (its ABIs carry it).</summary>
    public static bool LinuxHasEngine => System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture == System.Runtime.InteropServices.Architecture.X64;
    internal IApprovalBoxAccount Account { get; }
    private readonly string directory, platform; private readonly bool hasEngine;
    private LinuxDeviceApprovals? device; private bool peerStarted;
    private readonly ApprovalBoxV1Source v1; private readonly HttpClient config = new() { Timeout = TimeSpan.FromSeconds(15) };
    internal SelectedApprovalSource Source { get; }
    private ApprovalsHub? hub;
    private CancellationTokenSource? signIn, approve;

    // platform: what the registry records for this device (Android shares this part and passes "android"). roster: the BellTeam members the app holds (the origin rule).
    internal LinuxApprovalBoxDevice(string directory, IApprovalBoxAccount account, Func<IReadOnlyList<(string Id, string Name)>> roster, bool hasEngine, string platform = "linux", HttpMessageHandler? handler = null)
    {
        Account = account; this.directory = directory; this.platform = platform; this.hasEngine = hasEngine;
        v1 = new ApprovalBoxV1Source(Account.AccessAsync, roster, handler) { PassEnded = Account.ClearPass };
        Source = new SelectedApprovalSource(v1, StartPeer, PeerChannelAsync);
    }

    /// <summary>The peer session, made on first use (its keys are written then, not before).</summary>
    internal LinuxDeviceApprovals Device
    {
        get
        {
            if (device is not null) return device;
            device = new LinuxDeviceApprovals(directory, Account.AccessAsync, Account.AccountAsync, Environment.MachineName, platform);
            // 4410: the Approval Box account is gone; DeviceApprovals cleared the device keys, the pass of this instance goes too.
            device.Runtime.StateChanged += () => { if (device.State is { Status: RuntimeStatus.SignedOut, Reason: "account_deleted" }) Account.ClearPass(); };
            return device;
        }
    }

    private IApprovalSource? StartPeer()
    {
        if (!hasEngine) return null;
        if (peerStarted) Device.Refresh(); else { peerStarted = true; Device.Start(); }
        return new PeerSource(Device);
    }

    // true / false = peer_channel; null = the read failed (the adapter in use stays). The route needs no pass.
    private async Task<bool?> PeerChannelAsync(CancellationToken ct)
    {
        try
        {
            using var reply = await config.GetAsync(new Uri(Account.Origin.GetLeftPart(UriPartial.Authority) + "/v1/auth/config"), ct);
            if (!reply.IsSuccessStatusCode) return null;
            using var json = JsonDocument.Parse(await reply.Content.ReadAsStringAsync(ct));
            return json.RootElement.TryGetProperty("peer_channel", out var flag) && flag.ValueKind == JsonValueKind.True;   // absent = false
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or JsonException) { return null; }
    }

    internal void Attach(ApprovalsHub hub)
    {
        this.hub = hub; hub.SignInApprovalBox = () => _ = SignInAsync(); hub.CancelSignIn = () => signIn?.Cancel(); hub.SignOutApprovalBox = () => _ = SignOutAsync();
        hub.RequestApproval = () => _ = RequestApprovalAsync(); hub.CancelApproval = () => approve?.Cancel();
        Source.Start();
    }

    private async Task SignInAsync()
    {
        if (signIn is not null) return;
        var mine = signIn = new CancellationTokenSource(); hub?.SetSignIn(true);
        string? note = null;
        try { await Account.SignInAsync(mine.Token); Source.Refresh(); }   // the switch is read again after every sign-in
        catch (OperationCanceledException) { }
        catch (Exception error) when (Account.TryDescribe(error, out note)) { }   // signin_cancelled says nothing (the person's own choice)
        finally { signIn = null; mine.Dispose(); hub?.SetSignIn(false, note); }
    }

    // 「Approval Boxからサインアウト」: the Approval Box pass goes; BellTeam's own sign-in is untouched. A sign-out that fails throws and the library keeps the pass, so pressing again finishes it.
    private async Task SignOutAsync()
    {
        try { await Account.SignOutAsync(CancellationToken.None); } catch (Exception error) when (Account.TryDescribe(error, out _)) { return; }
        Source.Refresh();
    }

    // NeedsApproval -> Waiting (peer only): show the code and QR until a verified device admits this one, the 5 minutes pass or the person stops.
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

    // 「アカウントを削除」 (a485): this device's keys, trusted head, history and attachments go (when a peer session ever existed), then the Approval Box sign-out; the Approval Box account itself is not deleted.
    // A sign-out that fails throws and the library keeps the pass, so pressing the button again finishes it.
    internal async Task DeleteLocalAsync()
    {
        signIn?.Cancel(); approve?.Cancel(); v1.Park();
        if (device is not null) { await device.DisposeAsync(); device.ClearLocal(); }
        await Account.SignOutAsync(CancellationToken.None);
    }

    public ValueTask DisposeAsync() { signIn?.Cancel(); approve?.Cancel(); v1.Dispose(); config.Dispose(); return device is null ? ValueTask.CompletedTask : device.DisposeAsync(); }
}
