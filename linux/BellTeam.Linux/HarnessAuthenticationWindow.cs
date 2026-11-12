using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

// AI authentication (設定 > AIの設定): the harness's login state, the official page link and the answers it asks for.
public sealed class HarnessAuthenticationWindow : EditorWindow
{
    private readonly HarnessAuthenticationApi api;
    private readonly HarnessAuthenticationOption harness;
    private readonly string? slot;
    private readonly string title;
    private readonly Func<string, Task<bool>> confirm;
    private readonly TextBox input = new() { PasswordChar = '•', FontSize = 16 };
    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(3) };
    private CancellationTokenSource? reading;
    private bool pollingFailed;
    private bool readFailed;
    public AuthenticationState? Authentication { get; private set; }
    public bool Started { get; private set; }
    // slot: the Claude account slot this window logs in ("1st"/"2nd"); null is the single login of every other harness.
    public HarnessAuthenticationWindow(LinuxWorkspace workspace, HarnessAuthenticationOption harness, Func<string, Task<bool>>? confirm = null, string? slot = null) : base(slot is null ? harness.Name : harness.Name + " · " + AccountText.SlotTitle(slot), workspace.ConnectionToken)
    {
        api = new(workspace.Management.Api); this.harness = harness; this.slot = slot; title = slot is null ? harness.Name : harness.Name + " · " + AccountText.SlotTitle(slot);
        this.confirm = confirm ?? (async warning => await new AuthenticationConfirmationWindow(warning).ShowDialog<bool?>(this) == true);
        SaveButton.IsVisible = false; CloseButton.Content = "閉じる"; Body.MaxWidth = 650;
        Deactivated += (_, _) => { input.Text = ""; StopReading(); }; Closed += (_, _) => { input.Text = ""; StopReading(); };
        Activated += (_, _) => UpdatePolling(); timer.Tick += async (_, _) => await PollAsync(); Render();
    }
    public Task InitializeAsync() => PerformAsync(() => api.StatusAsync(harness.Id, Token, slot: slot), clearInput: false);

    private static TextBlock CardBody(string text) => new() { Text = text, FontSize = 16, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 4) };
    private static Button Pill(string label, bool primary = false, bool enabled = true)
    {
        var button = new Button { Classes = { "plain" }, Content = label, IsEnabled = enabled, Background = primary ? BellTheme.ProminentFill : BellTheme.ButtonFill, Foreground = primary ? Brushes.White : BellTheme.Ink, Margin = new Thickness(0, 4, 8, 4) };
        AutomationProperties.SetName(button, label); return button;
    }

    private void Render()
    {
        if (input.Parent is Panel parent) parent.Children.Remove(input);
        Body.Children.Clear();
        Body.Children.Add(new TextBlock { Text = title, FontSize = 30, FontWeight = FontWeight.Bold, Margin = new Thickness(0, 0, 0, 8) });
        Body.Children.Add(new TextBlock { Text = harness.UsageText, Foreground = BellTheme.Muted, Margin = new Thickness(0, 0, 0, 20) });
        var details = Section("認証の状態");
        details.Children.Add(CardBody(Authentication?.Status switch { "waiting" => "公式サイトでの認証を待っています。", "authenticated" => "認証済みです。", "blocked" => "認証に必要な操作を確認してください。", "failed" => "認証できませんでした。", null => "公式の状態を確認しています。", _ => throw new BellApiException("認証の状態を読み取れませんでした。") }));
        if (Authentication is { } auth)
        {
            if (!string.IsNullOrEmpty(auth.Message)) details.Children.Add(CardBody(auth.Message));
            if (Uri.TryCreate(auth.AuthUi?.Url ?? auth.Url, UriKind.Absolute, out var address) && address.Scheme == "https")
            {
                var link = Pill("公式サイトで認証する", primary: true); link.HorizontalAlignment = HorizontalAlignment.Left; link.Margin = new Thickness(0, 14, 0, 10);
                link.Click += (_, _) => SettingsUi.OpenExternal(address.AbsoluteUri, message => ShowStatus("公式サイトを開けませんでした。" + message)); details.Children.Add(link);
            }
            if (!string.IsNullOrEmpty(auth.UserCode)) { details.Children.Add(new TextBlock { Text = "利用者コード", FontSize = 14, Margin = new Thickness(0, 10, 0, 4) }); details.Children.Add(CardBody(auth.UserCode)); }
            if (auth.AuthUi is { } ui)
            {
                if (!string.IsNullOrEmpty(ui.Title)) details.Children.Add(CardBody(ui.Title));
                if (!string.IsNullOrEmpty(ui.Message)) details.Children.Add(CardBody(ui.Message));
                if (!pollingFailed && ui.CanRespond && ui.Stage == "select")
                    foreach (var choice in ui.Choices ?? [])
                    {
                        var choose = Pill(choice.Label, enabled: !Busy); choose.HorizontalAlignment = HorizontalAlignment.Left; details.Children.Add(choose);
                        choose.Click += (_, _) => _ = PerformAsync(() => api.RespondAsync(harness.Id, ui, new { kind = "choice", id = choice.Id }, Token, slot: slot));
                    }
                if (!pollingFailed && ui.CanRespond && ui.Stage == "paste_code" && ui.Input == "authorization_code")
                {
                    details.Children.Add(CardBody("公式ページに表示された認証コード")); details.Children.Add(input);
                    var send = Pill("認証を完了する", enabled: !Busy); send.HorizontalAlignment = HorizontalAlignment.Left; details.Children.Add(send);
                    send.Click += (_, _) => { if ((input.Text ?? "").Length == 0) return; var value = input.Text!; input.Text = ""; _ = PerformAsync(() => api.RespondAsync(harness.Id, ui, new { kind = "authorization_code", value }, Token, slot: slot)); };
                }
                else input.Text = "";
            }
            else if (auth.InputRequired && Started)
            {
                var fields = Section("認証に必要な入力"); AutomationProperties.SetName(input, "認証に必要な入力"); fields.Children.Add(input);
                var send = Pill("入力を送る"); send.HorizontalAlignment = HorizontalAlignment.Left; send.Margin = new Thickness(0, 12, 0, 8); fields.Children.Add(send);
                send.Click += (_, _) => { if ((input.Text ?? "").Length == 0) return; var text = input.Text!; input.Text = ""; _ = PerformAsync(() => api.InputAsync(harness.Id, text, null, Token, slot: slot)); };
                var keys = new WrapPanel(); fields.Children.Add(keys);
                foreach (var key in new[] { "Enter", "Up", "Down", "Tab" }) { var button = Pill(key); button.Click += (_, _) => _ = PerformAsync(() => api.InputAsync(harness.Id, null, key, Token, slot: slot)); keys.Children.Add(button); }
            }
            else input.Text = "";
        }
        var actions = new WrapPanel { Margin = new Thickness(0, 20, 0, 0) }; Body.Children.Add(actions);
        if ((harness.ReloginSupported != false || Authentication is { Status: not "authenticated" }) && Authentication?.AuthUi is not { Binding: not null, Stage: not "complete" }) { var start = Pill(Authentication?.Status == "authenticated" ? "認証し直す" : "認証する"); actions.Children.Add(start); start.Click += async (_, _) => await StartAsync(); }
        else if (Authentication?.Status == "authenticated" && !string.IsNullOrEmpty(harness.StartWarning)) details.Children.Add(CardBody(harness.StartWarning));
        var refresh = Pill("状態を更新"); actions.Children.Add(refresh); refresh.Click += async (_, _) => await InitializeAsync();
        if (Started || Authentication?.AuthUi is { Binding: not null, Stage: not "complete" }) { var cancel = Pill("やめる"); actions.Children.Add(cancel); cancel.Click += async (_, _) => await PerformAsync(async () => { await api.CancelAsync(harness.Id, Token, slot: slot); Started = false; return await api.StatusAsync(harness.Id, Token, slot: slot); }); }
    }
    public async Task StartAsync()
    {
        if (Busy || harness.ReloginSupported == false && Authentication is not { Status: not "authenticated" }) return;
        input.Text = "";
        if (harness.NeedsStartConfirmation(Authentication) && !await confirm(harness.StartWarning!)) return;
        await PerformAsync(async () => { var next = await api.StartAsync(harness.Id, Token, slot: slot); Started = next.Auth?.Status != "authenticated"; return next; });
    }
    private async Task PerformAsync(Func<Task<HarnessAuthenticationResponse>> action, bool clearInput = true)
    {
        if (Busy) return;
        StopReading(); if (clearInput) input.Text = ""; var completed = false;
        await RunAsync(async () => { var next = await action(); Token.ThrowIfCancellationRequested(); Apply(next); completed = true; return false; });
        pollingFailed = !completed; if (!Token.IsCancellationRequested) Render(); UpdatePolling();
    }
    private void Apply(HarnessAuthenticationResponse next)
    {
        if (next.Harness != harness.Id) throw new BellApiException("別のAIの認証状態が返されました。");
        if (next.Slot is { } answered && answered != (slot ?? "1st")) throw new BellApiException("別のアカウントの認証状態が返されました。");
        var changed = Authentication != next.Auth; Authentication = next.Auth;
        if (Authentication?.Status == "authenticated") Started = false;
        if (Authentication?.Status != "waiting") timer.Stop();
        if (changed) input.Text = ""; Render();
    }
    private void StopReading() { timer.Stop(); reading?.Cancel(); }
    private void UpdatePolling() { if (!Token.IsCancellationRequested && !pollingFailed && IsActive && Authentication?.Status == "waiting") timer.Start(); }
    private async Task PollAsync()
    {
        if (Busy || reading is not null) return;
        using var current = CancellationTokenSource.CreateLinkedTokenSource(Token); reading = current;
        try
        {
            var next = await api.StatusAsync(harness.Id, current.Token, slot: slot); current.Token.ThrowIfCancellationRequested();
            if (readFailed) { readFailed = false; ShowStatus(""); }
            if (!Busy && Authentication != next.Auth) Apply(next);
        }
        catch (OperationCanceledException) when (current.IsCancellationRequested) { }
        // Trony 11-08: a transient read failure is shown and the next tick reads again; the next success clears it.
        catch (Exception error) { readFailed = true; ShowStatus(error.Message); }
        finally { reading = null; }
    }
}
public sealed class AuthenticationConfirmationWindow : EditorWindow
{
    public AuthenticationConfirmationWindow(string warning) : base("AIの認証をやり直しますか？")
    {
        Width = 700; Height = 330; MinHeight = 280;
        Heading("AIの認証をやり直しますか？"); Body.Children.Add(new TextBlock { Text = warning, FontSize = 16, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 4) });
        CloseButton.Content = "始めない"; // the base close answers null, which the caller reads as no
        SaveButton.Content = "今の認証を手放して始める"; SaveButton.Click += (_, _) => Close(true);
    }
}
