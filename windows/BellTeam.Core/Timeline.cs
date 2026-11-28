using System.Text.Json;

namespace BellTeam.Core;

public static class Timeline
{
    private static bool Matches(JsonElement value, string key, string expected) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var field) && field.ValueKind == JsonValueKind.String && field.GetString() == expected;

    private static bool AcceptedUnknown(JsonElement value) => Matches(value, "schema", "bellteam.delivery-tracking.v1") && Matches(value, "admission", "accepted") && Matches(value, "completion", "unknown");

    // Mac TimelineMessage.status: a failed routing wins, then the message's own delivery, then the worst per-recipient delivery.
    public static string? DeliveryStatus(TimelineMessage message)
    {
        if (Matches(message.Routing, "status", "failed")) return "failed";
        if (message.Delivery is { } own) return own;
        if (message.Deliveries.ValueKind != JsonValueKind.Array) return null;
        var values = new List<string>();
        foreach (var item in message.Deliveries.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("delivery", out var status) || status.ValueKind != JsonValueKind.String) return null;
            values.Add(status.GetString()!);
        }
        foreach (var worst in new[] { "failed", "running", "queued", "stopped" }) if (values.Contains(worst)) return worst;
        return values.Count == 0 ? null : "delivered";
    }

    public static string StatusText(string? status) => status switch
    {
        "submitting" => CoreStrings.Timeline_StatusText_1, "accepted" => CoreStrings.Timeline_StatusText_2, "queued" => CoreStrings.QueueState_Line_1, "running" => CoreStrings.QueueState_Line_2,
        "stopped" => CoreStrings.Timeline_StatusText_5, "delivered" => CoreStrings.Timeline_StatusText_6, "failed" => CoreStrings.Timeline_StatusText_7, _ => ""
    };

    public static string DeliveryLabel(TimelineMessage message, bool isRoom)
    {
        if (!message.IsOutgoing) return "";
        var existing = StatusText(DeliveryStatus(message));
        if (!isRoom) return message.Delivery == "failed" && AcceptedUnknown(message.DeliveryTracking) ? CoreStrings.Timeline_DeliveryLabel_1 : existing;
        if (message.Deliveries.ValueKind != JsonValueKind.Array) return existing;
        var hasUnknown = false;
        var hasFailure = Matches(message.Routing, "status", "failed");
        foreach (var item in message.Deliveries.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("delivery", out var status) || status.ValueKind != JsonValueKind.String) return existing;
            if (status.GetString() != "failed") continue;
            if (item.TryGetProperty("deliveryTracking", out var tracking) && AcceptedUnknown(tracking)) hasUnknown = true;
            else hasFailure = true;
        }
        return hasUnknown ? hasFailure ? CoreStrings.Timeline_StatusText_7 : CoreStrings.Timeline_DeliveryLabel_3 : existing;
    }

    // Under a room message: who was chosen to reply. The names come from the caller so Core stays free of member lists.
    public static string? ReplyLabel(TimelineMessage message, bool isRoom, Func<string, string?> memberName)
    {
        if (!isRoom || message.Routing.ValueKind != JsonValueKind.Object || !message.Routing.TryGetProperty("status", out var status) || status.ValueKind != JsonValueKind.String) return null;
        switch (status.GetString())
        {
            case "pending": return CoreStrings.Timeline_ReplyLabel_1;
            case "failed": return CoreStrings.Timeline_ReplyLabel_2;
            case "ready":
                var names = message.Routing.TryGetProperty("responders", out var responders) && responders.ValueKind == JsonValueKind.Array
                    ? responders.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String).Select(item => memberName(item.GetString()!) ?? item.GetString()!).ToArray() : [];
                return CoreStrings.ConversationDraft_Label_3((names.Length == 0 ? CoreStrings.OnePassword_ConnectionLine_2 : string.Join(CoreStrings.Approvals_CardRow_3, names)));
            default: return null;
        }
    }

    // Machine entries (machine-stream.md "Fold view" and "Tool calls fold and the order rule"): nothing is hidden and nothing leaves its place in time. Consecutive folded entries of one fold_group
    // share one line (Folded of the first); only neighbours join. Expand is the inverse, so a list that came from a screen can be folded again.
    public static TimelineMessage[] VisibleMachine(IEnumerable<TimelineMessage> messages)
    {
        var result = new List<TimelineMessage>();
        foreach (var message in Expand(messages))
            if (message.MachineEvent is { IsFolded: true, FoldGroup.Length: > 0 } entry && result.Count > 0 && result[^1].MachineEvent is { IsFolded: true } last && last.FoldGroup == entry.FoldGroup)
                result[^1] = result[^1] with { MachineEvent = last with { Folded = [.. last.Folded, message] } };
            else result.Add(message);
        return [.. result];
    }
    // The label of a line of one fold_group (machine-stream.md): n is the sum of fold_count (1 when absent). n > 1: "<group> ×<n>"; n = 1: the entry's own message when the line is one entry, else the message
    // of the member with fold_count 1; n = 0: "<group> ×<members>".
    public static string FoldLabel(IReadOnlyList<TimelineMessage> members)
    {
        var head = members[0].MachineEvent!; var n = members.Sum(member => member.MachineEvent!.FoldCount ?? 1);
        if (members.Count == 1) return members[0].Message ?? "";
        return n == 1 ? members.First(member => (member.MachineEvent!.FoldCount ?? 1) == 1).Message ?? "" : $"{head.FoldGroup} ×{(n == 0 ? members.Count : n)}";
    }
    public static IEnumerable<TimelineMessage> Expand(IEnumerable<TimelineMessage> messages) =>
        messages.SelectMany(m => m.MachineEvent is { Folded.Length: > 0 } entry ? new[] { m with { MachineEvent = entry with { Folded = [] } } }.Concat(entry.Folded) : [m]);
    // Reply (conversation reply.md "What can be quoted"): conversation rows and a machine seat's bubble row (machine-stream.md, a471-reply-forward-broken) only; a pending echo, a request card and a Bot-to-Bot row are not.
    public static bool IsQuotable(TimelineMessage message) => !PendingSend.IsLocal(message.Id) && message.SecretRequest is null && message.OwnerQuestion is null && (message.Kind is null or "message" or "interim" or "schedule" || message.MachineEvent is { Bubble: true });
    // a471-thinking-bubble (machine-stream.md "Thinking is drawn as a bubble"): a shown thinking row with text is drawn in the answer's incoming bubble, its whole text lighter and slanted; copy only (it is no reply, quote or forward row).
    public static bool IsThinkingBubble(TimelineMessage message) => message.MachineEvent is { View: "thinking", Text.Length: > 0, IsFolded: false };
    // Forward (forward.md "What can be forwarded"): the same rows as a reply plus Bot-to-Bot rows.
    public static bool IsForwardable(TimelineMessage message) => IsQuotable(message) || !PendingSend.IsLocal(message.Id) && message.Kind == "peer";
    // The comment and the content of a forwarded or shared row; a row without origin (or with an unknown kind) is all comment-less content.
    public static (string Comment, string Content) OriginParts(TimelineMessage message)
    {
        var text = message.Message ?? "";
        if (message.Origin is not { Kind.Length: > 0 } origin || origin.ContentStart == 0) return ("", text);
        var runes = text.EnumerateRunes().ToArray();
        if (origin.ContentStart >= runes.Length) return (text.TrimEnd(), "");
        return (string.Concat(runes.Take(origin.ContentStart)).TrimEnd(), string.Concat(runes.Skip(origin.ContentStart)));
    }
    public static string? OriginMark(MessageOrigin origin) => origin.Kind switch { "forward" => CoreStrings.Timeline_OriginMark_1, "share" => origin.App is { Length: > 0 } app ? CoreStrings.Timeline_OriginMark_2(app) : CoreStrings.Timeline_OriginMark_3, _ => null };
    // Plain words for the refusals of a forward (forward.md "Failure handling"); anything else keeps the server's own message.
    public static string ForwardRefusal(BellApiException error) => error.Code switch
    {
        "FILE_NOT_SUPPORTED" => CoreStrings.Timeline_ForwardRefusal_1,
        "FORWARD_SOURCE_NOT_FOUND" => CoreStrings.Timeline_ForwardRefusal_2,
        "FILE_TOO_LARGE" or "TOO_MANY_FILES" => CoreStrings.Timeline_ForwardRefusal_3,
        "ORIGIN_INVALID" => CoreStrings.Timeline_ForwardRefusal_4,
        _ => error.Message
    };
    // Plain words for the refusals of a share-in (forward.md "Failure handling"); anything else keeps the server's own message.
    public static string ShareRefusal(BellApiException error) => error.Code switch
    {
        "FILE_NOT_SUPPORTED" => CoreStrings.Timeline_ShareRefusal_1,
        "FILE_TOO_LARGE" or "TOO_MANY_FILES" => CoreStrings.Timeline_ForwardRefusal_3,
        "ORIGIN_INVALID" => CoreStrings.Timeline_ShareRefusal_3,
        _ => error.Message
    };
    public static string UnavailableQuote  => CoreStrings.Timeline_UnavailableQuote_1;
    public static string QuoteNotFound  => CoreStrings.Timeline_QuoteNotFound_1;
    // reply.md "What the client draws": an unavailable part shows its saved excerpt and the fixed line under it; an unavailable whole-message reply shows only the fixed line.
    public static string QuoteBody(ReplyReference quote) => !quote.Available && !quote.Part ? UnavailableQuote : quote.Text.Length == 0 ? quote.Image ? CoreStrings.Timeline_QuoteBody_1 : "" : quote.Truncated ? quote.Text + "…" : quote.Text;
    public static string? QuoteNote(ReplyReference quote) => !quote.Available && quote.Part ? UnavailableQuote : null;

    // Mac BellDate.short / BellDate.long.
    public static string ShortTime(DateTimeOffset at, DateTimeOffset now)
    {
        var local = at.ToLocalTime(); var today = now.ToLocalTime().Date;
        return local.Date == today ? local.ToString(CoreStrings.Pattern_Time) : local.Date == today.AddDays(-1) ? CoreStrings.Approvals_DayHeading_2 : CoreStrings.Approvals_DayHeading_3(local.Month, local.Day);
    }
    public static string LongTime(DateTimeOffset at) => at.ToLocalTime().ToString(CoreStrings.Timeline_LongTime_1);

    // 最新ページは既存行の本文・配送状態を更新し、差分ページは30件を超える新着を補う。
    public static TimelineMessage[] Merge(IEnumerable<TimelineMessage> loaded, IEnumerable<TimelineMessage> updates)
    {
        var byId = loaded.ToDictionary(message => message.Id);
        foreach (var message in updates) byId[message.Id] = message;
        return byId.Values.OrderBy(message => message.At).ToArray();
    }
}