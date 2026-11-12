using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace BellTeam.Core;

// 止め一覧 (docs/architecture/modules/lattice/README.md "Stops (blockers)"; screen in screen-spec.md "止め一覧").
// The calculations are a port of the pure part of web/lattice-stops.js.

public sealed record LatticeBlockers
{
    public string? Schema { get; init; }
    public LatticeStop?[]? Blockers { get; init; }
    public string[]? UnreadCharts { get; init; }
}
public sealed record LatticeStop
{
    public string? StopId { get; init; }
    public string? ProjectId { get; init; }
    public string? ChartName { get; init; }
    public string? ChartCreatedBy { get; init; }
    public string? CardId { get; init; }
    public string? Title { get; init; }
    public string? Lane { get; init; }
    public string? Reason { get; init; }
    // Kept as text: an unreadable time drops only that row's time, not the whole list.
    public string? BlockedAt { get; init; }
    public string? BlockedBy { get; init; }
}
public sealed record LatticeStopRow(string StopId, string ProjectId, string? CardId, string Title, string Chart, LatticePerson? Lane, string Reason, LatticePerson? By, string Time, string Label);
public enum LatticeUnblockKind { Drop, Refused, Later }
public sealed record LatticeUnblockOutcome(LatticeUnblockKind Kind, string Reason = "");

public static partial class LatticeStops
{
    public const string Schema = "bellteam.lattice-blockers.v1";
    public const string Loading = "止めを読んでいます…", Empty = "止まっている工程はありません。", Retry = "止め一覧を読み直しています…", Old = "このサーバーではまだ止め一覧を使えません。",
        Unread = "一部の工程表を読めませんでした。読めた分だけ表示しています。", Ask = "この止めを外しますか？", Later = "いまは外せませんでした。少し待ってからもう一度お試しください。";
    public static string Refused(string reason) => reason.Length > 0 ? $"外せませんでした: {reason}" : "外せませんでした";

    private static readonly TimeZoneInfo Jst = TimeZoneInfo.CreateCustomTimeZone("JST", TimeSpan.FromHours(9), "JST", "JST");
    private static DateTimeOffset? At(string? value) => DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at : null;
    /// <summary>今日 HH:MM / 昨日 HH:MM / M月D日 HH:MM (JST); empty for a time that cannot be read.</summary>
    public static string StopTime(string? value, DateTimeOffset now)
    {
        if (At(value) is not { } at) return "";
        var local = TimeZoneInfo.ConvertTime(at, Jst); var today = TimeZoneInfo.ConvertTime(now, Jst).Date;
        var time = local.ToString("HH:mm", CultureInfo.InvariantCulture);
        return local.Date == today ? $"今日 {time}" : local.Date == today.AddDays(-1) ? $"昨日 {time}" : LatticeChart.FormatJst(at);
    }

    [GeneratedRegex("^bot-[0-9a-z]+$")] private static partial Regex BotId();
    /// <summary>担当・止めた人: a roster Bot id -> the member, another Bot id -> 名簿にないメンバー, "owner" -> the Owner, other text as written, null -> null (担当なし).</summary>
    public static Func<string?, LatticePerson?> Face(Func<string, LatticePerson?> roster, string? ownerName, string ownerAvatarVersion)
    {
        var owner = new LatticePerson(LatticeChart.OwnerId, ownerName is { Length: > 0 } ? ownerName : LatticeChart.OwnerFallback, "amber", ownerAvatarVersion, true, IsOwner: true);
        return value => value is not { Length: > 0 } ? null : value == LatticeChart.OwnerId ? owner : roster(value)
            ?? (BotId().IsMatch(value) ? new LatticePerson(value, LatticeChart.UnknownMember, null, "", false) : new LatticePerson("", value, null, "", false, Authored: true));
    }

    /// <summary>The rows, newest blockedAt first (unreadable times last); a row without stopId or projectId is left out.</summary>
    public static IReadOnlyList<LatticeStopRow> Rows(IEnumerable<LatticeStop?>? stops, DateTimeOffset now, Func<string, LatticePerson?> roster, string? ownerName = null, string ownerAvatarVersion = "")
    {
        var face = Face(roster, ownerName, ownerAvatarVersion);
        return (stops ?? []).OfType<LatticeStop>().Where(stop => stop.StopId is { Length: > 0 } && stop.ProjectId is { Length: > 0 })
            .OrderByDescending(stop => At(stop.BlockedAt) ?? DateTimeOffset.MinValue)
            .Select(stop =>
            {
                var title = stop.Title ?? ""; var chart = LatticeChart.ChartName(stop.ChartName, stop.ChartCreatedBy, id => roster(id)?.Name); var reason = stop.Reason ?? "";
                var lane = face(stop.Lane); var by = face(stop.BlockedBy); var time = StopTime(stop.BlockedAt, now);
                var label = $"止まり、{title}、{chart}、{(lane is null ? LatticeChart.Unassigned : $"担当 {lane.Name}")}{(reason.Length > 0 ? $"、理由 {reason}" : "")}、{LatticeChart.NameOf(by)}が{(time.Length > 0 ? $"{time}に" : "")}止めました";
                return new LatticeStopRow(stop.StopId!, stop.ProjectId!, stop.CardId, title, chart, lane, reason, by, time, label);
            }).ToList();
    }

    /// <summary>外す's answer: Drop (removed / already-gone), Refused (409, Lattice's reason), Later (anything else).</summary>
    public static LatticeUnblockOutcome Outcome(int? status, string? outcome, string? reason)
        => status == 200 && outcome is "removed" or "already-gone" ? new(LatticeUnblockKind.Drop) : status == 409 ? new(LatticeUnblockKind.Refused, reason ?? "") : new(LatticeUnblockKind.Later);

    public static Task<LatticeBlockers> BlockersAsync(this BellApi api, CancellationToken token = default) => api.GetAsync<LatticeBlockers>("/api/lattice/blockers", token);
    /// <summary>POST unblock {stopId}. Never throws but on cancel: an unknown answer is Later, and re-sending it later is harmless (already-gone).</summary>
    public static async Task<LatticeUnblockOutcome> UnblockAsync(this BellApi api, string projectId, string stopId, CancellationToken token = default)
    {
        try
        {
            var answer = await api.PostAsync<JsonElement>($"/api/lattice/charts/{Uri.EscapeDataString(projectId)}/unblock", new { stopId }, token);
            return Outcome(200, answer.ValueKind == JsonValueKind.Object && answer.TryGetProperty("outcome", out var outcome) && outcome.ValueKind == JsonValueKind.String ? outcome.GetString() : null, null);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (BellApiException error) { return Outcome((int?)error.Status, null, error.Reason); }
        catch (Exception) { return new(LatticeUnblockKind.Later); }
    }
}
