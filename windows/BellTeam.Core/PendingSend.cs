namespace BellTeam.Core;

// Mac ConversationTimelineState.PendingSend: the owner's own message shown from the moment the send starts.
// The server history stays the source of truth: the echo is only an overlay and is dropped once the accepted id shows up in it.
public sealed record PendingSend(string Id, string Body, int ImageCount, DateTimeOffset At, string? AcceptedId = null)
{
    public const string IdPrefix = "local-pending-";
    public static string NewId() => IdPrefix + Guid.NewGuid().ToString("D").ToUpperInvariant();
    public static bool IsLocal(string id) => id.StartsWith(IdPrefix, StringComparison.Ordinal);

    // Mac: "submitting" until the server acknowledged, then "accepted" (受付済み・反映待ち) until the history has the message.
    public TimelineMessage ToMessage() => new()
    {
        Id = Id, At = At, Kind = "message", Direction = "outgoing", Message = Body,
        Image = ImageCount > 0 ? true : null, ImageCount = ImageCount > 0 ? ImageCount : null,
        Delivery = AcceptedId is null ? "submitting" : "accepted"
    };

    // Mac visibleMessages: the received history, then every echo whose accepted id the history does not have yet.
    public static TimelineMessage[] Visible(IEnumerable<TimelineMessage> received, IEnumerable<PendingSend> pending)
    {
        var list = received.ToArray(); var ids = list.Select(message => message.Id).ToHashSet();
        return [.. list, .. pending.Where(item => item.AcceptedId is null || !ids.Contains(item.AcceptedId)).Select(item => item.ToMessage())];
    }

    // Mac reconcileAcceptedSends: an echo whose accepted id is in the history has done its job.
    public static List<PendingSend> Reconcile(IEnumerable<PendingSend> pending, IEnumerable<TimelineMessage> received)
    {
        var ids = received.Select(message => message.Id).ToHashSet();
        return pending.Where(item => item.AcceptedId is null || !ids.Contains(item.AcceptedId)).ToList();
    }
}
