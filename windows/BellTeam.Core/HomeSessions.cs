namespace BellTeam.Core;

// a529x (app-sessions.md 4a): one row per device login of the user's server, read from the home part (GET /api/home/sessions); ended with DELETE /api/home/sessions/{id}.
public sealed record HomeSessionEntry
{
    public string Id { get; init; } = "";
    public string Kind { get; init; } = "";        // account | console
    public string AppKind { get; init; } = "";     // what the app sent when it signed in: apple | windows | linux | android | web
    public string? PassId { get; init; }           // never used on a PC: shutting a device out (stop at the operator) is phone-only
    public string State { get; init; } = "";
    public DateTimeOffset? Created { get; init; }
    public DateTimeOffset? LastUse { get; init; }
    public bool Current { get; init; }
}
public sealed record HomeSessionList { public HomeSessionEntry[] Sessions { get; init; } = []; }

// The words of the screen (ruled by Tronie/Mint 2026-11-23, docs/architecture/modules/apple/sessions-screen.md; the Mac screen is the reference).
public static class HomeSessionText
{
    public static string Title  => CoreStrings.HomeSessions_Title_1;
    public static string ThisApp  => CoreStrings.HomeSessions_ThisApp_1;
    public static string OwnRow  => CoreStrings.HomeSessions_OwnRow_1;
    public static string EndHere  => CoreStrings.HomeSessions_EndHere_1;
    public static string Loading  => CoreStrings.HomeSessions_Loading_1;
    // shortcut: an appKind the table does not know is shown as sent, when a new platform appears add its row here.
    public static string KindOf(HomeSessionEntry row) => row.Kind == "console" ? CoreStrings.HomeSessions_KindOf_1 : row.AppKind switch
    {
        "apple" => CoreStrings.HomeSessions_KindOf_2, "windows" => "Windows", "linux" => "Linux", "android" => "Android", "web" => "Web", var other => other.Length == 0 ? "Web" : other
    };
    public static string Times(HomeSessionEntry row) => (row.Created is { } created ? CoreStrings.HomeSessions_Times_1(Time(created)) : "") + (row.LastUse is { } last ? CoreStrings.HomeSessions_Times_3((row.Created is null ? "" : CoreStrings.HarnessAccounts_LimitLine_2), Time(last)) : "");
    public static string Time(DateTimeOffset time) => time.ToLocalTime().ToString(CoreStrings.Pattern_DateTime);
    // Summary line under the title (Tronie 2026-11-23, apple/sessions-screen.md): n counts every row, this device included.
    public static string Summary(int count) => count == 1 ? CoreStrings.HomeSessions_Summary_1 : CoreStrings.HomeSessions_Summary_2(count);
    // Generic device glyphs, no brand marks (Tronie 2026-11-23): apple and android -> phone (the library does not say iPad or Mac), windows and linux -> desktop, web, console; an unknown kind takes web.
    public static string IconKey(HomeSessionEntry row) => row.Kind == "console" ? "console" : row.AppKind switch { "apple" or "android" => "phone", "windows" or "linux" => "desktop", _ => "web" };
    public static string Button(HomeSessionEntry row) => row.Current ? OwnRow : EndHere;
}
