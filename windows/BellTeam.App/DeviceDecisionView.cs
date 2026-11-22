using BellTeam.Core;
using BellTeam.PeerChannel;

namespace BellTeam.App;

/// <summary>approval-box/decision@1 as this device holds it (DecisionEntry) -> the ViewDecision the 決裁箱 screen already draws (Approvals.cs). The link to the chart is joined later from BellTeam's id-level lookup.</summary>
internal static class DeviceDecisionView
{
    // The tool name the old server derived from the client string.
    private static string? Tool(string client) => client switch
    {
        "claude-code" => "Claude Code", "codex" => "Codex", "cursor" => "Cursor", "claude.ai" => "Claude", "chatgpt" => "ChatGPT", "" => null, _ => client
    };

    private static string Iso(long ms) => DateTimeOffset.FromUnixTimeMilliseconds(ms).ToString("yyyy-MM-ddTHH:mm:ssZ");

    internal static ViewDecision Of(DecisionEntry e)
    {
        var s = e.Source; var bellteam = s.RequesterBotId is { Length: > 0 };
        var cancelled = e.Status is DecisionStatus.Cancelled or DecisionStatus.Expired;
        return new ViewDecision
        {
            Id = e.DecisionId, Title = e.Title, Context = e.Context, Urgency = e.Urgency, Deadline = e.Deadline, Version = e.Version, CreatedAt = e.CreatedAt, UpdatedAt = Iso(e.UpdatedAt),
            Options = e.Options.Select(o => new ApprovalOption { Id = o.Id, Label = o.Label, Recommended = o.Id == e.Recommendation }).ToArray(),
            Status = e.Status switch { DecisionStatus.Pending => "pending", DecisionStatus.Held => "held", DecisionStatus.Answered => "answered", _ => "cancelled" },
            Answer = e.Answer is { } a ? new ApprovalAnswer { OptionId = a.OptionId, Text = a.Text, AnsweredAt = Iso(e.UpdatedAt) } : null,
            // The connector holds the accepted answer until the AI's session takes it; the device cannot know more than that.
            Delivery = e.Status == DecisionStatus.Answered ? "waiting" : null,
            CancelReason = cancelled ? e.CancelReason : null,
            Amended = e.Amended ? new ApprovalAmended { Is = true, At = Iso(e.UpdatedAt) } : null,
            Origin = new ApprovalOrigin { Kind = bellteam ? "bellteam" : "external", Client = s.Client, Tool = Tool(s.Client), SessionLabel = s.SessionLabel, WorkLabel = s.WorkLabel, Via = "connector" },
            RequestAttachments = e.Blobs is { Count: > 0 } blobs ? [.. blobs.Select(b => new ApprovalAttachment { Id = b.BlobId, Name = b.Name, ContentType = b.ContentType, Size = b.Size, Sha256 = Convert.ToHexString(Bytes.FromB64Url(b.BlobId)) })] : null,
            Requester = bellteam ? new ApprovalRequester { BotId = s.RequesterBotId, Name = s.Requester } : null,
        };
    }
}
