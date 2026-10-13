using System.Windows;
using System.Windows.Controls;
using System.Diagnostics;
using System.Windows.Threading;
using BellTeam.Core;

namespace BellTeam.App;

public sealed class SetupWindow : EditorWindow
{
    private readonly SetupApi api;
    private readonly Workspace workspace;
    private readonly PasswordBox input = new() { Padding = new Thickness(10), FontSize = 16 };
    private readonly DispatcherTimer poll = new() { Interval = TimeSpan.FromSeconds(3) };
    private bool pollingFailed;
    private CancellationTokenSource? reading;
    public SetupState State { get; private set; }
    public SetupWindow(Workspace workspace, SetupState state) : base("BellTeamを始める", workspace.ConnectionToken)
    {
        this.workspace = workspace; api = new(workspace.Management.Api); State = state;
        SaveButton.Visibility = Visibility.Collapsed; CloseButton.Content = "閉じる"; Body.MaxWidth = 600;
        Deactivated += (_, _) => { input.Clear(); StopReading(); }; Closed += (_, _) => { input.Clear(); StopReading(); };
        Activated += (_, _) => UpdatePolling();
        poll.Tick += async (_, _) => await PollAsync();
        Render();
    }
    private void Render()
    {
        if (State.Auth?.InputRequired != true) input.Clear();
        Body.Children.Clear(); Body.Children.Add(new TextBlock { Text = "BellTeamを始める", FontSize = 32, FontWeight = FontWeights.Bold, Margin = new Thickness(0, 6, 0, 16) });
        Body.Children.Add(new TextBlock { Text = "最初に使うAIを選んで公式サイトで認証します。設定は、そのあと案内役と会話しながら進められます。", TextWrapping = TextWrapping.Wrap, Foreground = System.Windows.Media.Brushes.SlateGray, Margin = new Thickness(0, 0, 0, 22) });
        if (State.Phase == "ready") { Status.Text = "案内役との会話を開始しました。"; return; }
        if (State.Phase is not ("select_harness" or "authenticate")) throw new BellApiException("初回設定の状態を読み取れませんでした。");
        if (State.Phase == "select_harness")
            foreach (var harness in State.Harnesses)
            {
                var row = new DockPanel(); var arrow = new TextBlock { Text = "→", FontSize = 22 }; DockPanel.SetDock(arrow, Dock.Right); row.Children.Add(arrow); row.Children.Add(new TextBlock { Text = harness.Name, FontSize = 20, FontWeight = FontWeights.SemiBold });
                var choose = ActionButton(harness.Name, () => _ = PerformAsync(() => api.SelectAsync(harness.Id, Token))); choose.Content = row; choose.HorizontalAlignment = HorizontalAlignment.Stretch; choose.HorizontalContentAlignment = HorizontalAlignment.Stretch; choose.Padding = new Thickness(22); choose.Margin = new Thickness(0, 0, 0, 12);
                System.Windows.Automation.AutomationProperties.SetName(choose, harness.Name);
            }
        else
        {
            Heading(State.Harnesses.FirstOrDefault(harness => harness.Id == State.Harness)?.Name ?? "公式認証");
            if (State.Auth is { } auth)
            {
                var description = auth.Status switch { "authenticated" => "認証済みです。確認して案内役との会話を始めてください。", "blocked" => "認証に必要な操作を確認してください。", "failed" => "認証に失敗しました。表示された理由を確認してください。", "waiting" => "公式認証の完了を待っています。", _ => throw new BellApiException("認証の状態を読み取れませんでした。") };
                Body.Children.Add(SecretCard.CardBody(description));
                if (!string.IsNullOrEmpty(auth.Message)) Body.Children.Add(SecretCard.CardBody(auth.Message));
                if (Uri.TryCreate(auth.Url, UriKind.Absolute, out var address) && address.Scheme == "https") ActionButton("公式サイトで認証する", () => { try { Process.Start(new ProcessStartInfo(address.AbsoluteUri) { UseShellExecute = true }); } catch (Exception error) { Status.Text = "公式サイトを開けませんでした。" + error.Message; } });
                if (!string.IsNullOrEmpty(auth.UserCode)) { Heading("利用者コード"); Body.Children.Add(SecretCard.CardBody(auth.UserCode)); }
                if (auth.InputRequired)
                {
                    Body.Children.Add(new TextBlock { Text = "認証に必要な入力", Margin = new Thickness(0, 8, 0, 8) }); Body.Children.Add(input);
                    ActionButton("入力を送る", () =>
                    {
                        if (input.Password.Length == 0) { Status.Text = "認証に必要な入力を記入してください。"; return; }
                        var text = input.Password; input.Clear(); _ = PerformAsync(() => api.InputAsync(text, null, Token));
                    });
                    var keys = new WrapPanel(); Body.Children.Add(keys);
                    foreach (var key in new[] { "Enter", "Up", "Down", "Tab" }) { var button = new Button { Content = key }; button.Click += (_, _) => _ = PerformAsync(() => api.InputAsync(null, key, Token)); keys.Children.Add(button); }
                }
            }
            ActionButton("認証を確認して始める", () => _ = PerformAsync(() => api.StartAsync(Token)));
            Heading("使うAIを変更"); foreach (var harness in State.Harnesses) ActionButton(harness.Name, () => _ = PerformAsync(() => api.SelectAsync(harness.Id, Token)));
        }
        ActionButton("認証の状態を更新", () => _ = PerformAsync(() => api.StatusAsync(Token), clearInput: false));
    }
    private void UpdatePolling() { if (!pollingFailed && IsActive && State.Auth?.Status == "waiting" && State.Phase != "ready") poll.Start(); }
    private async Task PerformAsync(Func<Task<SetupState>> action, bool clearInput = true)
    {
        if (Busy) return;
        StopReading(); var completed = false;
        await RunAsync(async () =>
        {
            if (clearInput) input.Clear();
            var next = await action(); Token.ThrowIfCancellationRequested();
            var changed = next.Phase != State.Phase || next.Harness != State.Harness || next.GuideBotId != State.GuideBotId || next.Complete != State.Complete || next.Auth != State.Auth || !next.Harnesses.SequenceEqual(State.Harnesses);
            State = next; if (changed) Render(); completed = true; return State.Phase == "ready";
        });
        pollingFailed = !completed;
        if (!Token.IsCancellationRequested) UpdatePolling();
    }
    private void StopReading() { poll.Stop(); reading?.Cancel(); }
    private async Task PollAsync()
    {
        if (Busy || reading is not null) return;
        using var current = CancellationTokenSource.CreateLinkedTokenSource(Token); reading = current;
        try
        {
            var next = await api.StatusAsync(current.Token); current.Token.ThrowIfCancellationRequested();
            if (!Busy && (next.Phase != State.Phase || next.Auth != State.Auth || next.Harness != State.Harness)) { input.Clear(); State = next; Render(); if (next.Phase == "ready") Close(); }
        }
        catch (OperationCanceledException) when (current.IsCancellationRequested) { }
        catch (Exception error) { pollingFailed = true; poll.Stop(); Status.Text = error.Message; }
        finally { reading = null; }
    }
}
