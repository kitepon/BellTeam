using System.Net;
using System.Net.Http;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;

namespace BellTeam.Linux;

internal sealed class LatticeReminderSettings : Grid, IDisposable
{
    internal const string Heading = "工程表の設定";
    private const string SwitchLabel = "1分ごとの催促";
    private const string SaveFailure = "設定を保存できませんでした。";
    private readonly BellApi api;
    private readonly string projectId;
    private readonly string path;
    private readonly LatticeChartFeed feed;
    private readonly CancellationTokenSource lifetime;
    private readonly CancellationToken token;
    private readonly IosSwitch reminder = FormKit.Switch();
    private readonly TextBlock value = FormKit.Text("未確認", color: BellTheme.Secondary);
    private readonly TextBlock status = FormKit.Text("", color: BellTheme.Secondary);
    private readonly TextBlock saveError = FormKit.Text(SaveFailure, color: BellTheme.Red);
    private readonly Button closeButton;
    private readonly Button retryButton;
    private readonly Button listButton;
    private readonly Border feedback;
    private LatticeConnection previousConnection;
    private CancellationTokenSource? backoff;
    private bool? confirmed;
    private bool working, saving, rereadAfterSave;

    private sealed record Setting(string Schema, string ProjectId, bool? Enabled);

    public LatticeReminderSettings(BellApi api, string projectId, string chartName, LatticeChartFeed feed,
        CancellationToken connection, Action close, Action showList)
    {
        this.api = api;
        this.projectId = projectId;
        this.feed = feed;
        path = $"/api/lattice/charts/{Uri.EscapeDataString(projectId)}/reminders";
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(connection);
        token = lifetime.Token;
        previousConnection = feed.Connection;
        Background = new SolidColorBrush(Color.FromArgb(0x59, 0, 0, 0));

        closeButton = FormKit.LinkButton("閉じる", close);
        retryButton = FormKit.LinkButton("読み直す", Refresh);
        listButton = FormKit.LinkButton("一覧へ戻る", showList);
        var heading = new DockPanel();
        DockPanel.SetDock(closeButton, Dock.Right);
        heading.Children.Add(closeButton);
        heading.Children.Add(FormKit.Text(Heading, 17, weight: FontWeight.SemiBold));

        AutomationProperties.SetName(reminder, SwitchLabel);
        AutomationProperties.SetAutomationId(reminder, "lattice-reminder-switch");
        AutomationProperties.SetAutomationId(status, "lattice-reminder-status");
        AutomationProperties.SetLiveSetting(status, AutomationLiveSetting.Polite);
        value.VerticalAlignment = VerticalAlignment.Center;
        var control = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, Children = { value, reminder } };
        feedback = FormKit.Row(new StackPanel { Spacing = 6, Children = { saveError, status, retryButton, listButton } }, 0);
        var rows = new StackPanel { Children = { FormKit.Labeled(SwitchLabel, control), feedback } };
        var group = new Border { Background = Brushes.White, CornerRadius = new CornerRadius(12), Child = rows };
        var section = FormKit.Section(chartName, group);
        section.Children.Add(BellTheme.Text("着手できる工程や作業中の工程があるとき、手が空いている担当に知らせます。",
            13, BellTheme.Secondary, margin: new Thickness(20, 8, 20, 0)));
        var frame = new Border
        {
            Child = new StackPanel { Children = { heading, section } },
            Background = FormKit.Canvas, Padding = new Thickness(20), Margin = new Thickness(16),
            MaxWidth = 460, VerticalAlignment = VerticalAlignment.Center, CornerRadius = new CornerRadius(14),
            BoxShadow = BoxShadows.Parse("0 8 30 0 #40000000")
        };
        AutomationProperties.SetName(frame, Heading);
        Children.Add(frame);
        saveError.IsVisible = false;
        Show("設定を読み込んでいます。");
        reminder.IsCheckedChanged += (_, _) =>
        {
            if (reminder.IsEnabled && reminder.IsChecked is { } next && next != confirmed)
                _ = RunAsync(next);
        };
    }

    public void Open()
    {
        feed.Changed += ConnectionChanged;
        closeButton.Focus();
        Refresh();
    }

    public void Dispose()
    {
        feed.Changed -= ConnectionChanged;
        lifetime.Cancel();
        lifetime.Dispose();
    }

    private void ConnectionChanged()
    {
        var current = feed.Connection;
        var reconnected = current == LatticeConnection.Live && previousConnection != current;
        previousConnection = current;
        if (reconnected) Refresh();
    }

    private void Refresh()
    {
        if (token.IsCancellationRequested) return;
        if (saving) rereadAfterSave = true;
        else if (backoff is { } delay) delay.Cancel();
        else if (!working) _ = RunAsync();
    }

    private async Task RunAsync(bool? desired = null)
    {
        working = true;
        try
        {
            if (desired is { } enabled)
            {
                saving = true;
                saveError.IsVisible = false;
                Show("設定を保存しています。");
                try
                {
                    var result = await api.WriteAsync<Setting>(HttpMethod.Put, path, new { enabled }, token);
                    Confirm(result);
                    if (!rereadAfterSave) { Show("", ready: true); return; }
                }
                catch (Exception) when (token.IsCancellationRequested) { return; }
                catch (BellApiException error) when (error.RequiresLogin)
                {
                    saveError.IsVisible = true;
                    Show(LatticeChart.LoginRequired);
                    return;
                }
                catch (Exception) { saveError.IsVisible = true; }
                finally { saving = rereadAfterSave = false; }
            }
            await ReadAsync();
        }
        finally { working = false; }
    }

    private async Task ReadAsync()
    {
        for (var attempt = 0; !token.IsCancellationRequested; attempt++)
        {
            Show("設定を読み込んでいます。");
            try
            {
                Confirm(await api.GetAsync<Setting>(path, token));
                Show("", ready: true);
                return;
            }
            catch (Exception) when (token.IsCancellationRequested) { return; }
            catch (BellApiException error) when (error.RequiresLogin) { Show(LatticeChart.LoginRequired); return; }
            catch (BellApiException error) when (error is { Status: HttpStatusCode.NotFound, Code: "NOT_FOUND" })
            { Show("このサーバーでは催促の設定を変更できません。"); return; }
            catch (BellApiException error) when (error is { Status: HttpStatusCode.NotFound, Code: "LATTICE_CHART_NOT_FOUND" })
            { Show(LatticeChart.NotFound, missing: true); return; }
            catch (BellApiException error) when (error.Status == HttpStatusCode.Forbidden)
            { Show("催促の設定を読む権限がありません。", retry: true); return; }
            catch (Exception error)
            {
                var reason = error switch
                {
                    BellApiException { Status: HttpStatusCode.ServiceUnavailable } => "サーバーが応答できません。",
                    BellApiException { Status: null } => "サーバーから届いた設定を読み取れません。",
                    HttpRequestException => "サーバーに接続できません。",
                    OperationCanceledException => "サーバーの応答が時間内に届きませんでした。",
                    _ => "サーバーから設定を読み込めませんでした。"
                };
                Show(reason + " 再試行します。", retry: true);
            }
            using var delay = CancellationTokenSource.CreateLinkedTokenSource(token);
            backoff = delay;
            try { await Task.Delay(LatticeChart.BackoffMs(attempt), delay.Token); }
            catch (OperationCanceledException) when (delay.IsCancellationRequested) { }
            finally { backoff = null; }
        }
    }

    private void Confirm(Setting result)
    {
        token.ThrowIfCancellationRequested();
        if (result.Schema != "bellteam.lattice-reminders.v1" || result.ProjectId != projectId || result.Enabled is not { } enabled)
            throw new BellApiException("BellTeamからの催促設定の応答を読み取れませんでした。");
        confirmed = enabled;
    }

    private void Show(string text, bool ready = false, bool retry = false, bool missing = false)
    {
        reminder.IsEnabled = false;
        reminder.IsChecked = confirmed == true;
        value.Text = confirmed switch { true => "オン", false => "オフ", null => "未確認" };
        AutomationProperties.SetHelpText(reminder, value.Text);
        reminder.IsEnabled = ready;
        status.Text = text;
        status.IsVisible = text.Length > 0;
        retryButton.IsVisible = retry;
        listButton.IsVisible = missing;
        feedback.IsVisible = status.IsVisible || saveError.IsVisible || retry || missing;
    }
}
