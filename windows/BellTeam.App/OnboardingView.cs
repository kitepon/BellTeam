using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using BellTeam.Core;

namespace BellTeam.App;

// Mac OnboardingView + AuthenticationInstructions: choose the first AI, authenticate it on the official site, then start the guide.
internal sealed class OnboardingView : StartupBackdrop, IDisposable
{
    private readonly SetupApi api;
    private readonly Func<SetupState, Task> ready;
    private readonly Action changeServer;
    private readonly CancellationToken lifetime;
    private readonly StackPanel column = new();
    private readonly PasswordBox code = new() { FontSize = 13, Padding = new Thickness(8, 6, 8, 6), MaxWidth = 360, HorizontalAlignment = HorizontalAlignment.Left };
    private readonly TextBlock codeHint = MacUi.Text("認証コード", 13, Palette.Get("Placeholder"));
    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(3) };
    private Window? window;
    private SetupState state;
    private bool busy, needsRefresh, reading, disposed;
    private string? writeError, readError;
    private int revision;
    public SetupState State => state;
    public string? ErrorText => writeError ?? readError;
    public bool Polling => timer.IsEnabled;
    public bool Busy => busy;
    public string CodeInput => code.Password;
    public OnboardingView(SetupApi api, SetupState initial, Func<SetupState, Task> ready, Action changeServer, CancellationToken lifetime = default)
    {
        this.api = api; state = initial; this.ready = ready; this.changeServer = changeServer; this.lifetime = lifetime;
        Children.Add(Scroll(column, 560, new Thickness(28, 56, 28, 28)));
        code.PasswordChanged += (_, _) => codeHint.Visibility = code.Password.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        System.Windows.Automation.AutomationProperties.SetName(code, "認証コード"); System.Windows.Automation.AutomationProperties.SetAutomationId(code, "harness-auth-input");
        Loaded += (_, _) => { window = Window.GetWindow(this); if (window is not null) window.Deactivated += Deactivated; };
        Unloaded += (_, _) => { if (window is not null) window.Deactivated -= Deactivated; window = null; code.Clear(); };
        // Mac: polls only while the app is active; the Windows window is the app.
        timer.Tick += async (_, _) => { if (Window.GetWindow(this) is { IsActive: true }) await PollAsync(); };
        Render(); UpdatePolling();
    }
    private void Deactivated(object? sender, EventArgs args) => code.Clear();
    public void Dispose() { disposed = true; timer.Stop(); code.Clear(); if (window is not null) window.Deactivated -= Deactivated; window = null; }
    private bool Locked => busy || needsRefresh || ErrorText is not null;

    private void Render()
    {
        if (code.Parent is Panel holder) holder.Children.Remove(code);
        if (codeHint.Parent is Panel hintHolder) hintHolder.Children.Remove(codeHint);
        column.Children.Clear();
        column.Children.Add(MacUi.Text("BellTeamを始める", 34, MacUi.Ink, FontWeights.Bold));
        column.Children.Add(MacUi.Text("最初に使うAIを選んで公式サイトで認証します。設定は、そのあと案内役と会話しながら進められます。", 13, MacUi.Muted, margin: new Thickness(0, 22, 0, 0)));
        if (state.Phase == "select_harness")
            foreach (var harness in state.Harnesses) { var card = HarnessCard(harness); card.Margin = new Thickness(0, 22, 0, 0); column.Children.Add(card); }
        else
        {
            column.Children.Add(MacUi.Text(state.Harnesses.FirstOrDefault(harness => harness.Id == state.Harness)?.Name ?? "公式認証", 17, MacUi.Ink, FontWeights.Bold, new Thickness(0, 22, 0, 0)));
            if (state.Auth is { } auth)
            {
                column.Children.Add(MacUi.Text(Description(auth), 13, MacUi.Muted, margin: new Thickness(0, 22, 0, 0)));
                column.Children.Add(Instructions(auth));
            }
            var start = MacUi.Prominent("認証を確認して始める", () => _ = StartAsync()); start.IsEnabled = !Locked && state.Auth?.Status == "authenticated"; start.Margin = new Thickness(0, 22, 0, 0); column.Children.Add(start);
            var refresh = MacUi.Bordered("認証の状態を更新", () => _ = RefreshAsync()); refresh.IsEnabled = !busy; refresh.Margin = new Thickness(0, 22, 0, 0); column.Children.Add(refresh);
            var menu = MacUi.Bordered("使うAIを変更", () => { }); menu.IsEnabled = !Locked; menu.Margin = new Thickness(0, 22, 0, 0); ChooseMenu(menu); column.Children.Add(menu);
        }
        if (busy) column.Children.Add(new Spinner { Width = 16, Height = 16, Stroke = MacUi.Secondary, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 22, 0, 0) });
        if (ErrorText is { } error) column.Children.Add(MacUi.Text(error, 10, MacUi.Red, margin: new Thickness(0, 22, 0, 0)));
        var server = MacUi.Bordered("接続先を変更", changeServer); server.IsEnabled = !busy; server.Margin = new Thickness(0, 22, 0, 0); column.Children.Add(server);
    }
    private static string Description(AuthenticationState auth) => auth.Status switch
    {
        "authenticated" => "認証済みです。確認して案内役との会話を始めてください。", "blocked" => "認証に必要な操作を確認してください。",
        "failed" => "認証に失敗しました。表示された理由を確認してください。", _ => "公式認証の完了を待っています。"
    };
    private Button HarnessCard(HarnessOption harness)
    {
        var row = new DockPanel(); var arrow = MacUi.Glyph("", 14); DockPanel.SetDock(arrow, Dock.Right); row.Children.Add(arrow);
        row.Children.Add(MacUi.Text(harness.Name, 13, MacUi.Ink, FontWeights.Bold));
        var button = MacUi.Bare(MacUi.Card(row, new Thickness(22)), () => _ = ChooseAsync(harness.Id), harness.Name); button.IsEnabled = !busy; return button;
    }
    // Mac Menu 「使うAIを変更」: a button that opens the list of AIs.
    private void ChooseMenu(Button button)
    {
        var menu = new ContextMenu { PlacementTarget = button, Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom };
        foreach (var harness in state.Harnesses) { var item = new MenuItem { Header = harness.Name }; item.Click += (_, _) => _ = ChooseAsync(harness.Id); menu.Items.Add(item); }
        button.Click += (_, _) => menu.IsOpen = true;
    }

    // Mac AuthenticationInstructions: only what the observed stage can accept.
    private UIElement Instructions(AuthenticationState auth)
    {
        var panel = new StackPanel { Margin = new Thickness(0, 22, 0, 0) };
        if (auth.AuthUi is { } ui)
        {
            panel.Children.Add(MacUi.Text(ui.Title ?? "", 13, MacUi.Ink, FontWeights.Bold));
            panel.Children.Add(MacUi.Text(ui.Message ?? "", 11, MacUi.Ink, margin: new Thickness(0, 12, 0, 0)));
            if (ui.OfficialUrl is { } address)
            {
                var link = MacUi.Link("公式サイトを開く", () => MacUi.OpenUrl(address, message => { writeError = message; Render(); })); link.Margin = new Thickness(0, 12, 0, 0);
                System.Windows.Automation.AutomationProperties.SetAutomationId(link, "harness-auth-link"); panel.Children.Add(link);
            }
            else if (ui.Stage is "open_url" or "device_code" or "paste_code") panel.Children.Add(MacUi.Text("公式サイトのURLを確認できません。状態を更新してください。", 10, MacUi.Red, margin: new Thickness(0, 12, 0, 0)));
            if (!string.IsNullOrEmpty(ui.UserCode))
            {
                panel.Children.Add(MacUi.Text("利用者コード", 10, margin: new Thickness(0, 12, 0, 0)));
                var shown = new TextBox { Text = ui.UserCode, IsReadOnly = true, Style = null, BorderThickness = new Thickness(0), Background = Brushes.Transparent, Padding = new Thickness(0), FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 15, Foreground = MacUi.Ink, Margin = new Thickness(0, 12, 0, 0) };
                System.Windows.Automation.AutomationProperties.SetAutomationId(shown, "harness-auth-code"); System.Windows.Automation.AutomationProperties.SetName(shown, "利用者コード"); panel.Children.Add(shown);
            }
            if (ui.CanReply)
            {
                var locked = Locked;
                if (ui.Input == "authorization_code")
                {
                    var field = new Grid { Margin = new Thickness(0, 12, 0, 0), MaxWidth = 360, HorizontalAlignment = HorizontalAlignment.Left };
                    codeHint.IsHitTestVisible = false; codeHint.Margin = new Thickness(11, 0, 0, 0); codeHint.VerticalAlignment = VerticalAlignment.Center; codeHint.Visibility = code.Password.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
                    code.IsEnabled = !locked; field.Children.Add(code); field.Children.Add(codeHint); panel.Children.Add(field);
                    var send = MacUi.Bordered("認証コードを送る", () => { var value = code.Password; code.Clear(); _ = RespondAsync(ui, new { kind = "authorization_code", value }, value.Length != 0); });
                    send.IsEnabled = !locked && code.Password.Length != 0; send.Margin = new Thickness(0, 12, 0, 0);
                    System.Windows.Automation.AutomationProperties.SetAutomationId(send, "harness-auth-submit"); panel.Children.Add(send);
                    code.PasswordChanged -= UpdateSend; code.PasswordChanged += UpdateSend;
                    void UpdateSend(object? sender, RoutedEventArgs args) => send.IsEnabled = !Locked && code.Password.Length != 0;
                }
                else
                    foreach (var choice in ui.Choices ?? [])
                    {
                        var option = MacUi.Bordered(choice.Label, () => _ = RespondAsync(ui, new { kind = "choice", id = choice.Id }, true)); option.IsEnabled = !locked; option.Margin = new Thickness(0, 12, 0, 0);
                        System.Windows.Automation.AutomationProperties.SetAutomationId(option, "harness-auth-choice-" + choice.Id); panel.Children.Add(option);
                    }
            }
            else if (ui.Input is not null) panel.Children.Add(MacUi.Text("操作の対象を確認できません。状態を更新してください。", 10, MacUi.Red, margin: new Thickness(0, 12, 0, 0)));
        }
        else if (!string.IsNullOrEmpty(auth.Message)) panel.Children.Add(MacUi.Text(auth.Message, 11, MacUi.Ink));
        return panel;
    }

    // A message of the app itself (not a server answer): shown as is.
    private sealed class Notice(string message) : Exception(message);
    private static string WriteFailure(Exception error) => error is BellApiException { Status: not null } ? error.Message : "操作の結果を確認できませんでした。現在の状態を確認してください。\n" + error.Message;
    // Mac perform(): one operation at a time; a failure is shown, never resent.
    private async Task PerformAsync(Func<Task> action, bool read = false, bool authReply = false)
    {
        if (busy) return;
        busy = true; writeError = readError = null; revision++; Render();
        try { await action(); if (read) needsRefresh = false; }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Notice notice) { writeError = notice.Message; }
        catch (Exception error) { writeError = read ? error.Message : WriteFailure(error); if (authReply) needsRefresh = true; }
        finally { busy = false; revision++; }
        Render(); UpdatePolling();
    }
    private void Accept(SetupState next)
    {
        if (next.Auth is { Status: not ("waiting" or "authenticated" or "blocked" or "failed") }) throw new BellApiException("認証の状態を読み取れませんでした。");
        if (next.Auth != state.Auth) code.Clear();
        state = next;
    }
    private Task ChooseAsync(string harness) => PerformAsync(async () => Accept(await api.SelectAsync(harness, lifetime)));
    private Task RefreshAsync() => PerformAsync(async () => Accept(await api.StatusAsync(lifetime)), read: true);
    // Mac startGuide: the server must report ready, then the app leaves onboarding.
    private Task StartAsync() => PerformAsync(async () =>
    {
        var next = await api.StartAsync(lifetime); Accept(next);
        if (next.Phase != "ready") throw new Notice("公式認証を完了してから、もう一度確認してください。");
        await ready(next);
    });
    // Mac submitAuthResponse: the prompt must still be the one on screen, and a failed reply needs a status refresh before the next one.
    private Task RespondAsync(AuthenticationUi ui, object response, bool valid) => PerformAsync(async () =>
    {
        if (needsRefresh || state.Auth?.AuthUi != ui || !ui.CanReply || !valid) throw new Notice("認証画面が更新されました。状態を確認してから操作してください。");
        Accept(await api.RespondAsync(ui, response, lifetime));
    }, authReply: true);

    private void UpdatePolling()
    {
        if (!disposed && state.Auth?.Status == "waiting") { if (!timer.IsEnabled) timer.Start(); }
        else timer.Stop();
    }
    // Every three seconds while the official authentication is pending. A failed read is shown and the next success clears it; the polling itself goes on.
    internal async Task PollAsync()
    {
        if (disposed || busy || needsRefresh || reading || state.Auth?.Status != "waiting") return;
        reading = true; var seen = revision;
        try
        {
            var next = await api.StatusAsync(lifetime);
            if (seen != revision || busy || needsRefresh) return;
            var changed = readError is not null || next.Phase != state.Phase || next.Harness != state.Harness || next.Auth != state.Auth || !next.Harnesses.SequenceEqual(state.Harnesses);
            readError = null; Accept(next); if (changed) Render();
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception error) { if (seen == revision) { readError = error.Message; Render(); } }
        finally { reading = false; UpdatePolling(); }
    }
}
