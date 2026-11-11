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
    public static string State(AccountSlot slot, DateTimeOffset now)
        => slot.Limits.Length != 0 ? string.Join("・", slot.Limits.Select(item => LimitText(item.Scope, item.ResetAt, now))) : slot.LoggedIn == true ? "利用できます" : "—";
    // The seat's slot on the member card; nothing for an absent/null account or another harness.
    public static string? SeatText(SeatAccount? account) => account?.Harness == "claude" ? SlotTitle(account.Slot) : null;
}
