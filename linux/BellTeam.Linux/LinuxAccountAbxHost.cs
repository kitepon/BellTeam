using System.Net.Http;
using Kitepon.ApprovalBox.Client;

namespace BellTeam.Linux;

/// <summary>
/// The Approval Box client of this machine (client-v0.5.md, child-join.md): Kitepon.ApprovalBox.Client, which holds the child join, the v1 adapter, this device's peer-channel session and the switch between them.
/// The device joins as a child (its own key and sign-in, signed requests); there is no pass and no host sign-in. No flag and no environment variable decides what runs: the server's peer_channel does, as it does for the Approval Box app.
/// Linux (x64 has the native engine) and Android share this file.
/// </summary>
internal sealed partial class LinuxApprovalBoxDevice : IAsyncDisposable
{
    /// <summary>The peer engine (libdatachannel) is shipped for x86_64 on Linux only; Android's ABIs carry it.</summary>
    public static bool LinuxHasEngine => System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture == System.Runtime.InteropServices.Architecture.X64;
    internal IApprovalSource Source { get; }
    private readonly ApprovalBoxClient client;

    /// <param name="join">Approval Box's own login-billing form (a folder of its own, the sign-in identifiers, or a host's own form on Android).</param>
    /// <param name="peer">Where the peer adapter keeps its files, or null where this build has no engine (the client then stays on /v1 and says UpdateRequired when /v1 ends).</param>
    /// <param name="roster">The BellTeam members the app holds (the origin rule).</param>
    internal LinuxApprovalBoxDevice(ChildJoinOptions join, IPeerStorage? peer, Func<IReadOnlyList<(string Id, string Name)>> roster, Uri origin, HttpMessageHandler? handler = null)
    {
        client = new ApprovalBoxClient(new ApprovalBoxClientOptions { BaseUri = origin, Join = join, Transport = handler, Peer = peer });
        Source = new ClientApprovalSource(client, roster);
    }

    internal void Attach(ApprovalsHub hub)
    {
        hub.RequestApproval = client.RequestApproval; hub.CancelApproval = client.CancelApproval;
        _ = client.StartAsync();
    }

    // 「アカウントを削除」 (a485): the join goes (a joined device leaves the account; an open sign-in or request is cancelled), then this device's keys, trusted head, history and attachments (when a peer session ever existed).
    // BellTeam's own sign-in is not touched here.
    internal async Task DeleteLocalAsync()
    {
        client.CancelApproval();
        if (client.JoinState.Status == JoinStatus.Joined) await client.LeaveAsync(); else client.CancelJoin();
        await client.StopAsync(); client.DeleteLocalData();
    }

    public ValueTask DisposeAsync() { client.CancelJoin(); return client.DisposeAsync(); }
}
