namespace BellTeam.App;

/// <summary>Where the source stands; the package's ClientStatus in the words the screen already uses (Joining = Connecting, Reconnecting = Retrying, NeedsApproval and Waiting = NeedsAdmission).</summary>
internal enum RuntimeStatus { Connecting, Live, Retrying, NeedsAdmission, SignedOut, NotEntitled, UpdateRequired }
internal sealed record RuntimeState(RuntimeStatus Status, string? Reason = null);
/// <summary>What an answer or hold came to: "ok", "refused:<code>", "unknown" (sent, no answer: the same press again is the same key), "gone", "no_session" or "failed".</summary>
internal sealed record SendOutcome(string Ack);


/// <summary>
/// The one thing the 決裁箱 page talks to (client-v0.5 5.1): the decisions of the Approval Box account, read and answered exactly as the Approval Box app does. The screen never names /v1 or /pc/v1.
/// One adapter: <see cref="ClientApprovalSource"/> over Kitepon.ApprovalBox.Client (the path selector, /v1 and the peer channel are the package's). A fake in tests.
/// Sign-in and sign-out are <see cref="ApprovalBoxDevice"/>'s (the screen asks for them through the hub), the source only says SignedOut.
/// </summary>
internal interface IApprovalSource
{
    /// <summary>SignedOut, Connecting, NotEntitled, Live, Retrying (NeedsAdmission and UpdateRequired for the peer channel). Never a raw status or exception text.</summary>
    RuntimeState State { get; }
    /// <summary>The open decisions and the recent answered / withdrawn ones, as the source holds them: Origin and Requester are the raw source, the hub decides who it is (ApprovalOriginRule).</summary>
    IReadOnlyList<ViewDecision> Decisions { get; }
    /// <summary>The decisions or the state changed (any thread).</summary>
    event Action? Changed;
    /// <summary>version is the version the person saw: a different one on the source is a conflict (the answer is refused with refused:stale_version and the decision is replaced).</summary>
    Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text, long version);
    Task<SendOutcome> HoldAsync(string decisionId, bool held);
    /// <summary>retryNow: tries the waiting connection at once.</summary>
    void Refresh();
    /// <summary>The bytes of a request image, or null when the source does not hold them.</summary>
    Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId);
    void Start();
}
