using System.Globalization;
using System.Net;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Linux;

// a529n (docs/architecture/modules/usage/app-sessions.md 4a, Mint ruling 2026-11-23): every device logged in to the user's server, one row each, read from GET /api/home/sessions with this app's own session.
// 終了 = DELETE /api/home/sessions/{id} (that session ends at once; the device may sign in again). 締め出す = the phone's library stop(passId), then the same DELETE: only a store device (the phone) has a stop,
// so the Linux app passes no shutOut. This list is the home part's sessions, not 承認した端末 (that is only this phone's own approvals). Linux and Android share this file.
public sealed record HomeSessionRow
{
    public string Id { get; init; } = "";
    public string Kind { get; init; } = "";          // "account" or "console"
    public string? AppKind { get; init; }            // what the app sent as its kind: apple, windows, linux, android
    public string? PassId { get; init; }             // account rows saved by library 0.18.5 or later only
    public string State { get; init; } = "";         // active, none or unknown (the session's entitlement word)
    public string? Created { get; init; }
    public string? LastUse { get; init; }
    public bool Current { get; init; }
}

public sealed record HomeSessionList { public List<HomeSessionRow> Sessions { get; init; } = []; }

public static class HomeSessionWords
{
    public static string Device(HomeSessionRow row) => row.Kind == "console" ? "サーバーのコンソール" : row.AppKind switch { "apple" => "iPhone・iPad・Mac", "windows" => "Windows", "linux" => "Linux", "android" => "Android", _ => "アプリ" };
    public static string? StateLine(string state) => state switch { "none" => "契約がありません", "unknown" => "契約を確認できません", _ => null };
    public static string? Date(string? iso) => DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.None, out var time) ? time.ToLocalTime().ToString("M/d HH:mm", CultureInfo.InvariantCulture) : null;
    // The own row is the sign-out (the account card); a console row has no pass to stop; the stop needs the row's passId and a store device.
    public static bool CanEnd(HomeSessionRow row) => !row.Current;
    public static bool CanShutOut(HomeSessionRow row, bool storeDevice) => storeDevice && !row.Current && row.Kind == "account" && !string.IsNullOrEmpty(row.PassId);
}

public sealed class HomeSessionsCard : StackPanel
{
    private readonly BellApi api;
    private readonly CancellationToken token;
    private readonly Func<string, Task>? shutOut;
    private IReadOnlyList<HomeSessionRow>? rows;
    private string? failure;
    private (string Id, bool LockOut)? confirming;
    private bool busy;

    // shutOut: the phone's library stop(passId); null where the device has no stop (Linux, a web-signed phone). It throws with a sentence for the card when it fails.
    public HomeSessionsCard(BellApi api, CancellationToken token, Func<string, Task>? shutOut = null)
    {
        this.api = api; this.token = token; this.shutOut = shutOut;
        IsVisible = false;   // shown when the server answers the list: an older server has no such route (404)
        _ = LoadAsync();
    }

    private async Task LoadAsync()
    {
        try { rows = (await api.GetAsync<HomeSessionList>("/api/home/sessions", token)).Sessions; failure = null; IsVisible = true; }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (BellApiException error) when (error.Status == HttpStatusCode.NotFound) { IsVisible = false; return; }
        catch (Exception error) { failure = "端末の一覧を読み込めませんでした。" + error.Message; IsVisible = true; }
        if (!token.IsCancellationRequested) Render();
    }

    private async Task EndAsync(HomeSessionRow row, bool lockOut)
    {
        busy = true; failure = null; confirming = null; Render();
        try
        {
            if (lockOut) await shutOut!(row.PassId!);
            try { await api.DeleteAsync("/api/home/sessions/" + Uri.EscapeDataString(row.Id), token); }
            catch (BellApiException error) when (error.Status == HttpStatusCode.NotFound) { }   // already gone: the wish is met
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (Exception error) { failure = (lockOut ? "締め出せませんでした。" : "終了できませんでした。") + error.Message; }
        busy = false;
        await LoadAsync();
    }

    private void Render()
    {
        Children.Clear();
        Children.Add(Text("このサーバーに入っている端末", 17, Ink, FontWeight.Bold));
        Children.Add(Text("ここに並ぶのは、このサーバーにログインしているすべての端末です。「終了」はその端末をいま出します（パスが生きていれば入り直せます）。", 13, Muted, null, new Thickness(0, 8, 0, 4)));
        foreach (var row in rows ?? [])
        {
            var box = new StackPanel { Spacing = 2 };
            var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            head.Children.Add(Text(HomeSessionWords.Device(row), 15, Ink, FontWeight.SemiBold));
            if (row.Current) head.Children.Add(Badge("この端末", SettingsTone.Violet));
            box.Children.Add(head);
            var times = "入った " + (HomeSessionWords.Date(row.Created) ?? "—") + (HomeSessionWords.Date(row.LastUse) is { } last ? "・最後に使った " + last : "");
            box.Children.Add(Text(times, 12, Muted));
            if (HomeSessionWords.StateLine(row.State) is { } state) box.Children.Add(Text(state, 12, Muted));
            if (HomeSessionWords.CanEnd(row))
            {
                var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 6, 0, 0) };
                if (confirming is { } asked && asked.Id == row.Id)
                {
                    actions.Children.Add(Text(asked.LockOut ? "この端末を締め出します（入り直せなくなります）" : "この端末を出します", 12, Red));
                    actions.Children.Add(Action(asked.LockOut ? "締め出す" : "終了", Red, () => _ = EndAsync(row, asked.LockOut)));
                    actions.Children.Add(Action("やめる", Ink, () => { confirming = null; Render(); }));
                }
                else
                {
                    actions.Children.Add(Action("終了", Red, () => { confirming = (row.Id, false); Render(); }));
                    if (HomeSessionWords.CanShutOut(row, shutOut is not null)) actions.Children.Add(Action("締め出す", Red, () => { confirming = (row.Id, true); Render(); }));
                }
                box.Children.Add(actions);
            }
            Children.Add(new Border { Child = box, Background = Fill, CornerRadius = new CornerRadius(8), Padding = new Thickness(12, 10), Margin = new Thickness(0, 8, 0, 0) });
        }
        if (rows is { Count: 0 }) Children.Add(Text("まだ端末はありません。", 13, Muted, null, new Thickness(0, 8, 0, 0)));
        if (failure is not null) Children.Add(Banner(failure));
        var reload = Action("読み込み直す", Ink, () => _ = LoadAsync()); reload.Margin = new Thickness(0, 10, 0, 0); reload.HorizontalAlignment = HorizontalAlignment.Left;
        Children.Add(reload);
    }

    private Button Action(string label, IBrush color, System.Action click)
    {
        var button = Capsule(label, Fill, color, 8, 13, new Thickness(12, 6)); button.IsEnabled = !busy; button.Click += (_, _) => click();
        return button;
    }
}
