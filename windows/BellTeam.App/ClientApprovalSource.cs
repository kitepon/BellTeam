using BellTeam.Core;
using Kitepon.ApprovalBox.Client;

namespace BellTeam.App;

/// <summary>
/// The 決裁箱 source over Kitepon.ApprovalBox.Client (Indivilia, client-component 0.3): the package picks /v1 or the peer channel and reads and answers; this maps its normalized Decision to the ViewDecision the screen draws
/// and its ClientState / AnswerResult to the screen's RuntimeState / SendOutcome. Origin and Requester stay the raw source; <see cref="ApprovalOriginRule"/> (the hub) decides who it is.
/// </summary>
internal sealed class ClientApprovalSource : IApprovalSource, IAsyncDisposable
{
    private readonly ApprovalBoxClient client;
    public event Action? Changed;

    internal ClientApprovalSource(ApprovalBoxClient client) { this.client = client; client.Changed += () => Changed?.Invoke(); }

    public RuntimeState State => StateOf(client.State);
    public IReadOnlyList<ViewDecision> Decisions { get { var lists = client.Decisions; return [.. lists.Open.Concat(lists.Closed).Select(ViewOf)]; } }
    public void Start() => _ = client.StartAsync();
    public void Refresh() => client.RetryNow();
    public async Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text, long version) => OutcomeOf(await client.AnswerAsync(decisionId, optionId, text, version));
    public async Task<SendOutcome> HoldAsync(string decisionId, bool held) => OutcomeOf(held ? await client.HoldAsync(decisionId) : await client.UnholdAsync(decisionId));
    public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => client.AttachmentAsync(decisionId, attachmentId);
    public ValueTask DisposeAsync() => client.DisposeAsync();

    internal static RuntimeState StateOf(ClientState s) => s.Status switch
    {
        ClientStatus.SignedOut => new(RuntimeStatus.SignedOut, s.Reason),
        ClientStatus.Joining => new(RuntimeStatus.Connecting),
        ClientStatus.NotEntitled => new(RuntimeStatus.NotEntitled, s.Reason),
        ClientStatus.NeedsApproval => new(RuntimeStatus.NeedsAdmission, s.Note == "device_removed" ? "removed" : s.Reason),
        ClientStatus.Waiting => new(RuntimeStatus.NeedsAdmission),
        ClientStatus.Live => new(RuntimeStatus.Live),
        ClientStatus.Reconnecting => new(RuntimeStatus.Retrying, s.Reason),
        _ => new(RuntimeStatus.UpdateRequired, s.Reason)
    };

    internal static SendOutcome OutcomeOf(AnswerResult r) => r switch
    {
        AnswerResult.Accepted => new("ok"),
        AnswerResult.Conflict => new("refused:stale_version"),
        AnswerResult.AlreadyDecided => new("refused:already_decided"),
        AnswerResult.Unknown => new("unknown"),
        AnswerResult.Refused { Code: var code } => new(code.StartsWith("failed", StringComparison.Ordinal) ? "failed" : "refused:" + code),
        AnswerResult.Gone => new("gone"),
        AnswerResult.NoSession => new("no_session"),
        _ => new("failed")
    };

    internal static ViewDecision ViewOf(Decision d)
    {
        var history = d.History.Select(h => new ApprovalHistoryItem { At = h.At, Kind = h.Kind, By = h.By, Note = h.Note, Fields = h.Fields?.ToArray() }).ToArray();
        var s = d.Source;
        return new ViewDecision
        {
            Id = d.Id, Title = d.Title, Context = d.Context, Urgency = d.Urgency, Deadline = d.Deadline, Status = d.Status, Delivery = d.Delivery, ResumePhrase = d.ResumePhrase,
            Version = d.Version, CreatedAt = d.CreatedAt, UpdatedAt = d.UpdatedAt, CancelReason = d.CancelReason,
            Options = d.Options.Select(o => new ApprovalOption { Id = o.Id, Label = o.Label, Recommended = d.Recommendation is not null && o.Id == d.Recommendation }).ToArray(),
            Answer = d.Answer is { } a ? new ApprovalAnswer { OptionId = a.OptionId, Text = a.Text, AnsweredAt = a.AnsweredAt, Attachments = a.Attachments.Select(Attachment).ToArray() } : null,
            History = history,
            Amended = history.LastOrDefault() is { Kind: "amended" } last ? new ApprovalAmended { Is = true, Fields = last.Fields, Note = last.Note, At = last.At } : null,
            RequestAttachments = d.RequestAttachments.Select(Attachment).ToArray(),
            Origin = new ApprovalOrigin { Client = s.Client, Tool = ApprovalsV1.ToolOf(s.Client), SessionLabel = s.SessionLabel, WorkLabel = s.WorkLabel, ConnectionLabel = s.ConnectionLabel, Via = s.Via },
            Requester = s.RequesterBotId is { Length: > 0 } || s.Requester is { Length: > 0 } ? new ApprovalRequester { BotId = s.RequesterBotId, Name = s.Requester } : null,
        };
    }

    private static ApprovalAttachment Attachment(DecisionAttachment a) => new() { Id = a.Id, Name = a.Name, ContentType = a.ContentType, Size = a.Size, Sha256 = a.Sha256 };
}
