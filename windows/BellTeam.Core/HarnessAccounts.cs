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
    public static string? SlotTitle(string? slot) => slot switch { "1st" => CoreStrings.HarnessAccounts_SlotTitle_1, "2nd" => CoreStrings.HarnessAccounts_SlotTitle_2, _ => null };

    // HH:mm in JST; with the date (M/d, as the Web does) when it is not today in JST. An unreadable time is null.
    public static string? ResetTime(string? iso, DateTimeOffset now)
    {
        if (!DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at)) return null;
        at = at.ToOffset(Jst); var today = now.ToOffset(Jst).Date;
        var time = at.ToString(CoreStrings.Pattern_TimePadded);
        return at.Date == today ? time : $"{at.ToString(CoreStrings.Pattern_MonthDay)} {time}";
    }
    // 'all' → 上限中 (HH:MMに解除); a family → Fableのみ上限中 (HH:MMに解除); no time → 解除時刻不明.
    public static string LimitText(string? scope, string? resetAt, DateTimeOffset now)
    {
        var family = string.IsNullOrEmpty(scope) || scope == "all" ? "" : CoreStrings.HarnessAccounts_LimitText_1(char.ToUpperInvariant(scope[0]) + scope[1..]);
        return CoreStrings.HarnessAccounts_LimitText_4(family, (ResetTime(resetAt, now) is { } time ? CoreStrings.HarnessAccounts_LimitText_2(time) : CoreStrings.HarnessAccounts_LimitText_3));
    }
    public static string[] BannerTexts(AccountsResponse? list, DateTimeOffset now)
        => (list?.Claude?.AllLimited ?? []).Select(item => CoreStrings.HarnessAccounts_BannerTexts_1(LimitText(item.Scope, item.EarliestResetAt, now))).ToArray();
    // Mac ClaudeAccountsCard: the account name only when the server sends one; the login state is the row's badge.
    public static string? Login(AccountSlot slot) => string.IsNullOrWhiteSpace(slot.Label) ? null : slot.Label;
    // Mac AccountText.bothLimited: the card's own banner wording (the member-list banner keeps BannerTexts, same as Web).
    public static string[] CardBannerTexts(AccountsResponse? list, DateTimeOffset now)
        => (list?.Claude?.AllLimited ?? []).Select(item => CoreStrings.HarnessAccounts_CardBannerTexts_5((string.IsNullOrEmpty(item.Scope) || item.Scope == "all" ? CoreStrings.HarnessAccounts_CardBannerTexts_1 : CoreStrings.HarnessAccounts_CardBannerTexts_2(ScopeName(item.Scope))), (ResetTime(item.EarliestResetAt, now) is { } time ? CoreStrings.HarnessAccounts_LimitText_2(time) : CoreStrings.HarnessAccounts_LimitText_3))).ToArray();
    // Mac AccountText.slotName / slotUsers / slotUsersLine / seats / limitLine (settings-user-flow B19/B20, #1117).
    public static string SlotName(string slot) => slot == "2nd" ? CoreStrings.HarnessAccounts_SlotName_1 : CoreStrings.HarnessAccounts_SlotName_2;
    // Members running on the slot now, from each bot's own account; null on an older body where no bot has an account (the row then says SeatsCount).
    public static int? SlotUsers(IEnumerable<SeatAccount?> accounts, string harness, string slot)
    {
        var list = accounts.ToList();
        return list.Any(item => item is not null) ? list.Count(item => item?.Harness == harness && item.Slot == slot) : null;
    }
    public static string SlotUsersLine(int count) => count == 0 ? CoreStrings.HarnessAccounts_SlotUsersLine_1 : CoreStrings.HarnessAccounts_SlotUsersLine_2(count);
    public static string SeatsCount(AccountSlot slot) => CoreStrings.HarnessAccounts_SeatsCount_1(slot.Seats.Length);
    // The Mac slot row (HarnessAuthenticationView): how many members run on the slot now from the bots' accounts, else how many seats used it on an older body, else nothing. Never names or ids.
    public static string? UsersLine(IEnumerable<SeatAccount?> accounts, string harness, AccountSlot slot)
        => SlotUsers(accounts, harness, slot.Slot) is { } count ? SlotUsersLine(count) : slot.Seats.Length > 0 ? SeatsCount(slot) : null;
    private static string ScopeName(string scope) => scope switch { "fable" => "Fable", "opus" => "Opus", "sonnet" => "Sonnet", "haiku" => "Haiku", _ => scope };
    // One limit line apart from the login badge: 「上限中・11/13 17:00に戻ります（いまは2つ目で動いています）」; null without a limit.
    public static string? LimitLine(AccountHarness harness, AccountSlot slot, DateTimeOffset now)
    {
        if (slot.Limits.Length == 0) return null;
        var all = slot.Limits.FirstOrDefault(item => item.Scope == "all");
        var what = all is not null ? CoreStrings.HarnessAccounts_CardBannerTexts_1 : CoreStrings.HarnessAccounts_CardBannerTexts_2(string.Join(CoreStrings.HarnessAccounts_LimitLine_2, slot.Limits.Select(item => ScopeName(item.Scope))));
        var earliest = (all is not null ? [all] : slot.Limits).Select(item => (Item: item, At: DateTimeOffset.TryParse(item.ResetAt, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at : (DateTimeOffset?)null))
            .Where(item => item.At is not null).OrderBy(item => item.At).Select(item => item.Item).FirstOrDefault();
        var when = ResetTime(earliest?.ResetAt, now) is { } time ? CoreStrings.HarnessAccounts_LimitLine_4(time) : CoreStrings.HarnessAccounts_LimitLine_5;
        var secondAvailable = harness.Slots.Any(item => item.Slot == "2nd" && item.LoggedIn == true && item.Limits.All(limit => limit.Scope != "all"));
        return what + when + (slot.Slot == "1st" && secondAvailable ? CoreStrings.HarnessAccounts_LimitLine_6 : "");
    }
    // The seat's slot on the member card; nothing for an absent/null account or another harness.
    public static string? SeatText(SeatAccount? account) => account?.Harness == "claude" ? SlotTitle(account.Slot) : null;
}
