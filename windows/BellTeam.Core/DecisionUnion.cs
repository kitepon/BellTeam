namespace BellTeam.Core;

/// <summary>
/// Until the /v1 close (Delta, 2026-11-22) the 決裁箱 list is the union of the server read (/api/approvals/*) and this device's peer-channel session, keyed by decision id, the device copy winning.
/// A decision only the server holds stays; becoming verified on the device never removes it. An answer goes through the source that holds the copy shown, never through both.
/// </summary>
public static class DecisionUnion
{
    public const string Server = "server", Device = "device";

    public static IReadOnlyList<ViewDecision> Merge(IEnumerable<ViewDecision> server, IEnumerable<ViewDecision> device)
    {
        var mine = device.Select(item => item with { Source = Device }).ToList(); var ids = mine.Select(item => item.Id).ToHashSet();
        return [.. mine, .. server.Where(item => !ids.Contains(item.Id)).Select(item => item with { Source = Server })];
    }

    /// <summary>The counts of the entry row and the toolbar: the server's summary plus what only the device holds (ids absent from the server's loaded lists). An unloaded 済み list can count a decision twice; that is the known limit.</summary>
    public static ApprovalSummary Summary(ApprovalSummary? server, IEnumerable<ViewDecision> serverKnown, IEnumerable<ViewDecision> device, DateTimeOffset now)
    {
        var known = serverKnown.Select(item => item.Id).ToHashSet(); var only = device.Where(item => !known.Contains(item.Id)).ToList();
        bool Today(string? at) => Approvals.DayHeading(at, now) == "今日";
        return new ApprovalSummary
        {
            Schema = Approvals.SummarySchema,
            Pending = (server?.Pending ?? 0) + only.Count(item => item.Status == "pending"),
            Held = (server?.Held ?? 0) + only.Count(item => item.Status == "held"),
            Urgent = (server?.Urgent ?? 0) + only.Count(item => item.Status is "pending" or "held" && item.Urgency == "high"),
            AnsweredToday = (server?.AnsweredToday ?? 0) + only.Count(item => item.Status == "answered" && Today(Approvals.DoneAt(item))),
            FiledToday = (server?.FiledToday ?? 0) + only.Count(item => Today(item.CreatedAt)),
            ByOrigin = server?.ByOrigin,
        };
    }
}
