namespace BellTeam.Core;

public sealed record QueueItem
{
    public required string Id { get; init; }
    public string? BotId { get; init; }
    public string? BotName { get; init; }
    public required string Status { get; init; }
    public string? Context { get; init; }
    public string? ContextId { get; init; }
    // A delivery steered into a running turn is shown with that turn's row.
    public bool? Steered { get; init; }
    public static QueueItem[] DisplayItems(IEnumerable<QueueItem> items)
        => items.DistinctBy(item => (item.BotId is not null, item.BotId ?? item.Id, item.BotId is null ? "" : item.Steered == true ? "running" : item.Status)).ToArray();
    public string Line(string fallbackName) => $"{BotName ?? fallbackName} · {(Status == "queued" ? "送信待ち" : "処理中")}";
    public bool IsActive => Status is "running" or "queued";
    // A room row gets the stop button only for the first active row of a member of that room.
    public static bool IsStopRow(QueueItem item, IReadOnlyList<QueueItem> display, bool isRoom, IEnumerable<string> roomMemberIds)
        => isRoom && item.BotId is { } id && item.IsActive && roomMemberIds.Contains(id) && display.First(candidate => candidate.BotId == id && candidate.IsActive).Id == item.Id;
}
public sealed record QueueResponse { public required QueueItem[] Items { get; init; } }

public enum BotStopOutcome { Sent, Confirmed }
// POST /api/bots/{id}/stop: 202 stop_sent, or 200 interrupted with the session preserved. Anything else is not a result.
public sealed record BotStopResponse
{
    public required string BotId { get; init; }
    public required string Status { get; init; }
    public bool? SessionPreserved { get; init; }
    public BotStopOutcome? Outcome(int httpStatus, string expectedBotId) => BotId != expectedBotId ? null : (httpStatus, Status) switch
    {
        (202, "stop_sent") => BotStopOutcome.Sent,
        (200, "interrupted") when SessionPreserved == true => BotStopOutcome.Confirmed,
        _ => null
    };
}
public sealed record StopNotice(string Message, bool IsError)
{
    public static readonly StopNotice Sent = new("停止操作を送りました。会話は続けられます。", false);
    public static readonly StopNotice Unconfirmed = new("停止操作の結果を確認できませんでした。状況を確認してから操作してください。", true);
    public static StopNotice Confirmed(string name) => new($"{name}は今、処理を実行していません。同じ会話で新しい依頼を続けられます。", false);
    public static StopNotice FromOutcome(BotStopOutcome outcome, string name) => outcome == BotStopOutcome.Sent ? Sent : Confirmed(name);
    public static StopNotice FromFailure(Exception error) => error is OperationCanceledException || BellApiException.IsResultUnconfirmed(error) ? Unconfirmed : new(error.Message, true);
}
