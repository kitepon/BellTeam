namespace BellTeam.Core;

public sealed record MessageNotification(string Server, ChatTarget? Target, string Title, string Body, string Kind = "message", string? MessageId = null)
{
    public static MessageNotification? FromRecent(string server, ChatTarget target, string title, RecentMessage? previous, RecentMessage? current)
    {
        if (current is null || current.Id == previous?.Id || current.Kind is "peer" or "interim" || current.Sender?.Id == "scheduler") return null;
        var incoming = target.IsRoom ? current.Sender is { Id: not "user" } : current.Direction == "incoming";
        if (!incoming) return null;
        var body = current.Kind switch
        {
            "secret_request" => CoreStrings.MessageNotification_FromRecent_1,
            "owner_question" => CoreStrings.MessageNotification_FromRecent_2,
            _ => target.IsRoom ? CoreStrings.MessageNotification_FromRecent_3 : CoreStrings.MessageNotification_FromRecent_4
        };
        var heading = target.IsRoom ? $"{current.Sender?.Name ?? current.Sender?.DisplayName ?? CoreStrings.MessageNotification_FromRecent_5} · {title}" : title;
        return new(server,target,heading,body);
    }
}
