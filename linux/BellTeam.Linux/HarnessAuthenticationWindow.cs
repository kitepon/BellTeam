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
    // a451: the server's install state; an AI that cannot run shows it (with the button) instead of the login. Null from a server that does not report it.
    private HarnessCliInstall? install;
    private HarnessInstallPanel? panel;
    public AuthenticationState? Authentication { get; private set; }
    public bool Started { get; private set; }
    // slot: the Claude account slot this window logs in ("1st"/"2nd"); null is the single login of every other harness.
    public HarnessAuthenticationWindow(LinuxWorkspace workspace, HarnessAuthenticationOption harness, Func<string, Task<bool>>? confirm = null, string? slot = null) : base(slot is null ? harness.Name : harness.Name + " " + AccountText.SlotName(slot), workspace.ConnectionToken)
    {
        api = new(workspace.Management.Api); this.harness = harness; this.slot = slot; install = harness.Install;
        if (install is not null && !HarnessCliInstall.Ready(install)) { panel = new HarnessInstallPanel(api, harness.Id, harness.Name, install, Token); panel.Changed += InstallChanged; } title = slot is null ? harness.Name : harness.Name + " " + AccountText.SlotName(slot);
        this.confirm = confirm ?? (async warning => await new AuthenticationConfirmationWindow(warning).ShowDialog<bool?>(this) == true);
        SaveButton.IsVisible = false; CloseButton.Content = LinuxStrings.ApprovalsViews_NotUsable_1; Body.MaxWidth = 650;
        Deactivated += (_, _) => { input.Text = ""; StopReading(); }; Closed += (_, _) => { input.Text = ""; StopReading(); };
        Activated += (_, _) => UpdatePolling(); timer.Tick += async (_, _) => await PollAsync(); Render();
    }
    private void InstallChanged(HarnessCliInstall next)
    {
        install = next;
        if (!HarnessCliInstall.Ready(next)) return;
        // It can run now: the login state is read and the install panel is gone.
        panel?.Stop(); panel = null; _ = InitializeAsync();
    }
    public Task InitializeAsync() => !HarnessCliInstall.Ready(install) ? Task.CompletedTask : PerformAsync(() => api.StatusAsync(harness.Id, Token, slot: slot), clearInput: false);

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
        if (panel is not null)
        {
            panel.MoveTo(Section(LinuxStrings.HarnessAuthenticationWindow_Render_1));
            return;
        }
        var details = Section(LinuxStrings.HarnessAuthenticationWindow_Render_2);
        details.Children.Add(CardBody(Authentication?.Status switch { "waiting" => LinuxStrings.HarnessAuthenticationWindow_Render_3, "authenticated" => LinuxStrings.HarnessAuthenticationWindow_Render_4, "blocked" => LinuxStrings.HarnessAuthenticationWindow_Render_5, "failed" => LinuxStrings.HarnessAuthenticationWindow_Render_6, null => LinuxStrings.HarnessAuthenticationWindow_Render_7, _ => throw new BellApiException(LinuxStrings.HarnessAuthenticationWindow_Render_8) }));
        if (Authentication is { } auth)
        {
            if (!string.IsNullOrEmpty(auth.Message)) details.Children.Add(CardBody(auth.Message));
            if (Uri.TryCreate(auth.AuthUi?.Url ?? auth.Url, UriKind.Absolute, out var address) && address.Scheme == "https")
            {
                var link = Pill(LinuxStrings.HarnessAuthenticationWindow_Render_9, primary: true); link.HorizontalAlignment = HorizontalAlignment.Left; link.Margin = new Thickness(0, 14, 0, 10);
                link.Click += (_, _) => SettingsUi.OpenExternal(address.AbsoluteUri, message => ShowStatus(LinuxStrings.HarnessAuthenticationWindow_Render_10(message))); details.Children.Add(link);
            }
            if (!string.IsNullOrEmpty(auth.UserCode)) { details.Children.Add(new TextBlock { Text = LinuxStrings.HarnessAuthenticationWindow_Render_11, FontSize = 14, Margin = new Thickness(0, 10, 0, 4) }); details.Children.Add(CardBody(auth.UserCode)); }
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
                    details.Children.Add(CardBody(LinuxStrings.HarnessAuthenticationWindow_Render_12)); details.Children.Add(input);
                    var send = Pill(LinuxStrings.HarnessAuthenticationWindow_Render_13, enabled: !Busy); send.HorizontalAlignment = HorizontalAlignment.Left; details.Children.Add(send);
                    send.Click += (_, _) => { if ((input.Text ?? "").Length == 0) return; var value = input.Text!; input.Text = ""; _ = PerformAsync(() => api.RespondAsync(harness.Id, ui, new { kind = "authorization_code", value }, Token, slot: slot)); };
                }
                else input.Text = "";
            }
            else if (auth.InputRequired && Started)
            {
                var fields = Section(LinuxStrings.HarnessAuthenticationWindow_Render_14); AutomationProperties.SetName(input, LinuxStrings.HarnessAuthenticationWindow_Render_14); fields.Children.Add(input);
                var send = Pill(LinuxStrings.HarnessAuthenticationWindow_Render_16); send.HorizontalAlignment = HorizontalAlignment.Left; send.Margin = new Thickness(0, 12, 0, 8); fields.Children.Add(send);
                send.Click += (_, _) => { if ((input.Text ?? "").Length == 0) return; var text = input.Text!; input.Text = ""; _ = PerformAsync(() => api.InputAsync(harness.Id, text, null, Token, slot: slot)); };
                var keys = new WrapPanel(); fields.Children.Add(keys);
                foreach (var key in new[] { "Enter", "Up", "Down", "Tab" }) { var button = Pill(key); button.Click += (_, _) => _ = PerformAsync(() => api.InputAsync(harness.Id, null, key, Token, slot: slot)); keys.Children.Add(button); }
            }
            else input.Text = "";
        }
        var actions = new WrapPanel { Margin = new Thickness(0, 20, 0, 0) }; Body.Children.Add(actions);
        if ((harness.ReloginSupported != false || Authentication is { Status: not "authenticated" }) && Authentication?.AuthUi is not { Binding: not null, Stage: not "complete" }) { var start = Pill(Authentication?.Status == "authenticated" ? LinuxStrings.HarnessAuthenticationWindow_Render_17 : LinuxStrings.HarnessAuthenticationWindow_Render_18); actions.Children.Add(start); start.Click += async (_, _) => await StartAsync(); }
        else if (Authentication?.Status == "authenticated" && !string.IsNullOrEmpty(harness.StartWarning)) details.Children.Add(CardBody(harness.StartWarning));
        var refresh = Pill(LinuxStrings.GoalViews_Render_12); actions.Children.Add(refresh); refresh.Click += async (_, _) => await InitializeAsync();
        if (Started || Authentication?.AuthUi is { Binding: not null, Stage: not "complete" }) { var cancel = Pill(LinuxStrings.ApprovalsDetail_Answering_5); actions.Children.Add(cancel); cancel.Click += async (_, _) => await PerformAsync(async () => { await api.CancelAsync(harness.Id, Token, slot: slot); Started = false; return await api.StatusAsync(harness.Id, Token, slot: slot); }); }
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
        if (next.Harness != harness.Id) throw new BellApiException(LinuxStrings.HarnessAuthenticationWindow_Apply_1);
        if (next.Slot is { } answered && answered != (slot ?? "1st")) throw new BellApiException(LinuxStrings.HarnessAuthenticationWindow_Apply_2);
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
    public AuthenticationConfirmationWindow(string warning) : base(LinuxStrings.HarnessAuthenticationWindow_AuthenticationConfirmationWindow_1)
    {
        Width = 700; Height = 330; MinHeight = 280;
        Heading(LinuxStrings.HarnessAuthenticationWindow_AuthenticationConfirmationWindow_1); Body.Children.Add(new TextBlock { Text = warning, FontSize = 16, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 4) });
        CloseButton.Content = LinuxStrings.HarnessAuthenticationWindow_AuthenticationConfirmationWindow_3; // the base close answers null, which the caller reads as no
        SaveButton.Content = LinuxStrings.HarnessAuthenticationWindow_AuthenticationConfirmationWindow_4; SaveButton.Click += (_, _) => Close(true);
    }
}
