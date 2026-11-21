using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

// a485 7c/7d, the screens of an app that already has a session. Both views read through LoginApi and never resend a write by themselves (approve, deny, issue, revoke are not idempotent).
// A failed read shows its reason and is tried again on the Core backoff with no attempt limit; a refused session (401/403) or an old server (404) ends the retry.
internal static class SessionViewing
{
    public static bool Retryable(Exception error) => error is not BellApiException { Status: System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden or System.Net.HttpStatusCode.NotFound };
    public static string Time(DateTimeOffset? at) => at is { } value ? value.ToLocalTime().ToString("M/d HH:mm") : "";
}

// The requests that wait for this app's hand (7c): one row each with 許可する / 拒否する. Shown in the strip over the window, so a request is seen on any screen.
internal sealed class LoginRequestsView : StackPanel
{
    private readonly LoginApi api; private readonly CancellationToken life; private readonly Action changed;
    private readonly StackPanel rows = new(); private readonly TextBlock failure = MacUi.Text("", 11, MacUi.Red, margin: new Thickness(0, 4, 0, 0));
    private int generation; private bool failed;
    public bool HasContent => rows.Children.Count > 0 || failure.Text.Length > 0;
    public bool NeedsRetry => failed;

    public LoginRequestsView(LoginApi api, Action changed, CancellationToken life)
    {
        this.api = api; this.changed = changed; this.life = life;
        failure.Visibility = Visibility.Collapsed; Children.Add(rows); Children.Add(failure);
    }

    public async Task RefreshAsync()
    {
        var mine = ++generation;
        try
        {
            var requests = await api.RequestsAsync(life);
            if (mine != generation) return;
            failed = false; Show(requests, null);
        }
        catch (OperationCanceledException) when (life.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (mine != generation) return;
            failed = SessionViewing.Retryable(error); Show(null, "ログイン要求を読み込めませんでした。" + error.Message);
        }
    }

    private void Show(LoginRequest[]? requests, string? error)
    {
        if (requests is not null) { rows.Children.Clear(); foreach (var request in requests) rows.Children.Add(Row(request)); }
        failure.Text = error ?? ""; failure.Visibility = error is null ? Visibility.Collapsed : Visibility.Visible;
        changed();
    }

    private UIElement Row(LoginRequest request)
    {
        var box = new StackPanel { Margin = new Thickness(0, 0, 0, 6) };
        var title = MacUi.Text(SessionText.RequestTitle(request) + "（" + SessionText.Where(request.NetworkClass) + "）", 13, MacUi.Ink, FontWeights.SemiBold); AutomationProperties.SetName(title, "ログイン要求"); box.Children.Add(title);
        box.Children.Add(MacUi.Text(SessionText.RequestHint, 12, MacUi.Muted));
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 0) };
        var allow = MacUi.Prominent("許可する", () => _ = AnswerAsync(request, true)); var deny = MacUi.Bordered("拒否する", () => _ = AnswerAsync(request, false)); deny.Margin = new Thickness(8, 0, 0, 0);
        actions.Children.Add(allow); actions.Children.Add(deny); box.Children.Add(actions);
        return box;
    }

    private async Task AnswerAsync(LoginRequest request, bool allow)
    {
        foreach (var button in rows.Children.OfType<StackPanel>().SelectMany(row => row.Children.OfType<StackPanel>()).SelectMany(panel => panel.Children.OfType<Button>())) button.IsEnabled = false;
        try { if (allow) await api.ApproveAsync(request.LoginId, life); else await api.DenyAsync(request.LoginId, life); }
        catch (OperationCanceledException) when (life.IsCancellationRequested) { return; }
        // 404 / 409: it ended or was answered elsewhere; the list read below drops it.
        catch (BellApiException error) when (error.Status is System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.Conflict) { }
        catch (Exception error) { await RefreshAsync(); failure.Text = (allow ? "許可" : "拒否") + "できませんでした。" + error.Message; failure.Visibility = Visibility.Visible; changed(); return; }
        await RefreshAsync();
    }
}

// The 接続 page part (7c, 7d): "add an app" (the one-time code) and the list of apps that are in, with revoke; this app's own row signs out.
internal sealed class AppSessionsView : StackPanel
{
    private readonly LoginApi api; private readonly Action signOut; private readonly CancellationToken life;
    private readonly StackPanel list = new(), issued = new(); private readonly Button issue;
    private int generation; private bool issuing;

    public AppSessionsView(LoginApi api, Action signOut, CancellationToken life)
    {
        this.api = api; this.signOut = signOut; this.life = life;
        Children.Add(MacUi.Text("入っているアプリ", 15, MacUi.Ink, FontWeights.SemiBold, new Thickness(0, 0, 0, 6)));
        Children.Add(list);
        Children.Add(MacUi.Text("アプリを追加", 15, MacUi.Ink, FontWeights.SemiBold, new Thickness(0, 18, 0, 6)));
        issue = MacUi.Bordered("アプリを追加するコードを出す", () => _ = IssueAsync()); issue.HorizontalAlignment = HorizontalAlignment.Left; Children.Add(issue);
        Children.Add(issued);
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

    // One press, one POST: the code is single use and the server counts the ones outstanding, so it is never resent by itself.
    private async Task IssueAsync()
    {
        if (issuing) return;
        issuing = true; issue.IsEnabled = false; issued.Children.Clear();
        try
        {
            var code = await api.IssueCodeAsync(life);
            var shown = MacUi.Text(code.Code, 30, MacUi.Ink, FontWeights.Bold, new Thickness(0, 10, 0, 4)); shown.FontFamily = new FontFamily("Consolas"); AutomationProperties.SetName(shown, "アプリを追加するコード");
            issued.Children.Add(shown);
            if (code.ExpiresAt is { } end) issued.Children.Add(MacUi.Text(SessionViewing.Time(end) + "まで使えます。", 12, MacUi.Muted));
            issued.Children.Add(MacUi.Text(SessionText.AddAppNote, 12, MacUi.Muted, margin: new Thickness(0, 4, 0, 0)));
        }
        catch (OperationCanceledException) when (life.IsCancellationRequested) { }
        catch (BellApiException error) when (error.Code == "LOGIN_RATE_LIMITED") { issued.Children.Add(MacUi.Text(SessionText.CodeLimit, 13, MacUi.Red, margin: new Thickness(0, 8, 0, 0))); }
        catch (Exception error) { issued.Children.Add(MacUi.Text("コードを出せませんでした。" + error.Message, 13, MacUi.Red, margin: new Thickness(0, 8, 0, 0))); }
        finally { issuing = false; issue.IsEnabled = true; }
    }
}
