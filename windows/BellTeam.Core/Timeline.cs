using System.Text.Json;

namespace BellTeam.Core;

public static class Timeline
{
    private static bool Matches(JsonElement value, string key, string expected) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var field) && field.ValueKind == JsonValueKind.String && field.GetString() == expected;

    private static bool AcceptedUnknown(JsonElement value) => Matches(value, "schema", "bellteam.delivery-tracking.v1") && Matches(value, "admission", "accepted") && Matches(value, "completion", "unknown");

    public static string DeliveryLabel(TimelineMessage message, bool isRoom)
    {
        if (!message.IsOutgoing) return "";
        var existing = message.Delivery switch { "failed" => "配達失敗", "queued" => "送信待ち", "running" => "処理中", "delivered" => "配達済み", _ => "" };
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

    // 最新ページは既存行の本文・配送状態を更新し、差分ページは30件を超える新着を補う。
    public static TimelineMessage[] Merge(IEnumerable<TimelineMessage> loaded, IEnumerable<TimelineMessage> updates)
    {
        var byId = loaded.ToDictionary(message => message.Id);
        foreach (var message in updates) byId[message.Id] = message;
        return byId.Values.OrderBy(message => message.At).ToArray();
    }
}
