namespace BellTeam.Core;

public sealed record QueueItem
{
    public required string Id { get; init; }
    public string? BotId { get; init; }
    public string? BotName { get; init; }
    public required string Status { get; init; }
    public string? Context { get; init; }
    public string? ContextId { get; init; }
    public static QueueItem[] DisplayItems(IEnumerable<QueueItem> items)
        => items.DistinctBy(item => (item.BotId is not null, item.BotId ?? item.Id, item.BotId is null ? "" : item.Status)).ToArray();
}
public sealed record QueueResponse { public required QueueItem[] Items { get; init; } }
