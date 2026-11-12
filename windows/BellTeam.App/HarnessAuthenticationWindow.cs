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
    private readonly string? slot;
    private readonly string title;
    private readonly Func<string, bool> confirm;
    private readonly PasswordBox input = new();
    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(3) };
    private CancellationTokenSource? reading;
    private bool pollingFailed;
    private bool readFailed;
    private bool loaded, sending, signedOut;
    private readonly string? accountLabel, limitLine;
    // The main window when this login is shown as a settings page (AsPage); polling and clearing the code follow that window.
    private Window? host;
    public AuthenticationState? Authentication { get; private set; }
    public bool Started { get; private set; }
    // slot: the Claude account slot this window logs in ("2nd"; "1st" or null read the first); null is the single login of every other harness.
    // name/accountLabel/limitLine/signedOut: what the AIの認証 row knew (Mac HarnessAuthenticationScreen): the page title, its e-mail line, its limit line, and a signed-out slot.
    public HarnessAuthenticationWindow(Workspace workspace, HarnessAuthenticationOption harness, Func<string, bool>? confirm = null, string? slot = null, string? name = null, string? accountLabel = null, string? limitLine = null, bool signedOut = false)
        : base(name ?? (slot is null ? harness.Name : harness.Name + " " + AccountText.SlotName(slot)), workspace.ConnectionToken)
    {
        api = new(workspace.Management.Api); this.harness = harness; this.slot = slot; title = name ?? (slot is null ? harness.Name : harness.Name + " " + AccountText.SlotName(slot));
        this.accountLabel = accountLabel; this.limitLine = limitLine; this.signedOut = signedOut;
        this.confirm = confirm ?? (warning => new AuthenticationConfirmationWindow(warning) { Owner = host ?? this }.ShowDialog() == true);
        SaveButton.Visibility = Visibility.Collapsed; CloseButton.Content = "閉じる"; Body.MaxWidth = 650;
        Deactivated += (_, _) => { input.Clear(); StopReading(); }; Closed += (_, _) => { input.Clear(); StopReading(); };
        Activated += (_, _) => UpdatePolling(); timer.Tick += async (_, _) => await PollAsync(); Render();
    }
    public Task InitializeAsync() => PerformAsync(() => api.StatusAsync(harness.Id, Token, slot: slot), clearInput: false);
    public override FrameworkElement AsPage(Action close, bool keepActions = false)
    {
        var page = base.AsPage(close, keepActions);
        EventHandler activated = (_, _) => UpdatePolling(), deactivated = (_, _) => { input.Clear(); StopReading(); };
        page.Loaded += (_, _) => { if (host is null && Window.GetWindow(page) is { } window) { host = window; host.Activated += activated; host.Deactivated += deactivated; UpdatePolling(); } };
        page.Unloaded += (_, _) => { input.Clear(); StopReading(); if (host is not null) { host.Activated -= activated; host.Deactivated -= deactivated; host = null; } };
        return page;
    }
    private AuthenticationProgress Progress => AuthenticationProgress.From(Authentication, loaded, signedOut, sending);
    private bool SessionOpen => Started || Authentication?.AuthUi is { Binding: not null, Stage: not "complete" };
    private bool CanStart => (harness.ReloginSupported != false || Authentication is { Status: not "authenticated" }) && Authentication?.AuthUi is not { Binding: not null, Stage: not "complete" };
    // Mac HarnessAuthenticationScreen (settings-user-flow S7, 4.9b): the account, its badge and one sentence always; below, only what the stage needs.
    // The server's own title and message (Aiterm's words) are not shown: the stage sentence says it.
    private void Render()
    {
        if (input.Parent is Panel parent) parent.Children.Remove(input);
        Body.Children.Clear();
        var progress = Progress;
        var head = new Grid { Margin = new Thickness(0, 0, 0, 12) };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); head.ColumnDefinitions.Add(new ColumnDefinition()); head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(SettingsUi.Tile(SettingsPage.Ai, 40));
        var names = new StackPanel { Margin = new Thickness(12, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center }; names.Children.Add(SettingsUi.Text(title, 17, SettingsUi.Ink, FontWeights.SemiBold));
        if (!string.IsNullOrEmpty(accountLabel)) names.Children.Add(SettingsUi.Text(accountLabel, 13, SettingsUi.Secondary, null, new Thickness(0, 2, 0, 0)));
        Grid.SetColumn(names, 1); head.Children.Add(names);
        var badge = SettingsUi.Badge(progress.Badge, progress.Tone); Grid.SetColumn(badge, 2); head.Children.Add(badge); Body.Children.Add(head);
        var card = new StackPanel();
        if (limitLine is not null) card.Children.Add(SettingsUi.Text("\u26A0 " + limitLine, 13, SettingsUi.Orange, null, new Thickness(0, 0, 0, 10)));
        var detail = SettingsUi.Text(progress.Detail, 14, progress.Tone == SettingsTone.Green ? SettingsUi.Ink : SettingsUi.ToneBrush(progress.Tone)); System.Windows.Automation.AutomationProperties.SetAutomationId(detail, "harness-auth-status"); card.Children.Add(detail);
        if (progress.Stage == AuthenticationStage.Done)
            card.Children.Add(SettingsUi.Text((slot is null && harness.Id != "claude" ? harness.UsageText + "。" : "") + "メンバーが認証の誤りで止まった時や、別のアカウントに替える時に認証し直します。", 13, SettingsUi.Muted, null, new Thickness(0, 10, 0, 0)));
        var blocked = pollingFailed || Status.Text.Length != 0;
        switch (progress.Stage)
        {
            case AuthenticationStage.Checking: card.Children.Add(SettingsUi.Text("確認しています…", 13, SettingsUi.Secondary, null, new Thickness(0, 10, 0, 0))); break;
            case AuthenticationStage.Unknown: card.Children.Add(Refresh()); break;
            case AuthenticationStage.NeedsLogin: AddStart("認証する", quiet: false); if (blocked) card.Children.Add(Refresh()); break;
            case AuthenticationStage.Failed: AddStart("認証し直す", quiet: false); card.Children.Add(Refresh()); break;
            case AuthenticationStage.WaitingSite or AuthenticationStage.WaitingCode or AuthenticationStage.SendingCode:
                Instructions(); if (blocked) card.Children.Add(Refresh()); AddCancel(); break;
            // An older server without the typed stage reads as confirming; its raw input stays reachable while this window started the login.
            case AuthenticationStage.Confirming: if (Authentication?.AuthUi is null) Instructions(); if (blocked) card.Children.Add(Refresh()); AddCancel(); break;
            default:
                if (CanStart) AddStart("認証し直す", quiet: true);
                else card.Children.Add(SettingsUi.Text(string.IsNullOrEmpty(harness.StartWarning) ? "このAIは認証済みの間は入り直せません。" : harness.StartWarning, 13, SettingsUi.Muted, null, new Thickness(0, 10, 0, 0)));
                if (blocked) card.Children.Add(Refresh());
                break;
        }
        var holder = SettingsUi.Card(card); holder.CornerRadius = new CornerRadius(14); holder.Padding = new Thickness(18); Body.Children.Add(holder);

        void AddStart(string label, bool quiet)
        {
            if (!CanStart) return;
            var start = quiet ? SettingsUi.Capsule(label, Brushes.Transparent, SettingsUi.Violet, 8, 13, new Thickness(0, 4, 0, 4)) : SettingsUi.MainButton(label);
            if (quiet) { start.HorizontalAlignment = HorizontalAlignment.Left; start.Margin = new Thickness(0, 10, 0, 0); start.FontWeight = FontWeights.Normal; }
            start.IsEnabled = !Busy && !blocked; System.Windows.Automation.AutomationProperties.SetAutomationId(start, "harness-auth-start");
            start.Click += async (_, _) => await StartAsync(); card.Children.Add(start);
        }
        Button Refresh()
        {
            var refresh = SettingsUi.Capsule("状態を更新", SettingsUi.Fill, SettingsUi.Ink, 8, 13, new Thickness(12, 6, 12, 6)); refresh.HorizontalAlignment = HorizontalAlignment.Left; refresh.Margin = new Thickness(0, 10, 0, 0); refresh.FontWeight = FontWeights.Normal;
            System.Windows.Automation.AutomationProperties.SetAutomationId(refresh, "harness-auth-refresh"); refresh.Click += async (_, _) => { Status.Text = ""; await InitializeAsync(); }; return refresh;
        }
        void AddCancel()
        {
            if (!SessionOpen) return;
            var cancel = SettingsUi.Capsule("やめる", SettingsUi.Fill, SettingsUi.Ink, 8, 13, new Thickness(12, 6, 12, 6)); cancel.HorizontalAlignment = HorizontalAlignment.Left; cancel.Margin = new Thickness(0, 10, 0, 0); cancel.FontWeight = FontWeights.Normal; cancel.IsEnabled = !Busy;
            System.Windows.Automation.AutomationProperties.SetAutomationId(cancel, "harness-auth-cancel");
            cancel.Click += async (_, _) => await PerformAsync(async () => { await api.CancelAsync(harness.Id, Token, slot: slot); Started = false; return await api.StatusAsync(harness.Id, Token, slot: slot); });
            card.Children.Add(cancel);
        }
        // Mac AuthenticationInstructions with showsServerText: false — only the stage Aiterm observed decides the controls.
        void Instructions()
        {
            if (Authentication is not { } auth) return;
            if (auth.AuthUi is not { } ui)
            {
                // An older server without the typed stage: the raw input and keys, while this window started the login.
                if (auth.InputRequired && Started)
                {
                    System.Windows.Automation.AutomationProperties.SetName(input, "認証に必要な入力"); input.Margin = new Thickness(0, 10, 0, 0); card.Children.Add(input);
                    var send = new Button { Content = "入力を送る", HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 10, 0, 6) }; card.Children.Add(send);
                    send.Click += (_, _) => { if (input.Password.Length == 0) return; var text = input.Password; input.Clear(); _ = PerformAsync(() => api.InputAsync(harness.Id, text, null, Token, slot: slot)); };
                    var keys = new WrapPanel(); card.Children.Add(keys);
                    foreach (var key in new[] { "Enter", "Up", "Down", "Tab" }) { var button = new Button { Content = key }; button.Click += (_, _) => _ = PerformAsync(() => api.InputAsync(harness.Id, null, key, Token, slot: slot)); keys.Children.Add(button); }
                }
                else input.Clear();
                if (Uri.TryCreate(auth.Url, UriKind.Absolute, out var legacy) && legacy.Scheme == "https") card.Children.Add(OpenSite(legacy));
                if (!string.IsNullOrEmpty(auth.UserCode)) AddUserCode(auth.UserCode);
                return;
            }
            if (Uri.TryCreate(ui.Url ?? auth.Url, UriKind.Absolute, out var address) && address.Scheme == "https") card.Children.Add(OpenSite(address));
            else if (ui.Stage is "open_url" or "device_code" or "paste_code") card.Children.Add(SettingsUi.Text("公式サイトのURLを確認できません。状態を更新してください。", 12, SettingsUi.Red, null, new Thickness(0, 10, 0, 0)));
            if (!string.IsNullOrEmpty(ui.UserCode ?? auth.UserCode)) AddUserCode(ui.UserCode ?? auth.UserCode!);
            if (pollingFailed || !ui.CanRespond) { if (ui.Input is not null) card.Children.Add(SettingsUi.Text("操作の対象を確認できません。状態を更新してください。", 12, SettingsUi.Red, null, new Thickness(0, 10, 0, 0))); input.Clear(); return; }
            if (ui.Stage == "select")
                foreach (var choice in ui.Choices ?? [])
                {
                    var choose = SettingsUi.Capsule(choice.Label, SettingsUi.Fill, SettingsUi.Ink, 8, 13, new Thickness(12, 6, 12, 6)); choose.HorizontalAlignment = HorizontalAlignment.Left; choose.Margin = new Thickness(0, 10, 0, 0); choose.FontWeight = FontWeights.Normal; choose.IsEnabled = !Busy;
                    choose.Click += (_, _) => _ = PerformAsync(() => api.RespondAsync(harness.Id, ui, new { kind = "choice", id = choice.Id }, Token, slot: slot)); card.Children.Add(choose);
                }
            if (ui.Stage == "paste_code" && ui.Input == "authorization_code")
            {
                System.Windows.Automation.AutomationProperties.SetName(input, "認証コード"); input.Margin = new Thickness(0, 10, 0, 0); input.IsEnabled = !Busy; card.Children.Add(input);
                var send = SettingsUi.MainButton(sending ? "送っています…" : "認証コードを送る"); send.IsEnabled = !Busy; System.Windows.Automation.AutomationProperties.SetAutomationId(send, "harness-auth-submit"); card.Children.Add(send);
                send.Click += async (_, _) =>
                {
                    if (input.Password.Length == 0) return;
                    var value = input.Password; input.Clear(); sending = true;
                    try { await PerformAsync(() => api.RespondAsync(harness.Id, ui, new { kind = "authorization_code", value }, Token, slot: slot)); }
                    finally { sending = false; if (!Token.IsCancellationRequested) Render(); }
                };
            }
            else input.Clear();
        }
        Button OpenSite(Uri address)
        {
            var link = SettingsUi.Capsule("公式サイトを開く", Brushes.Transparent, SettingsUi.Violet, 8, 13, new Thickness(0, 4, 0, 4)); link.HorizontalAlignment = HorizontalAlignment.Left; link.Margin = new Thickness(0, 10, 0, 0);
            System.Windows.Automation.AutomationProperties.SetAutomationId(link, "harness-auth-link");
            link.Click += (_, _) => { try { Process.Start(new ProcessStartInfo(address.AbsoluteUri) { UseShellExecute = true }); } catch (Exception error) { Status.Text = "公式サイトを開けませんでした。" + error.Message; } };
            return link;
        }
        void AddUserCode(string code)
        {
            card.Children.Add(SettingsUi.Text("利用者コード", 12, SettingsUi.Secondary, null, new Thickness(0, 10, 0, 2)));
            var value = new TextBox { Text = code, IsReadOnly = true, BorderThickness = new Thickness(0), Background = Brushes.Transparent, FontFamily = new FontFamily("Consolas"), FontSize = 18 };
            System.Windows.Automation.AutomationProperties.SetAutomationId(value, "harness-auth-code"); card.Children.Add(value);
        }
    }
    public async Task StartAsync()
    {
        if (Busy || harness.ReloginSupported == false && Authentication is not { Status: not "authenticated" }) return;
        input.Clear();
        if (harness.NeedsStartConfirmation(Authentication) && !confirm(harness.StartWarning!)) return;
        await PerformAsync(async () => { var next = await api.StartAsync(harness.Id, Token, slot: slot); Started = next.Auth?.Status != "authenticated"; return next; });
    }
    private async Task PerformAsync(Func<Task<HarnessAuthenticationResponse>> action, bool clearInput = true)
    {
        if (Busy) return;
        StopReading(); if (clearInput) input.Clear(); var completed = false;
        await RunAsync(async () => { var next = await action(); Token.ThrowIfCancellationRequested(); Apply(next); completed = true; return false; });
        pollingFailed = !completed; if (!Token.IsCancellationRequested) Render(); UpdatePolling();
    }
    private void Apply(HarnessAuthenticationResponse next)
    {
        if (next.Harness != harness.Id) throw new BellApiException("別のAIの認証状態が返されました。");
        if (next.Slot is { } answered && answered != (slot ?? "1st")) throw new BellApiException("別のアカウントの認証状態が返されました。");
        var changed = Authentication != next.Auth; Authentication = next.Auth; loaded = true;
        // A login finished here replaces the signed-out credentials the row reported.
        if (Authentication?.Status == "authenticated") { if (Started) signedOut = false; Started = false; }
        if (Authentication?.Status != "waiting") timer.Stop();
        if (changed) input.Clear(); Render();
    }
    private void StopReading() { timer.Stop(); reading?.Cancel(); }
    private void UpdatePolling() { if (!Token.IsCancellationRequested && !pollingFailed && (host?.IsActive ?? IsActive) && Authentication?.Status == "waiting") timer.Start(); }
    private async Task PollAsync()
    {
        if (Busy || reading is not null) return;
        using var current = CancellationTokenSource.CreateLinkedTokenSource(Token); reading = current;
        try
        {
            var next = await api.StatusAsync(harness.Id, current.Token, slot: slot); current.Token.ThrowIfCancellationRequested();
            if (readFailed) { readFailed = false; Status.Text = ""; }
            if (!Busy && Authentication != next.Auth) Apply(next);
        }
        catch (OperationCanceledException) when (current.IsCancellationRequested) { }
        // Trony 11-08: a transient read failure is shown and the next tick reads again; the next success clears it.
        catch (Exception error) { readFailed = true; Status.Text = error.Message; }
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
