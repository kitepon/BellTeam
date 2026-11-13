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
    public const string Empty = "稼働中に数えない処理はありません。", OldServer = "このサーバーの版では、まだこの一覧を読めません。",
        Explain = "ここにある処理は、メンバーの席で動いていても「仕事中」に数えません。加えるのは、メンバーの提案を承認箱で承認した時だけです。";

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
        BellApiException { Status: HttpStatusCode.NotFound } => "この処理はもう一覧にありませんでした。",
        BellApiException { Status: HttpStatusCode.ServiceUnavailable } => "一覧を読めないため、外せませんでした。少し待ってから、もう一度試してください。",
        _ => "外せたか確かめられませんでした。一覧を読み直しています。" + error.Message
    };

    private static readonly TimeZoneInfo Jst = TimeZoneInfo.CreateCustomTimeZone("JST", TimeSpan.FromHours(9), "JST", "JST");
    private static string At(DateTimeOffset? value) => value is { } at ? TimeZoneInfo.ConvertTime(at, Jst).ToString("M月d日 HH:mm", System.Globalization.CultureInfo.InvariantCulture) : "";

    /// <summary>A process reads "&lt;exe&gt; &lt;args&gt;" (the words the card's reason shows); a child seat reads as that AI's child seat.</summary>
    public static string Summary(RunningExclusionEntry entry) => entry.Kind == "child"
        ? $"{(entry.Harness is { Length: > 0 } harness ? harness : "AI")}の子の席{(entry.Session is { Length: > 0 } session ? $"（{session}）" : "")}"
        : string.Join(" ", new[] { entry.Exe ?? "" }.Concat(entry.Args ?? []).Where(word => word.Length > 0)) is { Length: > 0 } words ? words : "名前の無い処理";

    public static string ScopeText(JsonElement scope, Func<string, string?> name) => scope.ValueKind switch
    {
        JsonValueKind.String when scope.GetString() == "all" => "全員",
        JsonValueKind.Array => scope.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String).Select(item => name(item.GetString()!) ?? "名簿にないメンバー").ToList() is { Count: > 0 } names ? string.Join("、", names) : "対象なし",
        _ => "対象なし"
    };

    public static IReadOnlyList<RunningExclusionRow> Entries(RunningExclusionList list, Func<string, string?> name) => list.Entries.Select(entry =>
    {
        var summary = Summary(entry); var scope = ScopeText(entry.Scope, name); var when = entry.ApprovedAt is { } at ? $"承認 {At(at)}" : "承認済み";
        return new RunningExclusionRow(entry.Id, entry.Kind == "child", summary, scope, when, entry.Reason is { Length: > 0 } reason ? reason : null, $"{summary}、対象 {scope}、{when}");
    }).ToList();

    public static IReadOnlyList<RunningExclusionRow> Pending(RunningExclusionList list, Func<string, string?> name) => list.Pending.Select(item =>
    {
        var listed = item.Action == "remove" ? list.Entries.FirstOrDefault(entry => entry.Id == item.Id) : null;
        var target = item.Entry ?? listed;
        var summary = item.Action == "remove" ? $"外す提案：{(target is null ? "一覧にない処理" : Summary(target))}" : $"加える提案：{(target is null ? "名前の無い処理" : Summary(target))}";
        var who = item.From is { Length: > 0 } from ? name(from) ?? "名簿にないメンバー" : "提案した人は分かりません";
        var when = $"提案 {who}{(item.FiledAt is { } at ? $"・{At(at)}" : "")}{(item.Approved ? "・承認済み、空きを待っています" : "")}";
        var scope = target is null ? "" : ScopeText(target.Scope, name);
        // A removal carries no reason of its own on the wire; the entry's reason is why it was added, so it is not shown here.
        return new RunningExclusionRow(null, target?.Kind == "child", summary, scope, when, item.Entry?.Reason is { Length: > 0 } reason ? reason : null, $"{summary}{(scope.Length > 0 ? $"、対象 {scope}" : "")}、{when}");
    }).ToList();
}
