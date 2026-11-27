using BellTeam.Core;
using Kitepon.ApprovalBox.Client;

namespace BellTeam.Linux;

/// <summary>
/// The one thing the 決裁箱 screen reads and answers through (client-v0.5.md 5.1): the decisions as the screen draws them, the connection state, answer, hold, the bytes of an attachment, retry.
/// <see cref="ClientApprovalSource"/> stands behind it on the real app; the screen never names a route (/v1 or the peer channel is the component's own switch).
/// </summary>
internal interface IApprovalSource
{
    /// <summary>The open list and the recent answered/cancelled ones; each already carries its origin (links are joined by the hub).</summary>
    IReadOnlyList<ViewDecision> Decisions { get; }
    ClientState State { get; }
    /// <summary>The list or the state changed (any thread).</summary>
    event Action? Changed;
    /// <summary>version = the version of the decision the person is looking at (a newer one answers Conflict).</summary>
    Task<AnswerResult> AnswerAsync(string decisionId, string? optionId, string? text, long version);
    Task<AnswerResult> HoldAsync(string decisionId, bool held);
    /// <summary>「今すぐ試す」 / 「確かめ直す」: reads the switch again and tries the waiting attempt now (never a second copy of it).</summary>
    void Refresh();
    Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId);

    // The child join (child-join.md, "The port"): requestJoin / cancelJoin / leave of the Approval Box client component. null = this adapter has no child join (the window keeps its sign-in note); the screen is drawn only when it is set.
    ChildJoinState? Join => null;
    /// <summary>provider "apple" | "google" (the component's requestJoin(provider), child-join.md): the button the person pressed.</summary>
    void RequestJoin(string provider) { }
    void CancelJoin() { }
    Task LeaveAsync() => Task.CompletedTask;
}

/// <summary>The component's joinState (child-join.md): NotJoined, SigningIn (notJoined while the browser sign-in of requestJoin runs), Waiting (waitingForParent: the library's join link and its expiry), Failed (a refusal or library failure; the library's code picks the sentence, only other_account has its own, and is never shown), Joined.
/// Removed = notJoined(removed): the parent took this device off, shown above the not-joined screen, which starts clean.</summary>
internal enum JoinPhase { NotJoined, SigningIn, Waiting, Failed, Joined }   // SigningIn = signingIn(provider)
internal sealed record ChildJoinState(JoinPhase Phase, string? QrLink = null, DateTimeOffset? ExpiresAt = null, bool Removed = false, string? Code = null, string? JoinCode = null, string? Words = null);

/// <summary>Kitepon.ApprovalBox.Client (the .NET form of the Approval Box client component) behind the port; the origin rule is BellTeam's own and stays here.</summary>
internal sealed class ClientApprovalSource(ApprovalBoxClient client, Func<IReadOnlyList<(string Id, string Name)>> roster) : IApprovalSource
{
    public IReadOnlyList<ViewDecision> Decisions { get { var lists = client.Decisions; return [.. lists.Open.Concat(lists.Closed).Select(item => DecisionView.Of(item, roster()))]; } }
    public ClientState State => client.State;
    public event Action? Changed { add => client.Changed += value; remove => client.Changed -= value; }
    public Task<AnswerResult> AnswerAsync(string decisionId, string? optionId, string? text, long version) => client.AnswerAsync(decisionId, optionId, text, version);
    public Task<AnswerResult> HoldAsync(string decisionId, bool held) => held ? client.HoldAsync(decisionId) : client.UnholdAsync(decisionId);
    public void Refresh() => client.RetryNow();
    public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => client.AttachmentAsync(decisionId, attachmentId);

    // The child join: the component's joinState drawn as the port's ChildJoinState (child-join.md); the screen's actions are the component's requestJoin / cancelJoin / leave.
    public ChildJoinState? Join => client.JoinState switch
    {
        { Status: JoinStatus.SigningIn } => new(JoinPhase.SigningIn),
        { Status: JoinStatus.WaitingForParent } wait => new(JoinPhase.Waiting, wait.QrLink, wait.ExpiresAt, JoinCode: wait.Code),
        { Status: JoinStatus.Joined } => new(JoinPhase.Joined),
        { Status: JoinStatus.Failed } failed => new(JoinPhase.Failed, Code: failed.Reason, Words: failed.Words),
        var other => new(JoinPhase.NotJoined, Removed: other.Reason == "removed"),
    };
    public void RequestJoin(string provider) => client.RequestJoin(provider);
    public void CancelJoin() => client.CancelJoin();
    public Task LeaveAsync() => client.LeaveAsync();
}
