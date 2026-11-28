using System.Net;
using System.Text.Json;

namespace BellTeam.Core;

// 稼働中に数えない処理 (a65): the Owner reads the list and removes an entry (execution current-work.md "Owner read and remove (a62)").
// Adding is only a member's proposal answered in Approval Box, so the pending rows show what waits for his answer and have no button.

public sealed record RunningExclusionList
{
    public RunningExclusionEntry[] Entries { get; init; } = [];
    public RunningExclusionPending[] Pending { get; init; } = [];
}
public sealed record RunningExclusionEntry
{
    public string Id { get; init; } = "";
    public string Kind { get; init; } = "process";
    public string? Exe { get; init; }
    public string[]? Args { get; init; }
    public string? Harness { get; init; }
    public string? Session { get; init; }
    /// <summary>"all" or an array of Bot ids; anything else reads as nobody named.</summary>
    public JsonElement Scope { get; init; }
    public string? DecisionId { get; init; }
    public DateTimeOffset? ApprovedAt { get; init; }
    public string? Reason { get; init; }
}
public sealed record RunningExclusionPending
{
    public string Action { get; init; } = "add";
    public RunningExclusionEntry? Entry { get; init; }
    public string? Id { get; init; }
    public string? DecisionId { get; init; }
    public string? From { get; init; }
    public DateTimeOffset? FiledAt { get; init; }
    public bool Approved { get; init; }
}

/// <summary>One row: Child picks the icon (an AI child seat, else a process). Id is set only on a listed entry (the 外す target).</summary>
public sealed record RunningExclusionRow(string? Id, bool Child, string Summary, string Scope, string When, string? Reason, string Label);

public enum RunningExclusionsRead { Listed, OldServer, Unavailable, Failed }

public static class RunningExclusions
{
    public const string Path = "/api/running-exclusions";
    public static string Empty  => CoreStrings.RunningExclusions_Empty_1;
    public static string OldServer  => CoreStrings.RunningExclusions_OldServer_1;
    public static string Explain  => CoreStrings.RunningExclusions_Explain_1;

    public static Task<RunningExclusionList> ListAsync(this BellApi api, CancellationToken token = default) => api.GetAsync<RunningExclusionList>(Path, token);
    public static Task RemoveAsync(this BellApi api, string id, CancellationToken token = default) => api.DeleteAsync($"{Path}/{Uri.EscapeDataString(id)}", token);

    public static RunningExclusionsRead Failure(Exception error) => error switch
    {
        BellApiException { Status: HttpStatusCode.NotFound } => RunningExclusionsRead.OldServer,
        BellApiException { Status: HttpStatusCode.ServiceUnavailable } => RunningExclusionsRead.Unavailable,
        _ => RunningExclusionsRead.Failed
    };
    /// <summary>The line after a 外す that did not answer {removed}: the list is read again either way, never re-sent.</summary>
    public static string RemoveFailure(Exception error) => error switch
    {
        BellApiException { Status: HttpStatusCode.NotFound } => CoreStrings.RunningExclusions_RemoveFailure_1,
        BellApiException { Status: HttpStatusCode.ServiceUnavailable } => CoreStrings.RunningExclusions_RemoveFailure_2,
        _ => CoreStrings.RunningExclusions_RemoveFailure_3(error.Message)
    };

    private static readonly TimeZoneInfo Jst = TimeZoneInfo.CreateCustomTimeZone("JST", TimeSpan.FromHours(9), "JST", "JST");
    private static string At(DateTimeOffset? value) => value is { } at ? TimeZoneInfo.ConvertTime(at, Jst).ToString(CoreStrings.LatticeChart_FormatJst_1) : "";

    /// <summary>A process reads "&lt;exe&gt; &lt;args&gt;" (the words the card's reason shows); a child seat reads as that AI's child seat.</summary>
    public static string Summary(RunningExclusionEntry entry) => entry.Kind == "child"
        ? CoreStrings.RunningExclusions_Summary_2((entry.Harness is { Length: > 0 } harness ? harness : "AI"), (entry.Session is { Length: > 0 } session ? CoreStrings.AppLogin_RefusedText_4(session) : ""))
        : string.Join(" ", new[] { entry.Exe ?? "" }.Concat(entry.Args ?? []).Where(word => word.Length > 0)) is { Length: > 0 } words ? words : CoreStrings.RunningExclusions_Summary_3;

    public static string ScopeText(JsonElement scope, Func<string, string?> name) => scope.ValueKind switch
    {
        JsonValueKind.String when scope.GetString() == "all" => CoreStrings.RunningExclusions_ScopeText_1,
        JsonValueKind.Array => scope.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String).Select(item => name(item.GetString()!) ?? CoreStrings.LatticeChart_UnknownMember_1).ToList() is { Count: > 0 } names ? string.Join(CoreStrings.Approvals_CardRow_3, names) : CoreStrings.RunningExclusions_ScopeText_4,
        _ => CoreStrings.RunningExclusions_ScopeText_4
    };

    public static IReadOnlyList<RunningExclusionRow> Entries(RunningExclusionList list, Func<string, string?> name) => list.Entries.Select(entry =>
    {
        var summary = Summary(entry); var scope = ScopeText(entry.Scope, name); var when = entry.ApprovedAt is { } at ? CoreStrings.RunningExclusions_Entries_1(At(at)) : CoreStrings.RunningExclusions_Entries_2;
        return new RunningExclusionRow(entry.Id, entry.Kind == "child", summary, scope, when, entry.Reason is { Length: > 0 } reason ? reason : null, CoreStrings.RunningExclusions_Entries_3(summary, scope, when));
    }).ToList();

    public static IReadOnlyList<RunningExclusionRow> Pending(RunningExclusionList list, Func<string, string?> name) => list.Pending.Select(item =>
    {
        var listed = item.Action == "remove" ? list.Entries.FirstOrDefault(entry => entry.Id == item.Id) : null;
        var target = item.Entry ?? listed;
        var summary = item.Action == "remove" ? CoreStrings.RunningExclusions_Pending_2((target is null ? CoreStrings.RunningExclusions_Pending_1 : Summary(target))) : CoreStrings.RunningExclusions_Pending_4((target is null ? CoreStrings.RunningExclusions_Summary_3 : Summary(target)));
        var who = item.From is { Length: > 0 } from ? name(from) ?? CoreStrings.LatticeChart_UnknownMember_1 : CoreStrings.RunningExclusions_Pending_6;
        var when = CoreStrings.RunningExclusions_Pending_9(who, (item.FiledAt is { } at ? CoreStrings.RunningExclusions_Pending_7(At(at)) : ""), (item.Approved ? CoreStrings.RunningExclusions_Pending_8 : ""));
        var scope = target is null ? "" : ScopeText(target.Scope, name);
        // A removal carries no reason of its own on the wire; the entry's reason is why it was added, so it is not shown here.
        return new RunningExclusionRow(null, target?.Kind == "child", summary, scope, when, item.Entry?.Reason is { Length: > 0 } reason ? reason : null, CoreStrings.RunningExclusions_Pending_11(summary, (scope.Length > 0 ? CoreStrings.RunningExclusions_Pending_10(scope) : ""), when));
    }).ToList();
}
