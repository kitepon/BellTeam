using BellTeam.PeerChannel;

namespace BellTeam.App;

/// <summary>
/// The one thing the 決裁箱 page talks to (client-v0.5 5.1): the decisions of the Approval Box account, read and answered exactly as the Approval Box app does. The screen never names /v1 or /pc/v1.
/// Two adapters: <see cref="V1ApprovalSource"/> (/v1, now) and <see cref="DeviceApprovals"/> (the pc/1 core, when GET /v1/auth/config says peer_channel); <see cref="ApprovalSelector"/> picks one. A fake in tests.
/// Sign-in and sign-out are <see cref="ApprovalBoxDevice"/>'s (the screen asks for them through the hub), the source only says SignedOut.
/// </summary>
internal interface IApprovalSource
{
    /// <summary>SignedOut, Connecting, NotEntitled, Live, Retrying (and, for the pc/1 core only, NeedsAdmission). Never a raw status or exception text.</summary>
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
