using System.Net.Http;
using System.Text.Json;
using BellTeam.PeerChannel;

namespace BellTeam.App;

/// <summary>
/// The one switch of the 決裁箱 (client-v0.5 5.3, owned by Approval Box): GET /v1/auth/config says peer_channel; true -> the pc/1 core (<see cref="DeviceApprovals"/>), false or absent -> <see cref="V1ApprovalSource"/>.
/// Read at start, at every retry (while the source is Retrying) and after a sign-in (the hub calls <see cref="Refresh"/>). A read that fails keeps the adapter in use, and picks /v1 when none is. The pc/1 core is built and started only when the answer is true;
/// no local flag, no environment switch. The page sees one <see cref="IApprovalSource"/>.
/// </summary>
internal sealed class ApprovalSelector(Func<IApprovalSource> makeV1, Func<IApprovalSource> makePeer, Func<CancellationToken, Task<bool?>> readPeerChannel, Func<TimeSpan, CancellationToken, Task>? delay = null) : IApprovalSource, IAsyncDisposable
{
    private readonly SemaphoreSlim one = new(1, 1);
    private readonly Func<TimeSpan, CancellationToken, Task> wait = delay ?? Task.Delay;
    private readonly CancellationTokenSource life = new();
    private IApprovalSource? active; private bool activeIsPeer, retryLoop;
    public event Action? Changed;

    /// <summary>Which adapter is in use (null before the first read).</summary>
    internal string? Adapter => active is null ? null : activeIsPeer ? "peer" : "v1";
    /// <summary>The pc/1 core while it is the adapter in use (the admission flow of NeedsApproval is its own), else null.</summary>
    internal DeviceApprovals? Peer => active as DeviceApprovals;
    public RuntimeState State => active?.State ?? new(RuntimeStatus.Connecting);
    public IReadOnlyList<ViewDecision> Decisions => active?.Decisions ?? [];

    public void Start() => _ = SelectAsync(refresh: false);
    /// <summary>retryNow: reads the switch again, then tries the adapter in use at once.</summary>
    public void Refresh() => _ = SelectAsync(refresh: true);
    public Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text, long version) => active?.AnswerAsync(decisionId, optionId, text, version) ?? Task.FromResult(new SendOutcome("no_session"));
    public Task<SendOutcome> HoldAsync(string decisionId, bool held) => active?.HoldAsync(decisionId, held) ?? Task.FromResult(new SendOutcome("no_session"));
    public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => active?.AttachmentAsync(decisionId, attachmentId) ?? Task.FromResult<byte[]?>(null);

    private async Task SelectAsync(bool refresh)
    {
        await one.WaitAsync(life.Token);
        try
        {
            bool? peerChannel;
            try { peerChannel = await readPeerChannel(life.Token); } catch (Exception error) when (error is HttpRequestException or TimeoutException or JsonException || error is OperationCanceledException && !life.IsCancellationRequested) { peerChannel = null; }
            var wantPeer = peerChannel ?? (active is not null && activeIsPeer);
            if (active is null || activeIsPeer != wantPeer)
            {
                var old = active; active = null;
                if (old is not null) { old.Changed -= OnActive; if (old is IAsyncDisposable disposable) await disposable.DisposeAsync(); }
                var next = wantPeer ? makePeer() : makeV1();
                active = next; activeIsPeer = wantPeer; next.Changed += OnActive; next.Start(); Changed?.Invoke();
            }
            else if (refresh) active.Refresh();
        }
        finally { one.Release(); }
    }

    private void OnActive()
    {
        Changed?.Invoke();
        if (State.Status == RuntimeStatus.Retrying && !retryLoop) { retryLoop = true; _ = ReadWhileRetryingAsync(); }
    }
    // The switch is read again at every retry: while the source cannot reach its server, ask the config each 10 s (Approval Box may have moved).
    private async Task ReadWhileRetryingAsync()
    {
        try
        {
            while (State.Status == RuntimeStatus.Retrying && !life.IsCancellationRequested) { await wait(TimeSpan.FromSeconds(10), life.Token); if (State.Status == RuntimeStatus.Retrying) await SelectAsync(refresh: false); }
        }
        catch (OperationCanceledException) { }
        finally { retryLoop = false; }
    }

    public async ValueTask DisposeAsync()
    {
        life.Cancel(); var old = active; active = null;
        if (old is not null) { old.Changed -= OnActive; if (old is IAsyncDisposable disposable) await disposable.DisposeAsync(); }
    }
}
