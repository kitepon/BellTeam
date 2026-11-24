using System.Net.Http;
using Kitepon.ApprovalBox.Client;

namespace BellTeam.Linux;

/// <summary>The second, foreign login-library instance as the Approval Box client needs it: Linux (Desktop library) and Android (Android library) each implement it; nothing of the BellTeam sign-in is shared.</summary>
internal interface IApprovalBoxAccount
{
    /// <summary>Approval Box's origin (scheme and host): where /v1 and /pc/v1 are.</summary>
    Uri Origin { get; }
    /// <summary>The Authorization value for the Approval Box origin, or null when not signed in (the component's SignedOut state).</summary>
    string? PassHeader();
    /// <summary>K of the Approval Box account, for a first registry only.</summary>
    Task<string> AccountAsync(CancellationToken ct);
    Task SignInAsync(CancellationToken ct);
    Task SignOutAsync(CancellationToken ct);
    void ClearPass();
    /// <summary>True when the error is the library's own; then <paramref name="note"/> is its words (null: say nothing, the person's own choice).</summary>
    bool TryDescribe(Exception error, out string? note);
}

/// <summary>
/// The Approval Box client of this machine (client-v0.5.md): the foreign second sign-in (<see cref="IApprovalBoxAccount"/>) and Kitepon.ApprovalBox.Client, which holds the v1 adapter, this device's peer-channel session and the switch between them.
/// No flag and no environment variable decides what runs: the server's peer_channel does, as it does for the Approval Box app. Linux (x64 has the native engine) and Android share this file.
/// </summary>
internal sealed partial class LinuxApprovalBoxDevice : IAsyncDisposable
{
    /// <summary>The peer engine (libdatachannel) is shipped for x86_64 on Linux only; Android's ABIs carry it.</summary>
    public static bool LinuxHasEngine => System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture == System.Runtime.InteropServices.Architecture.X64;
    internal IApprovalBoxAccount Account { get; }
    internal IApprovalSource Source { get; }
    private readonly ApprovalBoxClient client;
    private ApprovalsHub? hub;
    private CancellationTokenSource? signIn;

    /// <param name="peer">Where the peer adapter keeps its files, or null where this build has no engine (the client then stays on /v1 and says UpdateRequired when /v1 ends).</param>
    /// <param name="roster">The BellTeam members the app holds (the origin rule).</param>
    internal LinuxApprovalBoxDevice(IApprovalBoxAccount account, IPeerStorage? peer, Func<IReadOnlyList<(string Id, string Name)>> roster, HttpMessageHandler? handler = null)
    {
        Account = account;
        client = new ApprovalBoxClient(new ApprovalBoxClientOptions
        {
            BaseUri = account.Origin, PassProvider = (_, _) => ValueTask.FromResult(account.PassHeader()), PassRejected = _ => account.ClearPass(),
            Transport = handler, Peer = peer, AccountProvider = account.AccountAsync,
        });
        // 4410: the Approval Box account is gone; the component cleared the device files, the pass of this instance goes too.
        client.Changed += () => { if (client.State is { Status: ClientStatus.SignedOut, Reason: "account_deleted" }) account.ClearPass(); };
        Source = new ClientApprovalSource(client, roster);
    }

    internal void Attach(ApprovalsHub hub)
    {
        this.hub = hub; hub.SignInApprovalBox = () => _ = SignInAsync(); hub.CancelSignIn = () => signIn?.Cancel(); hub.SignOutApprovalBox = () => _ = SignOutAsync();
        hub.RequestApproval = client.RequestApproval; hub.CancelApproval = client.CancelApproval;
        _ = client.StartAsync();
    }

    private async Task SignInAsync()
    {
        if (signIn is not null) return;
        var mine = signIn = new CancellationTokenSource(); hub?.SetSignIn(true);
        string? note = null;
        try { await Account.SignInAsync(mine.Token); await client.RetryNowAsync(); }   // the switch is read again after every sign-in
        catch (OperationCanceledException) { }
        catch (Exception error) when (Account.TryDescribe(error, out note)) { }   // signin_cancelled says nothing (the person's own choice)
        finally { signIn = null; mine.Dispose(); hub?.SetSignIn(false, note); }
    }

    // 「Approval Boxからサインアウト」: the Approval Box pass goes and the client closes (the list of the account that left goes with it); BellTeam's own sign-in is untouched.
    // A sign-out that fails throws and the library keeps the pass, so pressing again finishes it.
    private async Task SignOutAsync()
    {
        try { await Account.SignOutAsync(CancellationToken.None); } catch (Exception error) when (Account.TryDescribe(error, out _)) { return; }
        await client.StopAsync(); await client.StartAsync();
    }

    // 「アカウントを削除」 (a485): this device's keys, trusted head, history and attachments go (when a peer session ever existed), then the Approval Box sign-out; the Approval Box account itself is not deleted.
    // A sign-out that fails throws and the library keeps the pass, so pressing the button again finishes it.
    internal async Task DeleteLocalAsync()
    {
        signIn?.Cancel(); client.CancelApproval();
        await client.StopAsync(); client.DeleteLocalData();
        await Account.SignOutAsync(CancellationToken.None);
    }

    public ValueTask DisposeAsync() { signIn?.Cancel(); return client.DisposeAsync(); }
}
