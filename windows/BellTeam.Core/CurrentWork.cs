using System.Text;
using System.Text.Json;

namespace BellTeam.Core;

public sealed record CurrentWork(string State, string? Summary, string SummaryStatus, DateTimeOffset? SummaryUpdatedAt, DateTimeOffset? ObservedAt, string? Source)
{
    public static CurrentWork? Read(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object) return null;
        string[] keys = ["state", "summary", "summaryStatus", "summaryUpdatedAt", "observedAt", "source"];
        var fields = value.EnumerateObject().ToArray();
        if (fields.Length != keys.Length || fields.Select(field => field.Name).Distinct().Count() != keys.Length || fields.Any(field => !keys.Contains(field.Name))) return null;
        string? String(string name) => value.GetProperty(name).ValueKind == JsonValueKind.String ? value.GetProperty(name).GetString() : null;
        bool Null(string name) => value.GetProperty(name).ValueKind == JsonValueKind.Null;
        DateTimeOffset? Date(string name) => value.GetProperty(name).ValueKind == JsonValueKind.String && value.GetProperty(name).TryGetDateTimeOffset(out var date) ? date : null;
        var state = String("state"); var status = String("summaryStatus"); var source = String("source"); var summary = String("summary");
        var updated = Date("summaryUpdatedAt"); var observed = Date("observedAt");
        if (state is not ("working" or "idle" or "unknown") || status is not ("current" or "stale" or "missing")) return null;
        if (state == "unknown" ? !(Null("observedAt") || observed is not null) : observed is null) return null;
        if (status == "missing")
        {
            if (!Null("summary") || !Null("summaryUpdatedAt") || !Null("source")) return null;
        }
        else
        {
            if (source is not ("background_agent" or "self_reported") || updated is null || source == "self_reported" && state != "working") return null;
            if (status == "stale" && !Null("summary")) return null;
            if (status == "current" && (summary is null || summary.Length == 0 || summary.Trim() != summary || summary.EnumerateRunes().Count() > 160 || summary.Any(c => char.IsControl(c) || c is '\u2028' or '\u2029'))) return null;
        }
        return new(state, summary, status, updated, observed, source);
    }
}

public static class CurrentWorkText
{
    public static string Bot(JsonElement value)
    {
        var work = CurrentWork.Read(value);
        if (work is null) return "仕事状況を未取得";
        if (work.SummaryStatus == "current")
        {
            var state = work.State switch { "idle" => "（待機中）", "unknown" => "（実行状態未取得）", _ => "" };
            var source = work.Source == "background_agent" ? "自動生成" : "本人記載";
            return work.Summary + state + "（" + source + "）";
        }
        if (work.SummaryStatus == "stale") return work.State switch { "working" => "作業中・要約期限切れ", "idle" => "待機中・要約期限切れ", _ => "実行状態未取得・要約期限切れ" };
        return work.State switch { "working" => "作業中・要約未取得", "idle" => "待機中", _ => "仕事状況を未取得" };
    }

    public static string Room(Room room, IEnumerable<Bot> bots)
    {
        var value = room.CurrentWork;
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("scope", out var scope) || scope.ValueKind != JsonValueKind.String || scope.GetString() != "participants" || !value.TryGetProperty("members", out var members) || members.ValueKind != JsonValueKind.Array) return "参加者の仕事要約を未取得";
        var names = bots.Where(bot => room.MemberIds.Contains(bot.Id)).GroupBy(bot => bot.Id).ToDictionary(group => group.Key, group => group.First().DisplayName);
        var unique = new HashSet<string>(); var summaries = new List<string>();
        foreach (var member in members.EnumerateArray())
        {
            if (member.ValueKind != JsonValueKind.Object || !member.TryGetProperty("botId", out var id) || id.ValueKind != JsonValueKind.String || id.GetString() is not { } key || !names.TryGetValue(key, out var name) || !unique.Add(key) || !member.TryGetProperty("currentWork", out var work)) continue;
            if (!string.IsNullOrWhiteSpace(name) && CurrentWork.Read(work) is { SummaryStatus: "current" } && summaries.Count < 2) summaries.Add(name + ": " + Bot(work));
        }
        if (summaries.Count == 0) return "参加者の仕事要約を未取得";
        var remaining = names.Count - summaries.Count;
        return "参加者の現在の仕事: " + string.Join("、", summaries) + (remaining > 0 ? "、ほか" + remaining + "人" : "");
    }
}
