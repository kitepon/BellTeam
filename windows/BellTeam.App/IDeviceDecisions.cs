using BellTeam.PeerChannel;

namespace BellTeam.App;

/// <summary>What the 決裁箱 page needs from this device's peer-channel session (DeviceApprovals in the app, a fake in tests).</summary>
internal interface IDeviceDecisions
{
    DecisionBook Book { get; }
    RuntimeState State { get; }
    /// <summary>The book or the connection state changed (any thread).</summary>
    event Action? Changed;
    Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text);
    Task<SendOutcome> HoldAsync(string decisionId, bool held);
    /// <summary>Manual retry of the waiting connection attempt.</summary>
    void Refresh();
    /// <summary>The bytes of a request image (the blob id of the decision's attachment), or null when this device does not hold them.</summary>
    Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId);
}
