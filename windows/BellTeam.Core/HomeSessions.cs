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
    public const string Title = "このサーバーに入っている端末", ThisApp = "このアプリ", OwnRow = "ログアウト", EndHere = "ログアウトさせる", Loading = "読み込んでいます…";
    // shortcut: an appKind the table does not know is shown as sent, when a new platform appears add its row here.
    public static string KindOf(HomeSessionEntry row) => row.Kind == "console" ? "サーバーのコンソールのコード" : row.AppKind switch
    {
        "apple" => "iPhone・iPad・Mac", "windows" => "Windows", "linux" => "Linux", "android" => "Android", "web" => "Web", var other => other.Length == 0 ? "Web" : other
    };
    public static string Times(HomeSessionEntry row) => (row.Created is { } created ? "入った日時 " + Time(created) : "") + (row.LastUse is { } last ? (row.Created is null ? "" : "・") + "最後に使った日時 " + Time(last) : "");
    public static string Time(DateTimeOffset time) => time.ToLocalTime().ToString("yyyy/M/d H:mm");
    // Summary line under the title (Tronie 2026-11-23, apple/sessions-screen.md): n counts every row, this device included.
    public static string Summary(int count) => count == 1 ? "この端末だけが入っています" : $"{count}台が入っています";
    // Generic device glyphs, no brand marks (Tronie 2026-11-23): apple and android -> phone (the library does not say iPad or Mac), windows and linux -> desktop, web, console; an unknown kind takes web.
    public static string IconKey(HomeSessionEntry row) => row.Kind == "console" ? "console" : row.AppKind switch { "apple" or "android" => "phone", "windows" or "linux" => "desktop", _ => "web" };
    public static string Button(HomeSessionEntry row) => row.Current ? OwnRow : EndHere;
}
