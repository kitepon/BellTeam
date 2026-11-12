using System.Globalization;
using System.Net;

namespace BellTeam.Core;

// Claude's 「1stアカウント」/「2ndアカウント」 (docs/architecture/modules/execution/harness-accounts.md, "Public interfaces" and "Public HTTP").
// The server owns slot selection and limit detection; this file only reads accounts.list and sends the one rule the switch controls.
public sealed record AccountLimit(string Scope, string? Since, string? ResetAt, string? ResetSource);
public sealed record AccountSlot
{
    public string Slot { get; init; } = "";
    public bool? LoggedIn { get; init; }
    public string? Label { get; init; }
    public string? History { get; init; }
    public AccountLimit[] Limits { get; init; } = [];
    public string[] Seats { get; init; } = [];
    // Set when the slot's credentials were signed out; the login then needs doing again even if the CLI still answers authenticated.
    public string? SignedOutAt { get; init; }
}
public sealed record AccountAllLimited(string Scope, string? EarliestResetAt);
public sealed record AccountHarness
{
    public string Harness { get; init; } = "";
    public AccountSlot[] Slots { get; init; } = [];
    public AccountAllLimited[] AllLimited { get; init; } = [];
}
public sealed record AccountsResponse
{
    public AccountHarness[] Harnesses { get; init; } = [];
    public AccountHarness? Claude => Harnesses.FirstOrDefault(item => item.Harness == "claude" && item.Slots.Length != 0);
}
// Bot item 'account' (transport.seatAccount): absent on older bodies and null for a seat without a slot.
// Limits alone pick the slot (Owner ruling 2026-11-09), so the server's preferredSlot is not read.
public sealed record SeatAccount(string? Harness, string? Slot);

public sealed class HarnessAccountsApi(BellApi api)
{
    // null means an older body (HTTP 404 of GET /api/accounts): the caller shows the old single Claude card. Any other failure throws.
    public async Task<AccountsResponse?> ReadAsync(CancellationToken token = default)
    {
        try { return await api.GetAsync<AccountsResponse>("/api/accounts", token); }
        catch (BellApiException error) when (error.Status == HttpStatusCode.NotFound) { return null; }
    }
}

public static class AccountText
{
    private static readonly TimeSpan Jst = TimeSpan.FromHours(9);
    public static string? SlotTitle(string? slot) => slot switch { "1st" => "1stアカウント", "2nd" => "2ndアカウント", _ => null };

    // HH:mm in JST; with the date (M/d, as the Web does) when it is not today in JST. An unreadable time is null.
    public static string? ResetTime(string? iso, DateTimeOffset now)
    {
        if (!DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at)) return null;
        at = at.ToOffset(Jst); var today = now.ToOffset(Jst).Date;
        var time = at.ToString("HH:mm", CultureInfo.InvariantCulture);
        return at.Date == today ? time : $"{at.Month}/{at.Day} {time}";
    }
    // 'all' → 上限中 (HH:MMに解除); a family → Fableのみ上限中 (HH:MMに解除); no time → 解除時刻不明.
    public static string LimitText(string? scope, string? resetAt, DateTimeOffset now)
    {
        var family = string.IsNullOrEmpty(scope) || scope == "all" ? "" : char.ToUpperInvariant(scope[0]) + scope[1..] + "のみ";
        return $"{family}上限中 ({(ResetTime(resetAt, now) is { } time ? time + "に解除" : "解除時刻不明")})";
    }
    public static string[] BannerTexts(AccountsResponse? list, DateTimeOffset now)
        => (list?.Claude?.AllLimited ?? []).Select(item => "両方のアカウントで" + LimitText(item.Scope, item.EarliestResetAt, now)).ToArray();
    // Mac ClaudeAccountsCard: the account name only when the server sends one; the login state is the row's badge.
    public static string? Login(AccountSlot slot) => string.IsNullOrWhiteSpace(slot.Label) ? null : slot.Label;
    // Mac AccountText.bothLimited: the card's own banner wording (the member-list banner keeps BannerTexts, same as Web).
    public static string[] CardBannerTexts(AccountsResponse? list, DateTimeOffset now)
        => (list?.Claude?.AllLimited ?? []).Select(item => $"1つ目と2つ目のアカウントがどちらも{(string.IsNullOrEmpty(item.Scope) || item.Scope == "all" ? "上限中" : ScopeName(item.Scope) + "が上限中")}です（{(ResetTime(item.EarliestResetAt, now) is { } time ? time + "に解除" : "解除時刻不明")}）").ToArray();
    // The members' names (Linux settings); Windows says SlotUsersLine / SeatsCount instead (settings-user-flow B20).
    public static string? Seats(AccountSlot slot, Func<string, string?> name) => slot.Seats.Length == 0 ? null : "使用中: " + string.Join("、", slot.Seats.Select(id => name(id) ?? id));
    // Mac AccountText.slotName / slotUsers / slotUsersLine / seats / limitLine (settings-user-flow B19/B20, #1117).
    public static string SlotName(string slot) => slot == "2nd" ? "2つ目のアカウント" : "1つ目のアカウント";
    // Members running on the slot now, from each bot's own account; null on an older body where no bot has an account (the row then says SeatsCount).
    public static int? SlotUsers(IEnumerable<SeatAccount?> accounts, string harness, string slot)
    {
        var list = accounts.ToList();
        return list.Any(item => item is not null) ? list.Count(item => item?.Harness == harness && item.Slot == slot) : null;
    }
    public static string SlotUsersLine(int count) => count == 0 ? "いまこのアカウントで動いているメンバーはいません" : $"いま{count}人がこのアカウントで動いています";
    public static string SeatsCount(AccountSlot slot) => $"{slot.Seats.Length}人が使用";
    private static string ScopeName(string scope) => scope switch { "fable" => "Fable", "opus" => "Opus", "sonnet" => "Sonnet", "haiku" => "Haiku", _ => scope };
    // One limit line apart from the login badge: 「上限中・11/13 17:00に戻ります（いまは2つ目で動いています）」; null without a limit.
    public static string? LimitLine(AccountHarness harness, AccountSlot slot, DateTimeOffset now)
    {
        if (slot.Limits.Length == 0) return null;
        var all = slot.Limits.FirstOrDefault(item => item.Scope == "all");
        var what = all is not null ? "上限中" : string.Join("・", slot.Limits.Select(item => ScopeName(item.Scope))) + "が上限中";
        var earliest = (all is not null ? [all] : slot.Limits).Select(item => (Item: item, At: DateTimeOffset.TryParse(item.ResetAt, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at : (DateTimeOffset?)null))
            .Where(item => item.At is not null).OrderBy(item => item.At).Select(item => item.Item).FirstOrDefault();
        var when = ResetTime(earliest?.ResetAt, now) is { } time ? $"・{time}に戻ります" : "・戻る時刻は分かりません";
        var secondAvailable = harness.Slots.Any(item => item.Slot == "2nd" && item.LoggedIn == true && item.Limits.All(limit => limit.Scope != "all"));
        return what + when + (slot.Slot == "1st" && secondAvailable ? "（いまは2つ目で動いています）" : "");
    }
    // The seat's slot on the member card; nothing for an absent/null account or another harness.
    public static string? SeatText(SeatAccount? account) => account?.Harness == "claude" ? SlotTitle(account.Slot) : null;
}
