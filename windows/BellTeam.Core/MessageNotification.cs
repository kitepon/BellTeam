namespace BellTeam.Core;

public sealed record MessageNotification(string Server, ChatTarget Target, string Title, string Preview)
{
    public static MessageNotification? FromRecent(string server, ChatTarget target, string title, RecentMessage? previous, RecentMessage? current)
    {
        if (current is null || current.Id == previous?.Id || current.Kind is "peer" or "interim" || current.Sender?.Id == "scheduler") return null;
        var incoming = target.IsRoom ? current.Sender is { Id: not "user" } : current.Direction == "incoming";
        return incoming ? new(server, target, title, current.Preview) : null;
    }
}
