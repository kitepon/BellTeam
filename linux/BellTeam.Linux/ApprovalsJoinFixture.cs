using BellTeam.Core;
using BellTeam.PeerChannel;

namespace BellTeam.Linux;

/// <summary>A stand-in for the component's child join (render scenes and tests; nothing is sent anywhere): the device session behind the port plus a settable joinState and the calls the screen made.</summary>
internal sealed class JoinFixtureSource(IApprovalSource inner, ChildJoinState join) : IApprovalSource
{
    public ChildJoinState Current { get; set; } = join;
    public readonly List<string> Calls = [];
    public ChildJoinState? Join => Current;
    public void RequestJoin(string? provider) => Calls.Add("join:" + (provider ?? "again"));
    public void CancelJoin() => Calls.Add("cancel");
    public Task LeaveAsync() { Calls.Add("leave"); Current = new(JoinPhase.NotJoined); inner.Refresh(); return Task.CompletedTask; }

    public IReadOnlyList<ViewDecision> Decisions => inner.Decisions;
    public RuntimeState State => inner.State;
    public event Action? Changed { add => inner.Changed += value; remove => inner.Changed -= value; }
    public Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text, long version) => inner.AnswerAsync(decisionId, optionId, text, version);
    public Task<SendOutcome> HoldAsync(string decisionId, bool held) => inner.HoldAsync(decisionId, held);
    public void Refresh() => inner.Refresh();
    public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => inner.AttachmentAsync(decisionId, attachmentId);
}
