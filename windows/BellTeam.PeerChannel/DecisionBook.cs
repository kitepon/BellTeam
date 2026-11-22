using System.Text.Json;

namespace BellTeam.PeerChannel;

public enum DecisionStatus { Pending, Held, Answered, Cancelled, Expired }

public sealed record DecisionOption(string Id, string Label);
// source of approval-box/decision@1 (the product's own content, peer-channel only carries it).
public sealed record DecisionSource(string Client, string SessionLabel, string WorkLabel, string? Requester, string? RequesterBotId, bool Test);
public sealed record DecisionAnswer(string? OptionId, string? Text, string DecidedBy);

// One request as this device holds it. Body = the exact bytes of the request/amend frame body the person sees (the answer's request_hash is made from them).
public sealed record DecisionEntry(
    string Rid, long Rv, string DecisionId, string Title, string Context, IReadOnlyList<DecisionOption> Options, string? Recommendation, string Urgency, string? Deadline,
    DecisionSource Source, string CreatedAt, long Version, byte[] Body, DecisionStatus Status, DecisionAnswer? Answer, string? CancelReason, long UpdatedAt, bool Amended)
{
    public bool IsOpen => Status is DecisionStatus.Pending or DecisionStatus.Held;
}

// The device's history of decisions (contract 10.1): what request, amend, cancel and result frames say, kept by rid. Pure state: no crypto, no I/O (the session verifies frames, the app stores the export).
public sealed class DecisionBook
{
    public const string DecisionSchema = "approval-box/decision@1", AnswerSchema = "approval-box/answer@1";
    private readonly Dictionary<string, DecisionEntry> entries = [];
    public IReadOnlyCollection<DecisionEntry> All => entries.Values;
    public DecisionEntry? Find(string rid) => entries.GetValueOrDefault(rid);
    public DecisionEntry? FindByDecision(string decisionId) => entries.Values.Where(e => e.DecisionId == decisionId).MaxBy(e => e.UpdatedAt);
    public event Action? Changed;

    private static string? Str(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static long? Num(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.TryGetInt64(out var n) ? n : null;

    // The ack result for the frame ("ok" or "refused:<code>"). A request or amend of a version the book already has or passed is ignored and acknowledged ok (contract 8.4); a closed request stays closed.
    public string Apply(string type, JsonElement body, byte[] bodyBytes, long now)
    {
        if (Str(body, "rid") is not { Length: > 0 } rid || Num(body, "rv") is not { } rv) return "refused:invalid";
        switch (type)
        {
            case "request":
            case "amend":
                if (Str(body, "schema") != DecisionSchema) return "refused:invalid";
                if (!body.TryGetProperty("content", out var content) || Parse(rid, rv, content, bodyBytes, now) is not { } parsed) return "refused:invalid";
                if (entries.TryGetValue(rid, out var old))
                {
                    if (rv <= old.Rv || !old.IsOpen) return "ok";
                    parsed = parsed with { Status = old.Status, Amended = true };
                }
                entries[rid] = parsed; Changed?.Invoke(); return "ok";
            case "cancel":
                if (entries.TryGetValue(rid, out var open) && open.IsOpen) { entries[rid] = open with { Status = DecisionStatus.Cancelled, CancelReason = Str(body, "reason"), UpdatedAt = now }; Changed?.Invoke(); }
                return "ok";
            default: return "refused:unknown_type";
        }
    }

    // A verified result (FrameChecks.CheckResult passed): the winning answer's content, or none for cancelled and expired.
    public void Close(string rid, string status, JsonElement? answerContent, string decidedBy, long now)
    {
        if (!entries.TryGetValue(rid, out var e) || !e.IsOpen) return;
        var next = status switch { "answered" => DecisionStatus.Answered, "expired" => DecisionStatus.Expired, _ => DecisionStatus.Cancelled };
        var answer = next == DecisionStatus.Answered && answerContent is { } c ? new DecisionAnswer(Str(c, "option_id"), Str(c, "text"), decidedBy) : null;
        entries[rid] = e with { Status = next, Answer = answer, CancelReason = next == DecisionStatus.Expired ? "expired" : status == "closed" ? "closed" : e.CancelReason, UpdatedAt = now };
        Changed?.Invoke();
    }

    // The person set the request aside or back (the hold frame was sent).
    public void SetHeld(string rid, bool held, long now)
    {
        if (!entries.TryGetValue(rid, out var e) || !e.IsOpen || (e.Status == DecisionStatus.Held) == held) return;
        entries[rid] = e with { Status = held ? DecisionStatus.Held : DecisionStatus.Pending, UpdatedAt = now }; Changed?.Invoke();
    }

    private static DecisionEntry? Parse(string rid, long rv, JsonElement c, byte[] bodyBytes, long now)
    {
        if (Str(c, "decision_id") is not { Length: > 0 } id || Str(c, "title") is not { } title || !c.TryGetProperty("options", out var list) || list.ValueKind != JsonValueKind.Array) return null;
        var options = new List<DecisionOption>();
        foreach (var o in list.EnumerateArray()) { if (Str(o, "id") is not { } oid || Str(o, "label") is not { } label) return null; options.Add(new(oid, label)); }
        var s = c.TryGetProperty("source", out var src) ? src : default;
        var source = new DecisionSource(Str(s, "client") ?? "", Str(s, "session_label") ?? "", Str(s, "work_label") ?? "", Str(s, "requester"), Str(s, "requester_bot_id"),
            s.ValueKind == JsonValueKind.Object && s.TryGetProperty("test", out var t) && t.ValueKind == JsonValueKind.True);
        return new(rid, rv, id, title, Str(c, "context") ?? "", options, Str(c, "recommendation"), Str(c, "urgency") ?? "normal", Str(c, "deadline"), source,
            Str(c, "created_at") ?? "", Num(c, "version") ?? 1, bodyBytes, DecisionStatus.Pending, null, null, now, false);
    }

    public string Export() => JsonSerializer.Serialize(entries.Values.OrderBy(e => e.UpdatedAt).ToList());
    // A history file that cannot be read is no history (the connector sends open requests again; finished ones are gone with it).
    public static DecisionBook Import(string json)
    {
        var book = new DecisionBook();
        try { foreach (var e in JsonSerializer.Deserialize<List<DecisionEntry>>(json) ?? []) book.entries[e.Rid] = e; }
        catch (JsonException) { }
        return book;
    }
}
