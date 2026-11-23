using System.Text.Json;

namespace BellTeam.Core;

/// <summary>
/// Approval Box's /v1 Decision (docs/api.md v0.49, snake_case) read into the ViewDecision the 決裁箱 screen draws (client-v0.5 5.2, a map and not a copy of its fields). Pure: no I/O.
/// Unknown fields are ignored and unknown enum values draw as 「その他」; the source is kept raw (Origin, Requester) and <see cref="ApprovalOriginRule"/> decides who it is.
/// </summary>
public static class ApprovalsV1
{
    public static ViewDecision? Parse(JsonElement d)
    {
        if (d.ValueKind != JsonValueKind.Object || Str(d, "id") is not { Length: > 0 } id) return null;
        var recommendation = Str(d, "recommendation");
        var source = d.TryGetProperty("source", out var s) && s.ValueKind == JsonValueKind.Object ? s : default;
        var history = Items(d, "history").Select(h => new ApprovalHistoryItem { At = Str(h, "at"), Kind = Str(h, "kind"), By = Str(h, "by"), Note = Str(h, "note"), Fields = Strings(h, "fields") }).ToArray();
        var amended = history.LastOrDefault() is { Kind: "amended" } last ? new ApprovalAmended { Is = true, Fields = last.Fields, Note = last.Note, At = last.At } : null;
        var answer = d.TryGetProperty("answer", out var a) && a.ValueKind == JsonValueKind.Object
            ? new ApprovalAnswer { OptionId = Str(a, "option_id"), Text = Str(a, "text"), AnsweredAt = Str(a, "answered_at"), Attachments = Items(a, "attachments").Select(Attachment).ToArray() } : null;
        return new ViewDecision
        {
            Id = id, Title = Str(d, "title"), Context = Str(d, "context"), Urgency = Str(d, "urgency"), Deadline = Str(d, "deadline"), Status = Str(d, "status"), Delivery = Str(d, "delivery"), ResumePhrase = Str(d, "resume_phrase"),
            Version = d.TryGetProperty("version", out var v) && v.TryGetInt64(out var number) ? number : 0, CreatedAt = Str(d, "created_at"), UpdatedAt = Str(d, "updated_at"), CancelReason = Str(d, "cancel_reason"),
            Options = Items(d, "options").Select(o => new ApprovalOption { Id = Str(o, "id"), Label = Str(o, "label"), Recommended = recommendation is not null && Str(o, "id") == recommendation }).ToArray(),
            Answer = answer, History = history, Amended = amended,
            RequestAttachments = Items(d, "request_attachments").Select(Attachment).ToArray(),
            Origin = new ApprovalOrigin { Client = Str(source, "client"), Tool = ToolOf(Str(source, "client")), SessionLabel = Str(source, "session_label"), WorkLabel = Str(source, "work_label"), ConnectionLabel = Str(source, "connection_label"), Via = Str(source, "via") },
            Requester = Str(source, "requester_bot_id") is { Length: > 0 } || Str(source, "requester") is { Length: > 0 } ? new ApprovalRequester { BotId = Str(source, "requester_bot_id"), Name = Str(source, "requester") } : null,
        };
    }

    /// <summary>One page of GET /decisions: <c>{ items, next_cursor? }</c>.</summary>
    public static (IReadOnlyList<ViewDecision> Items, string? NextCursor) ParseList(JsonElement page)
        => ([.. Items(page, "items").Select(Parse).OfType<ViewDecision>()], Str(page, "next_cursor") is { Length: > 0 } cursor ? cursor : null);

    // The tool name the old server derived from the client string.
    public static string? ToolOf(string? client) => client switch
    {
        "claude-code" => "Claude Code", "codex" => "Codex", "cursor" => "Cursor", "grok" => "Grok", "claude.ai" => "Claude", "chatgpt" => "ChatGPT", null or "" => null, _ => client
    };

    private static ApprovalAttachment Attachment(JsonElement a) => new() { Id = Str(a, "id"), Name = Str(a, "name"), ContentType = Str(a, "content_type"), Size = a.TryGetProperty("size", out var size) && size.TryGetInt64(out var n) ? n : 0, Sha256 = Str(a, "sha256") };
    private static string? Str(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static IEnumerable<JsonElement> Items(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array ? v.EnumerateArray() : [];
    private static string[]? Strings(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array ? [.. v.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!)] : null;
}

/// <summary>
/// Who a decision came from, decided on the client by the four rules of contract/approvals-contract.md ("How origin.kind is decided"; cases: contract/fixtures/origin-cases.json), against the BellTeam member list the client already holds.
/// Visibility never depends on the kind (Owner 2026-11-15).
/// </summary>
public static class ApprovalOriginRule
{
    private static readonly HashSet<string> Clients = ["claude-code", "codex", "cursor", "grok", "claude.ai", "chatgpt", "other"];

    /// <summary>The decision with its Origin.Kind / Basis and Requester resolved. The raw source is read from Origin (Client, SessionLabel) and Requester (BotId, Name) as the adapters fill them.</summary>
    public static ViewDecision Apply(ViewDecision decision, IReadOnlyList<(string Id, string Name)> roster)
    {
        var origin = decision.Origin ?? new ApprovalOrigin(); var raw = decision.Requester;
        string kind, basis = "none"; ApprovalRequester? requester = null;
        if (raw?.BotId is { Length: > 0 } botId && roster.FirstOrDefault(member => member.Id == botId) is { Id: not null } byId) { kind = "bellteam"; basis = "botId"; requester = new ApprovalRequester { BotId = byId.Id, Name = byId.Name }; }
        else if (raw?.Name is { Length: > 0 } name && roster.FirstOrDefault(member => member.Name == name) is { Id: not null } byName) { kind = "bellteam"; basis = "name"; requester = new ApprovalRequester { BotId = byName.Id, Name = byName.Name }; }
        else if (origin.Client is { Length: > 0 } || origin.SessionLabel is { Length: > 0 }) kind = "external";
        else kind = "unknown";
        var client = origin.Client is { Length: > 0 } c ? (Clients.Contains(c) ? c : "other") : origin.Client;
        return decision with { Origin = origin with { Kind = kind, Basis = basis, Client = client }, Requester = requester };
    }
}
