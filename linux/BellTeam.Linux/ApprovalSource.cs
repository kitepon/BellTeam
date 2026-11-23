using BellTeam.Core;
using BellTeam.PeerChannel;

namespace BellTeam.Linux;

/// <summary>
/// The one thing the 決裁箱 screen reads and answers through (client-v0.5.md 5.1): the decisions as the screen draws them, the connection state, answer, hold, the bytes of an attachment, retry.
/// Two adapters stand behind it: <see cref="ApprovalBoxV1Source"/> (Approval Box's /v1, now) and <see cref="PeerSource"/> (this device's /pc/v1 session, only when the server says peer_channel). The screen never names a route.
/// </summary>
internal interface IApprovalSource
{
    /// <summary>The open list and the recent answered/cancelled ones; each already carries its origin (links are joined by the hub).</summary>
    IReadOnlyList<ViewDecision> Decisions { get; }
    /// <summary>Stopped with Reason "update_needed" = the server moved to /pc/v1 and this build has no engine for it.</summary>
    RuntimeState State { get; }
    /// <summary>The list or the state changed (any thread).</summary>
    event Action? Changed;
    /// <summary>version = the version of the decision the person is looking at (the v1 adapter sends it; a newer one answers refused:stale_version).</summary>
    Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text, long version);
    Task<SendOutcome> HoldAsync(string decisionId, bool held);
    /// <summary>「今すぐ試す」 / 「確かめ直す」: runs the waiting attempt now (never a second copy of it).</summary>
    void Refresh();
    Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId);
}

/// <summary>The peer adapter: this device's /pc/v1 session (<see cref="IDeviceDecisions"/>) behind the port.</summary>
internal sealed class PeerSource(IDeviceDecisions device) : IApprovalSource
{
    public IReadOnlyList<ViewDecision> Decisions => [.. device.Book.All.Select(DeviceDecisionView.Of)];
    public RuntimeState State => device.State;
    public event Action? Changed { add => device.Changed += value; remove => device.Changed -= value; }
    public Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text, long version) => device.AnswerAsync(decisionId, optionId, text);
    public Task<SendOutcome> HoldAsync(string decisionId, bool held) => device.HoldAsync(decisionId, held);
    public void Refresh() => device.Refresh();
    public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => device.AttachmentAsync(decisionId, attachmentId);
}

/// <summary>
/// The switch (client-v0.5.md 5.3): reads GET /v1/auth/config at start, at every retry and after every sign-in. peer_channel true -> the peer adapter, false or absent -> v1; a failed read keeps the adapter in use (v1 if none).
/// No BellTeam flag decides it: the server does, the same rule the Approval Box app follows.
/// </summary>
internal sealed class SelectedApprovalSource : IApprovalSource
{
    private readonly ApprovalBoxV1Source v1; private readonly Func<IApprovalSource?> peer; private readonly Func<CancellationToken, Task<bool?>> peerChannel;
    private IApprovalSource? current; private bool peerOn;
    private readonly SemaphoreSlim reading = new(1, 1);
    private static readonly RuntimeState UpdateNeeded = new(RuntimeStatus.Stopped, "update_needed");

    /// <param name="peer">The peer adapter, or null where this build has no engine for it (it is created only when the server asks for it).</param>
    /// <param name="peerChannel">true / false = the server's peer_channel; null = unreadable.</param>
    internal SelectedApprovalSource(ApprovalBoxV1Source v1, Func<IApprovalSource?> peer, Func<CancellationToken, Task<bool?>> peerChannel)
    {
        this.v1 = v1; this.peer = peer; this.peerChannel = peerChannel;
        v1.Changed += () => { if (current is null || ReferenceEquals(current, v1)) Changed?.Invoke(); };
        v1.BeforeAttempt = async ct => { await SelectAsync(ct); return !peerOn; };
    }

    public event Action? Changed;
    public IReadOnlyList<ViewDecision> Decisions => peerOn && current is null ? [] : (current ?? v1).Decisions;
    public RuntimeState State => peerOn && current is null ? UpdateNeeded : (current ?? v1).State;

    internal void Start() { current = v1; v1.Start(); }

    /// <summary>One read of the switch. Single flight: a read already running is the answer.</summary>
    internal async Task SelectAsync(CancellationToken ct)
    {
        if (!await reading.WaitAsync(0, ct)) return;
        try
        {
            if (await peerChannel(ct) is not { } wanted || wanted == peerOn) return;
            peerOn = wanted;
            if (wanted)
            {
                v1.Park(); current = peer();
                if (current is not null) current.Changed += OnPeer;
            }
            else { if (current is not null) current.Changed -= OnPeer; current = v1; v1.Resume(); }
            Changed?.Invoke();
        }
        finally { reading.Release(); }
    }
    private void OnPeer() { Changed?.Invoke(); if (current?.State.Status == RuntimeStatus.Retrying) _ = SelectAsync(CancellationToken.None); }

    public Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text, long version) => (current ?? v1).AnswerAsync(decisionId, optionId, text, version);
    public Task<SendOutcome> HoldAsync(string decisionId, bool held) => (current ?? v1).HoldAsync(decisionId, held);
    public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => (current ?? v1).AttachmentAsync(decisionId, attachmentId);
    public void Refresh() { _ = SelectAsync(CancellationToken.None); (current ?? v1).Refresh(); }
}
