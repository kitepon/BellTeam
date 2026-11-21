using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

// The screen of an app that already has a session. It reads through LoginApi and never resends a write by itself (revoke is not idempotent).
// A failed read shows its reason and is tried again on the Core backoff with no attempt limit; a refused session (401/403) or an old server (404) ends the retry.
internal static class SessionViewing
{
    public static bool Retryable(Exception error) => error is not BellApiException { Status: System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden or System.Net.HttpStatusCode.NotFound };
    public static string Time(DateTimeOffset? at) => at is { } value ? value.ToLocalTime().ToString("M/d HH:mm") : "";
}

// The 接続 page part: the list of apps that are in, with revoke; this app's own row signs out. "Add an app" codes and the second hand are gone (login-billing, Owner 2026-11-22).
internal sealed class AppSessionsView : StackPanel
{
    private readonly LoginApi api; private readonly Action signOut; private readonly CancellationToken life;
    private readonly StackPanel list = new();
    private int generation;

    public AppSessionsView(LoginApi api, Action signOut, CancellationToken life)
    {
        this.api = api; this.signOut = signOut; this.life = life;
        Children.Add(MacUi.Text("入っているアプリ", 15, MacUi.Ink, FontWeights.SemiBold, new Thickness(0, 0, 0, 6)));
        Children.Add(list);
        Ready = LoadAsync();
    }

    // The first read; it ends when the list is drawn or the failure is shown and the retry is left running.
    public Task Ready { get; }
    public Task RefreshAsync() => LoadAsync();

    private async Task LoadAsync()
    {
        var mine = ++generation;
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                var sessions = await api.SessionsAsync(life);
                if (mine != generation) return;
                Draw(sessions); return;
            }
            catch (OperationCanceledException) when (life.IsCancellationRequested) { return; }
            catch (Exception error)
            {
                if (mine != generation) return;
                list.Children.Clear(); list.Children.Add(MacUi.Text("アプリの一覧を読み込めませんでした。" + error.Message, 13, MacUi.Red));
                if (!SessionViewing.Retryable(error)) return;
                try { await Task.Delay(ReconnectBackoff.Ms(attempt + 1), life); } catch (OperationCanceledException) { return; }
            }
        }
    }

    private void Draw(SessionEntry[] sessions)
    {
        list.Children.Clear();
        if (sessions.Length == 0) list.Children.Add(MacUi.Text("入っているアプリはありません。", 13, MacUi.Muted));
        foreach (var session in sessions)
        {
            var row = new DockPanel { Margin = new Thickness(0, 0, 0, 8), LastChildFill = true };
            var action = session.Current ? MacUi.Bordered("ログアウト", () => signOut()) : MacUi.Bordered("取り消す", () => _ = RevokeAsync(session));
            DockPanel.SetDock(action, Dock.Right); action.Margin = new Thickness(10, 0, 0, 0); row.Children.Add(action);
            var text = new StackPanel();
            text.Children.Add(MacUi.Text(session.Kind + (session.Current ? "（このアプリ）" : ""), 13, MacUi.Ink, FontWeights.SemiBold));
            text.Children.Add(MacUi.Text(SessionText.Origin(session.Origin) + (session.LastUsedAt is null ? "" : " ・ 最後の利用 " + SessionViewing.Time(session.LastUsedAt)), 12, MacUi.Muted));
            row.Children.Add(text); list.Children.Add(row);
        }
    }

    private async Task RevokeAsync(SessionEntry session)
    {
        try { await api.EndSessionAsync(session.Id, life); }
        catch (OperationCanceledException) when (life.IsCancellationRequested) { return; }
        catch (BellApiException error) when (error.Status == System.Net.HttpStatusCode.NotFound) { }
        catch (Exception error) { list.Children.Add(MacUi.Text("取り消せませんでした。" + error.Message, 12, MacUi.Red)); return; }
        await LoadAsync();
    }
}
