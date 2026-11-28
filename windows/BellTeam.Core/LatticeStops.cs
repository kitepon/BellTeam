using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace BellTeam.Core;

// ブロック一覧 (docs/architecture/modules/lattice/README.md "Stops (blockers)"; screen in screen-spec.md "ブロック一覧").
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
    public static string Loading  => CoreStrings.LatticeStops_Loading_1;
    public static string Empty  => CoreStrings.LatticeStops_Empty_1;
    public static string Retry  => CoreStrings.LatticeStops_Retry_1;
    public static string Old  => CoreStrings.LatticeStops_Old_1;
    public static string Unread  => CoreStrings.LatticeStops_Unread_1;
    public static string Ask  => CoreStrings.LatticeStops_Ask_1;
    public static string Later  => CoreStrings.LatticeStops_Later_1;
    public static string Refused(string reason) => reason.Length > 0 ? CoreStrings.LatticeStops_Refused_1(reason) : CoreStrings.LatticeStops_Refused_2;

    private static readonly TimeZoneInfo Jst = TimeZoneInfo.CreateCustomTimeZone("JST", TimeSpan.FromHours(9), "JST", "JST");
    private static DateTimeOffset? At(string? value) => DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at : null;
    /// <summary>今日 HH:MM / 昨日 HH:MM / M月D日 HH:MM (JST); empty for a time that cannot be read.</summary>
    public static string StopTime(string? value, DateTimeOffset now)
    {
        if (At(value) is not { } at) return "";
        var local = TimeZoneInfo.ConvertTime(at, Jst); var today = TimeZoneInfo.ConvertTime(now, Jst).Date;
        var time = local.ToString(CoreStrings.Pattern_TimePadded);
        return local.Date == today ? CoreStrings.LatticeStops_StopTime_1(time) : local.Date == today.AddDays(-1) ? CoreStrings.LatticeStops_StopTime_2(time) : LatticeChart.FormatJst(at);
    }

    [GeneratedRegex("^bot-[0-9a-z]+$")] private static partial Regex BotId();
    /// <summary>担当・ブロックした人: a roster Bot id -> the member, another Bot id -> 名簿にないメンバー, "owner" -> the Owner, other text as written, null -> null (担当なし).</summary>
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
                var label = CoreStrings.LatticeStops_Rows_4(title, chart, (lane is null ? LatticeChart.Unassigned : CoreStrings.LatticeChart_CardNote_1(lane.Name)), (reason.Length > 0 ? CoreStrings.LatticeStops_Rows_2(reason) : ""), LatticeChart.NameOf(by), (time.Length > 0 ? CoreStrings.LatticeStops_Rows_3(time) : ""));
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
