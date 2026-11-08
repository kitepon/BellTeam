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
