using System.Net;
using System.Net.Http;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using BellTeam.Core;
using static BellTeam.App.LatticeLook;

namespace BellTeam.App;

/// <summary>
/// One chart's reminder switch (screen-spec "工程表の設定", reminders API GET/PUT /api/lattice/charts/{id}/reminders): the last value the server confirmed and the one request in flight.
/// Reads when it opens and on reconnect; one PUT {enabled} per change; a failed PUT is reconciled by reading the server, never by sending it again. Saves nothing: the server owns the value.
/// </summary>
internal sealed class LatticeReminderModel : IDisposable
{
    internal const string Loading = "設定を読み込んでいます。", Saving = "設定を保存しています。", SaveFailure = "設定を保存できませんでした。",
        OldServer = "このサーバーでは催促の設定を変更できません。", Forbidden = "催促の設定を読む権限がありません。";
    private sealed record Setting(string Schema, string ProjectId, bool? Enabled);

    private readonly BellApi api;
    private readonly string projectId, path;
    private readonly Func<TimeSpan, CancellationToken, Task> delay;
    private readonly CancellationTokenSource lifetime;
    private CancellationTokenSource? backoff;
    private bool working, saving, rereadAfterSave;

    public LatticeReminderModel(BellApi api, string projectId, CancellationToken connection, Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        this.api = api; this.projectId = projectId; this.delay = delay ?? Task.Delay;
        path = $"/api/lattice/charts/{Uri.EscapeDataString(projectId)}/reminders";
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(connection);
        Status = Loading;
    }

    /// <summary>The value the server last confirmed; null until one is read (kept through a failed read).</summary>
    public bool? Confirmed { get; private set; }
    public string Status { get; private set; }
    /// <summary>The switch can be used: nothing is being read or saved.</summary>
    public bool Ready { get; private set; }
    public bool CanRetry { get; private set; }
    /// <summary>The chart is gone: offer the way back to the list.</summary>
    public bool Missing { get; private set; }
    public bool SaveFailed { get; private set; }
    public event Action? Changed;
    private CancellationToken Token => lifetime.Token;

    public void Dispose() { lifetime.Cancel(); lifetime.Dispose(); }

    /// <summary>Opens and reconnects, and 読み直す: asks the server now, or ends the wait of a running retry.</summary>
    public void Refresh()
    {
        if (Token.IsCancellationRequested) return;
        if (saving) rereadAfterSave = true;
        else if (backoff is { } wait) wait.Cancel();
        else if (!working) _ = RunAsync();
    }

    /// <summary>One PUT with the wanted value. The switch is disabled while a request runs, so this is asked only when Ready.</summary>
    public Task SetAsync(bool enabled) => Ready && enabled != Confirmed ? RunAsync(enabled) : Task.CompletedTask;

    internal async Task RunAsync(bool? desired = null)
    {
        working = true;
        try
        {
            if (desired is { } enabled)
            {
                saving = true; SaveFailed = false;
                Show(Saving);
                try
                {
                    Confirm(await api.WriteAsync<Setting>(HttpMethod.Put, path, new { enabled }, Token));
                    if (!rereadAfterSave) { Show("", ready: true); return; }
                }
                catch (Exception) when (Token.IsCancellationRequested) { return; }
                catch (BellApiException error) when (error.RequiresLogin) { SaveFailed = true; Show(LatticeChart.LoginRequired); return; }
                // An uncertain write is never sent again: the read below shows what the server holds.
                catch (Exception) { SaveFailed = true; }
                finally { saving = rereadAfterSave = false; }
            }
            await ReadAsync();
        }
        finally { working = false; }
    }

    private async Task ReadAsync()
    {
        for (var attempt = 0; !Token.IsCancellationRequested; attempt++)
        {
            Show(Loading);
            try
            {
                Confirm(await api.GetAsync<Setting>(path, Token));
                Show("", ready: true);
                return;
            }
            catch (Exception) when (Token.IsCancellationRequested) { return; }
            catch (BellApiException error) when (error.RequiresLogin) { Show(LatticeChart.LoginRequired); return; }
            catch (BellApiException error) when (error is { Status: HttpStatusCode.NotFound, Code: "NOT_FOUND" }) { Show(OldServer); return; }
            catch (BellApiException error) when (error is { Status: HttpStatusCode.NotFound, Code: "LATTICE_CHART_NOT_FOUND" }) { Show(LatticeChart.NotFound, missing: true); return; }
            catch (BellApiException error) when (error.Status == HttpStatusCode.Forbidden) { Show(Forbidden, retry: true); return; }
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
            using var wait = CancellationTokenSource.CreateLinkedTokenSource(Token);
            backoff = wait;
            try { await delay(TimeSpan.FromMilliseconds(LatticeChart.BackoffMs(attempt)), wait.Token); }
            catch (OperationCanceledException) when (wait.IsCancellationRequested) { }
            finally { backoff = null; }
        }
    }

    private void Confirm(Setting result)
    {
        Token.ThrowIfCancellationRequested();
        if (result.Schema != "bellteam.lattice-reminders.v1" || result.ProjectId != projectId || result.Enabled is not { } enabled)
            throw new BellApiException("BellTeamからの催促設定の応答を読み取れませんでした。");
        Confirmed = enabled;
    }

    private void Show(string text, bool ready = false, bool retry = false, bool missing = false)
    {
        Status = text; Ready = ready; CanRetry = retry; Missing = missing;
        Changed?.Invoke();
    }
}

/// <summary>The chart's 工程表の設定 sheet: a scrim over the chart page, the chart name, the 1分ごとの催促 switch and what is happening to it. Close works in every state.</summary>
internal sealed class LatticeReminderSheet : Grid, IDisposable
{
    internal const string Heading = "工程表の設定", SwitchLabel = "1分ごとの催促";
    private readonly LatticeReminderModel model;
    private readonly LatticeChartFeed feed;
    private readonly ToggleButton toggle = SettingsUi.Switch("#34C759");
    private readonly TextBlock value = Text("未確認", 14, Muted);
    private readonly TextBlock status = Text("", 13, Muted, wrap: TextWrapping.Wrap);
    private readonly TextBlock saveError = Text(LatticeReminderModel.SaveFailure, 13, Red, FontWeights.SemiBold, TextWrapping.Wrap);
    private readonly Button retry = Action("読み直す", "");
    private readonly Button list = Action("一覧へ戻る", "");
    private LatticeConnection previous;

    public LatticeReminderSheet(BellApi api, string projectId, string chartName, LatticeChartFeed feed, CancellationToken connection, Action close, Action showList)
    {
        this.feed = feed; previous = feed.Connection;
        model = new LatticeReminderModel(api, projectId, connection);
        Background = Brush(Colors.Black, 0x59);
        KeyboardNavigation.SetTabNavigation(this, KeyboardNavigationMode.Cycle); KeyboardNavigation.SetControlTabNavigation(this, KeyboardNavigationMode.Cycle);
        System.Windows.Automation.AutomationProperties.SetAutomationId(this, "lattice-reminder-sheet");

        var closeButton = Action("閉じる", ""); closeButton.Margin = new Thickness(0); closeButton.Click += (_, _) => close();
        System.Windows.Automation.AutomationProperties.SetAutomationId(closeButton, "lattice-reminder-close");
        retry.Click += (_, _) => model.Refresh(); list.Click += (_, _) => showList();
        System.Windows.Automation.AutomationProperties.SetAutomationId(retry, "lattice-reminder-retry");
        System.Windows.Automation.AutomationProperties.SetAutomationId(list, "lattice-reminder-list");
        System.Windows.Automation.AutomationProperties.SetAutomationId(toggle, "lattice-reminder-switch");
        System.Windows.Automation.AutomationProperties.SetName(toggle, SwitchLabel);
        System.Windows.Automation.AutomationProperties.SetAutomationId(status, "lattice-reminder-status");
        System.Windows.Automation.AutomationProperties.SetLiveSetting(status, System.Windows.Automation.AutomationLiveSetting.Polite);
        System.Windows.Automation.AutomationProperties.SetAutomationId(saveError, "lattice-reminder-save-error");
        System.Windows.Automation.AutomationProperties.SetLiveSetting(saveError, System.Windows.Automation.AutomationLiveSetting.Assertive);
        // Click, not Checked: only the person's press asks the server; the model's own redraw never does.
        toggle.Click += (_, _) => { if (toggle.IsChecked is { } next) _ = model.SetAsync(next); };

        var head = new DockPanel { Margin = new Thickness(0, 0, 0, 14) };
        DockPanel.SetDock(closeButton, Dock.Right); head.Children.Add(closeButton);
        head.Children.Add(Text(Heading, 18, Ink, FontWeights.Bold));
        var switchRow = new DockPanel { Margin = new Thickness(0, 12, 0, 0) };
        var control = Row(value, Spaced(toggle, 12)); DockPanel.SetDock(control, Dock.Right); switchRow.Children.Add(control);
        switchRow.Children.Add(Text(SwitchLabel, 15, Ink, FontWeights.SemiBold));
        var body = new StackPanel();
        body.Children.Add(head);
        body.Children.Add(Text(chartName, 14, Muted, FontWeights.SemiBold));
        body.Children.Add(switchRow);
        var note = Text("着手できる工程や作業中の工程があるとき、手が空いている担当に知らせます。", 12.5, Muted, wrap: TextWrapping.Wrap); note.Margin = new Thickness(0, 10, 0, 0); body.Children.Add(note);
        saveError.Margin = new Thickness(0, 12, 0, 0); status.Margin = new Thickness(0, 12, 0, 0);
        body.Children.Add(saveError); body.Children.Add(status);
        var actions = Row(retry, list); actions.Margin = new Thickness(0, 10, 0, 0); body.Children.Add(actions);
        var frame = Glass(body, 20, new Thickness(22, 18, 22, 20), 0xFA);
        frame.MaxWidth = 460; frame.Margin = new Thickness(24); frame.VerticalAlignment = VerticalAlignment.Center; frame.HorizontalAlignment = HorizontalAlignment.Center;
        System.Windows.Automation.AutomationProperties.SetName(frame, Heading);
        Children.Add(frame);
        model.Changed += Draw; Draw();
        feed.Changed += ConnectionChanged;
        Loaded += (_, _) => closeButton.Focus();
        model.Refresh();
    }

    internal LatticeReminderModel Model => model;

    private void ConnectionChanged()
    {
        var current = feed.Connection;
        var reconnected = current == LatticeConnection.Live && previous != current;
        previous = current;
        if (reconnected) model.Refresh();
    }

    private void Draw()
    {
        toggle.IsChecked = model.Confirmed == true; toggle.IsEnabled = model.Ready;
        value.Text = model.Confirmed switch { true => "オン", false => "オフ", null => "未確認" };
        System.Windows.Automation.AutomationProperties.SetHelpText(toggle, value.Text);
        status.Text = model.Status; status.Visibility = model.Status.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        saveError.Visibility = model.SaveFailed ? Visibility.Visible : Visibility.Collapsed;
        retry.Visibility = model.CanRetry ? Visibility.Visible : Visibility.Collapsed;
        list.Visibility = model.Missing ? Visibility.Visible : Visibility.Collapsed;
    }

    public void Dispose() { feed.Changed -= ConnectionChanged; model.Changed -= Draw; model.Dispose(); }
}
