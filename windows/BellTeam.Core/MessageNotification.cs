namespace BellTeam.Core;

public sealed record MessageNotification(string Server, ChatTarget Target, string Title, string Body)
{
    public static MessageNotification? FromRecent(string server, ChatTarget target, string title, RecentMessage? previous, RecentMessage? current)
    {
        if (current is null || current.Id == previous?.Id || current.Kind is "peer" or "interim" || current.Sender?.Id == "scheduler") return null;
        var incoming = target.IsRoom ? current.Sender is { Id: not "user" } : current.Direction == "incoming";
        if (!incoming) return null;
        var body = current.Kind switch
        {
            "secret_request" => "秘密情報の入力が必要です。",
            "owner_question" => "選んでほしいことがあります。",
            _ => target.IsRoom ? "ルームに新しいメッセージが届きました。" : "返信が届きました。"
        };
        var heading = target.IsRoom ? $"{current.Sender?.Name ?? current.Sender?.DisplayName ?? "メンバー"} · {title}" : title;
        return new(server,target,heading,body);
    }
}
