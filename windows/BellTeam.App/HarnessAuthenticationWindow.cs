using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using BellTeam.Core;

namespace BellTeam.App;

public sealed class HarnessAuthenticationWindow : EditorWindow
{
    private readonly HarnessAuthenticationApi api;
    private readonly HarnessAuthenticationOption harness;
    private readonly Func<string, bool> confirm;
    private readonly PasswordBox input = new();
    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(3) };
    private CancellationTokenSource? reading;
    private bool pollingFailed;
    public AuthenticationState? Authentication { get; private set; }
    public bool Started { get; private set; }
    public HarnessAuthenticationWindow(Workspace workspace, HarnessAuthenticationOption harness, Func<string, bool>? confirm = null) : base(harness.Name, workspace.ConnectionToken)
    {
        api = new(workspace.Management.Api); this.harness = harness;
        this.confirm = confirm ?? (warning => new AuthenticationConfirmationWindow(warning) { Owner = this }.ShowDialog() == true);
        SaveButton.Visibility = Visibility.Collapsed; CloseButton.Content = "閉じる"; Body.MaxWidth = 650;
        Deactivated += (_, _) => { input.Clear(); StopReading(); }; Closed += (_, _) => { input.Clear(); StopReading(); };
        Activated += (_, _) => UpdatePolling(); timer.Tick += async (_, _) => await PollAsync(); Render();
    }
    public Task InitializeAsync() => PerformAsync(() => api.StatusAsync(harness.Id, Token), clearInput: false);
    private void Render()
    {
        if (input.Parent is Panel parent) parent.Children.Remove(input);
        Body.Children.Clear();
        Body.Children.Add(new TextBlock { Text = harness.Name, FontSize = 30, FontWeight = FontWeights.Bold, Margin = new Thickness(0, 0, 0, 8) });
        Body.Children.Add(new TextBlock { Text = harness.UsageText, Foreground = Brushes.SlateGray, Margin = new Thickness(0, 0, 0, 20) });
        var details = Section("認証の状態");
        details.Children.Add(SecretCard.CardBody(Authentication?.Status switch { "waiting" => "公式サイトでの認証を待っています。", "authenticated" => "認証済みです。", "blocked" => "認証に必要な操作を確認してください。", "failed" => "認証できませんでした。", null => "公式の状態を確認しています。", _ => throw new BellApiException("認証の状態を読み取れませんでした。") }));
        if (Authentication is { } auth)
        {
            if (!string.IsNullOrEmpty(auth.Message)) details.Children.Add(SecretCard.CardBody(auth.Message));
            if (Uri.TryCreate(auth.Url, UriKind.Absolute, out var address) && address.Scheme == "https")
            {
                var link = new Button { Content = "公式サイトで認証する", HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 14, 0, 10) }; link.SetResourceReference(StyleProperty, "PrimaryButton");
                link.Click += (_, _) => { try { Process.Start(new ProcessStartInfo(address.AbsoluteUri) { UseShellExecute = true }); } catch (Exception error) { Status.Text = "公式サイトを開けませんでした。" + error.Message; } }; details.Children.Add(link);
            }
            if (!string.IsNullOrEmpty(auth.UserCode)) { details.Children.Add(new TextBlock { Text = "利用者コード", FontSize = 14, Margin = new Thickness(0, 10, 0, 4) }); details.Children.Add(SecretCard.CardBody(auth.UserCode)); }
            if (auth.InputRequired && Started)
            {
                var fields = Section("認証に必要な入力"); System.Windows.Automation.AutomationProperties.SetName(input, "認証に必要な入力"); fields.Children.Add(input);
                var send = new Button { Content = "入力を送る", HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 12, 0, 8) }; fields.Children.Add(send);
                send.Click += (_, _) => { if (input.Password.Length == 0) return; var text = input.Password; input.Clear(); _ = PerformAsync(() => api.InputAsync(harness.Id, text, null, Token)); };
                var keys = new WrapPanel(); fields.Children.Add(keys);
                foreach (var key in new[] { "Enter", "Up", "Down", "Tab" }) { var button = new Button { Content = key }; button.Click += (_, _) => _ = PerformAsync(() => api.InputAsync(harness.Id, null, key, Token)); keys.Children.Add(button); }
            }
            else input.Clear();
        }
        var actions = new WrapPanel { Margin = new Thickness(0, 20, 0, 0) }; Body.Children.Add(actions);
        if (harness.ReloginSupported != false) { var start = new Button { Content = "認証し直す" }; actions.Children.Add(start); start.Click += async (_, _) => await StartAsync(); }
        else if (!string.IsNullOrEmpty(harness.StartWarning)) details.Children.Add(SecretCard.CardBody(harness.StartWarning));
        var refresh = new Button { Content = "状態を更新" }; actions.Children.Add(refresh); refresh.Click += async (_, _) => await InitializeAsync();
        if (Started) { var cancel = new Button { Content = "やめる" }; actions.Children.Add(cancel); cancel.Click += async (_, _) => await PerformAsync(async () => { await api.CancelAsync(harness.Id, Token); Started = false; return await api.StatusAsync(harness.Id, Token); }); }
    }
    public async Task StartAsync()
    {
        if (Busy || harness.ReloginSupported == false) return;
        input.Clear();
        if (harness.NeedsStartConfirmation(Authentication) && !confirm(harness.StartWarning!)) return;
        await PerformAsync(async () => { var next = await api.StartAsync(harness.Id, Token); Started = next.Auth?.Status != "authenticated"; return next; });
    }
    private async Task PerformAsync(Func<Task<HarnessAuthenticationResponse>> action, bool clearInput = true)
    {
        if (Busy) return;
        StopReading(); if (clearInput) input.Clear(); var completed = false;
        await RunAsync(async () => { var next = await action(); Token.ThrowIfCancellationRequested(); Apply(next); completed = true; return false; });
        pollingFailed = !completed; UpdatePolling();
    }
    private void Apply(HarnessAuthenticationResponse next)
    {
        if (next.Harness != harness.Id) throw new BellApiException("別のAIの認証状態が返されました。");
        var changed = Authentication != next.Auth; Authentication = next.Auth;
        if (Authentication?.Status == "authenticated") Started = false;
        if (Authentication?.Status != "waiting") timer.Stop();
        if (changed) input.Clear(); Render();
    }
    private void StopReading() { timer.Stop(); reading?.Cancel(); }
    private void UpdatePolling() { if (!Token.IsCancellationRequested && !pollingFailed && IsActive && Authentication?.Status == "waiting") timer.Start(); }
    private async Task PollAsync()
    {
        if (Busy || reading is not null) return;
        using var current = CancellationTokenSource.CreateLinkedTokenSource(Token); reading = current;
        try { var next = await api.StatusAsync(harness.Id, current.Token); current.Token.ThrowIfCancellationRequested(); if (!Busy && Authentication != next.Auth) Apply(next); }
        catch (OperationCanceledException) when (current.IsCancellationRequested) { }
        catch (Exception error) { pollingFailed = true; timer.Stop(); Status.Text = error.Message; }
        finally { reading = null; }
    }
}
public sealed class AuthenticationConfirmationWindow : EditorWindow
{
    public AuthenticationConfirmationWindow(string warning) : base("AIの認証をやり直しますか？")
    {
        Width = 700; Height = 330; MinHeight = 280;
        Heading("AIの認証をやり直しますか？"); Body.Children.Add(SecretCard.CardBody(warning));
        CloseButton.Content = "始めない"; CloseButton.IsCancel = true;
        SaveButton.Content = "今の認証を手放して始める"; SaveButton.Click += (_, _) => DialogResult = true;
    }
}
