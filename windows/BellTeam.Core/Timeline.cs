namespace BellTeam.Core;

public static class Timeline
{
    // 最新ページは既存行の本文・配送状態を更新し、差分ページは30件を超える新着を補う。
    public static TimelineMessage[] Merge(IEnumerable<TimelineMessage> loaded, IEnumerable<TimelineMessage> updates)
    {
        var byId = loaded.ToDictionary(message => message.Id);
        foreach (var message in updates) byId[message.Id] = message;
        return byId.Values.OrderBy(message => message.At).ToArray();
    }
}
