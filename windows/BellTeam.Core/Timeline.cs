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
        "submitting" => "受付確認中", "accepted" => "受付済み・反映待ち", "queued" => "送信待ち", "running" => "処理中",
        "stopped" => "中断", "delivered" => "配達済み", "failed" => "配達失敗", _ => ""
    };

    public static string DeliveryLabel(TimelineMessage message, bool isRoom)
    {
        if (!message.IsOutgoing) return "";
        var existing = StatusText(DeliveryStatus(message));
        if (!isRoom) return message.Delivery == "failed" && AcceptedUnknown(message.DeliveryTracking) ? "受付済み・完了未確認" : existing;
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
        return hasUnknown ? hasFailure ? "配達失敗" : "完了未確認の宛先あり" : existing;
    }

    // Under a room message: who was chosen to reply. The names come from the caller so Core stays free of member lists.
    public static string? ReplyLabel(TimelineMessage message, bool isRoom, Func<string, string?> memberName)
    {
        if (!isRoom || message.Routing.ValueKind != JsonValueKind.Object || !message.Routing.TryGetProperty("status", out var status) || status.ValueKind != JsonValueKind.String) return null;
        switch (status.GetString())
        {
            case "pending": return "返信者を判定中";
            case "failed": return "返信者の判定に失敗";
            case "ready":
                var names = message.Routing.TryGetProperty("responders", out var responders) && responders.ValueKind == JsonValueKind.Array
                    ? responders.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String).Select(item => memberName(item.GetString()!) ?? item.GetString()!).ToArray() : [];
                return "返信: " + (names.Length == 0 ? "なし" : string.Join("、", names));
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
    public static string? OriginMark(MessageOrigin origin) => origin.Kind switch { "forward" => "転送", "share" => origin.App is { Length: > 0 } app ? "共有 · " + app : "共有", _ => null };
    // Plain words for the refusals of a forward (forward.md "Failure handling"); anything else keeps the server's own message.
    public static string ForwardRefusal(BellApiException error) => error.Code switch
    {
        "FILE_NOT_SUPPORTED" => "画像つきの発言はまだ転送できません。本文だけを新しいメッセージとして送ってください。",
        "FORWARD_SOURCE_NOT_FOUND" => "転送する発言が見つかりません。画面を更新してから、もう一度お試しください。",
        "FILE_TOO_LARGE" or "TOO_MANY_FILES" => "ファイルは1つ20MiBまで、1回に5つまでです。小さくするか分けて送ってください。",
        "ORIGIN_INVALID" => "転送の内容を受け付けられませんでした。",
        _ => error.Message
    };
    // Plain words for the refusals of a share-in (forward.md "Failure handling"); anything else keeps the server's own message.
    public static string ShareRefusal(BellApiException error) => error.Code switch
    {
        "FILE_NOT_SUPPORTED" => "画像ではないファイルはまだ共有できません。ファイルを外して、文章・URL・画像だけを送ってください。",
        "FILE_TOO_LARGE" or "TOO_MANY_FILES" => "ファイルは1つ20MiBまで、1回に5つまでです。小さくするか分けて送ってください。",
        "ORIGIN_INVALID" => "共有の内容を受け付けられませんでした。文章は2万字まで、URLは20個までです。",
        _ => error.Message
    };
    public const string UnavailableQuote = "元のメッセージを表示できません";
    public const string QuoteNotFound = "元のメッセージは見つかりません";
    // reply.md "What the client draws": an unavailable part shows its saved excerpt and the fixed line under it; an unavailable whole-message reply shows only the fixed line.
    public static string QuoteBody(ReplyReference quote) => !quote.Available && !quote.Part ? UnavailableQuote : quote.Text.Length == 0 ? quote.Image ? "（画像）" : "" : quote.Truncated ? quote.Text + "…" : quote.Text;
    public static string? QuoteNote(ReplyReference quote) => !quote.Available && quote.Part ? UnavailableQuote : null;

    // Mac BellDate.short / BellDate.long.
    private static readonly System.Globalization.CultureInfo Japanese = new("ja-JP");
    public static string ShortTime(DateTimeOffset at, DateTimeOffset now)
    {
        var local = at.ToLocalTime(); var today = now.ToLocalTime().Date;
        return local.Date == today ? local.ToString("H:mm", System.Globalization.CultureInfo.InvariantCulture) : local.Date == today.AddDays(-1) ? "昨日" : $"{local.Month}月{local.Day}日";
    }
    public static string LongTime(DateTimeOffset at) => at.ToLocalTime().ToString("M月d日(ddd) H:mm", Japanese);

    // 最新ページは既存行の本文・配送状態を更新し、差分ページは30件を超える新着を補う。
    public static TimelineMessage[] Merge(IEnumerable<TimelineMessage> loaded, IEnumerable<TimelineMessage> updates)
    {
        var byId = loaded.ToDictionary(message => message.Id);
        foreach (var message in updates) byId[message.Id] = message;
        return byId.Values.OrderBy(message => message.At).ToArray();
    }
}