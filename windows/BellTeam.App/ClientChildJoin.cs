using Kitepon.ApprovalBox.Client;

namespace BellTeam.App;

/// <summary>
/// <see cref="IChildJoin"/> over the component's join (client-component 9.2): joinState, requestJoin(provider), cancelJoin, leave. Join(null) is 「もう一度つなぐ」 after a failure: the provider of the last try.
/// </summary>
internal sealed class ClientChildJoin : IChildJoin
{
    private readonly ApprovalBoxClient client; private string? last;
    public event Action? Changed;
    internal ClientChildJoin(ApprovalBoxClient client) { this.client = client; client.Changed += () => Changed?.Invoke(); }

    private JoinState State => client.JoinState;
    public ChildJoinPhase Phase => State.Status switch
    {
        JoinStatus.WaitingForParent => ChildJoinPhase.Waiting, JoinStatus.Failed => ChildJoinPhase.Failed, JoinStatus.Joined => ChildJoinPhase.Joined, _ => ChildJoinPhase.NotJoined,
    };
    public bool SigningIn => State.Status == JoinStatus.SigningIn;
    public string? QrLink => State.QrLink;
    public DateTimeOffset? ExpiresAt => State.ExpiresAt;
    public string? FailedCode => State.Status == JoinStatus.Failed ? State.Reason : null;
    public bool Removed => State is { Status: JoinStatus.NotJoined, Reason: "removed" };
    public bool UpdateRequired => State.Status == JoinStatus.Joined && client.State.Status == ClientStatus.UpdateRequired;
    public Task JoinAsync(string? provider) { client.RequestJoin(last = provider ?? last ?? throw new InvalidOperationException("no earlier try to repeat")); return Task.CompletedTask; }
    public void CancelJoin() => client.CancelJoin();
    public Task LeaveAsync() => client.LeaveAsync();
}
