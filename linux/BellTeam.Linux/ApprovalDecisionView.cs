using BellTeam.Core;
using Kitepon.ApprovalBox.Client;

namespace BellTeam.Linux;

/// <summary>
/// The component's normalized Decision (identical on /v1 and the peer channel) -> the ViewDecision the 決裁箱 screen draws. The component keeps the raw source and decides no origin: <see cref="ApprovalOriginRule"/> does,
/// against the BellTeam member list this app holds (contract/approvals-contract.md; cases in origin-cases.json).
/// </summary>
internal static class DecisionView
{
    internal static ViewDecision Of(Decision d, IReadOnlyList<(string Id, string Name)> roster)
    {
        var history = d.History.Select(h => new ApprovalHistoryItem { At = h.At, Kind = h.Kind, By = h.By, Note = h.Note, Fields = h.Fields?.ToArray() }).ToArray();
        var s = d.Source;
        return ApprovalOriginRule.Apply(new ViewDecision
        {
            Id = d.Id, Title = d.Title, Context = d.Context, Urgency = d.Urgency, Deadline = d.Deadline, Status = d.Status, Delivery = d.Delivery, ResumePhrase = d.ResumePhrase, Version = d.Version,
            CreatedAt = d.CreatedAt, UpdatedAt = d.UpdatedAt, CancelReason = d.CancelReason,
            Options = d.Options.Select(o => new ApprovalOption { Id = o.Id, Label = o.Label, Recommended = d.Recommendation is not null && o.Id == d.Recommendation }).ToArray(),
            Answer = d.Answer is { } a ? new ApprovalAnswer { OptionId = a.OptionId, Text = a.Text, AnsweredAt = a.AnsweredAt, Attachments = a.Attachments.Select(Attachment).ToArray() } : null,
            History = history,
            Amended = history.LastOrDefault() is { Kind: "amended" } last ? new ApprovalAmended { Is = true, Fields = last.Fields, Note = last.Note, At = last.At } : null,
            RequestAttachments = d.RequestAttachments.Select(Attachment).ToArray(),
            Origin = new ApprovalOrigin { Client = s.Client, Tool = ApprovalsV1.ToolOf(s.Client), SessionLabel = s.SessionLabel, WorkLabel = s.WorkLabel, ConnectionLabel = s.ConnectionLabel, Via = s.Via },
            Requester = s.RequesterBotId is { Length: > 0 } || s.Requester is { Length: > 0 } ? new ApprovalRequester { BotId = s.RequesterBotId, Name = s.Requester } : null,
        }, roster);
    }

    private static ApprovalAttachment Attachment(DecisionAttachment a) => new() { Id = a.Id, Name = a.Name, ContentType = a.ContentType, Size = a.Size, Sha256 = a.Sha256 };
}
