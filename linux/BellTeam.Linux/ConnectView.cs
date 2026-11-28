using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

// a485, shape 2 (app-sessions.md section 7b): the server shows a code, the owner types it on a phone that is already logged in (or approves in an app that is in, or gives a console code), and this screen waits.
// Linux and Android share it. The token the server issues is kept per server address and sent as a Bearer token afterwards.
internal sealed class ConnectView : StartupBackdrop, IDisposable
{
    private readonly LoginApi api;
    private readonly string kind;
    private readonly Uri origin;
    private readonly ISessionTokenStore tokens;
    private readonly Action loggedIn;
    private readonly StackPanel body = new() { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center, Spacing = 10 };
    private readonly CancellationTokenSource life = new();
    // The dynamic part is redrawn at every poll; the console code field below it is built once so typing and focus survive.
    private readonly StackPanel top = new() { Spacing = 10 };
    private readonly TextBlock consoleNote = new() { FontSize = 12, Foreground = BellTheme.Red, TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap, IsVisible = false };
    private readonly Button consoleSend;
    private readonly TextBox consoleCode = new() { PlaceholderText = LinuxStrings.ConnectView_consoleCode_1, Padding = new Thickness(10, 8), FontSize = 15, MinWidth = 280 };
    private LoginFlow flow;
    private CancellationTokenSource attempt = new();
    private string? consoleFailure;
    private bool consoleBusy;
    // The running attempt; tests and the renders wait on it.
    public Task Running { get; private set; } = Task.CompletedTask;
    internal LoginFlow Flow => flow;

    public ConnectView(LoginApi api, string kind, Uri origin, ISessionTokenStore tokens, Action loggedIn, Action changeServer)
    {
        this.api = api; this.kind = kind; this.origin = origin; this.tokens = tokens; this.loggedIn = loggedIn;
        flow = new LoginFlow(api, kind);
        var frame = new Grid { MaxWidth = 520, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(30, 40), RowDefinitions = new RowDefinitions("*,Auto") };
        body.Children.Add(Centered(MacUi.Text(LinuxStrings.ConnectView_ConnectView_1, 28, BellTheme.Ink, FontWeight.Bold)));
        body.Children.Add(Centered(MacUi.Text(LinuxStrings.ConnectView_ConnectView_2, 17, BellTheme.Ink, FontWeight.SemiBold, new Thickness(0, 14, 0, 0))));
        body.Children.Add(top);
        body.Children.Add(Centered(MacUi.Text(LinuxStrings.ConnectView_ConnectView_3, 17, BellTheme.Ink, FontWeight.SemiBold, new Thickness(0, 22, 0, 0))));
        body.Children.Add(consoleCode);
        consoleSend = MacUi.Bordered(LinuxStrings.ConnectView_ConnectView_4, () => _ = UseConsoleCodeAsync()); consoleSend.HorizontalAlignment = HorizontalAlignment.Center; body.Children.Add(consoleSend); body.Children.Add(consoleNote);
        frame.Children.Add(body);
        var change = MacUi.Bordered(LinuxStrings.ConnectView_ConnectView_5, changeServer); change.HorizontalAlignment = HorizontalAlignment.Center; Grid.SetRow(change, 1); frame.Children.Add(change);
        Children.Add(frame);
        Begin();
    }

    // One attempt at a time; a new one starts only by the person pressing the button (the server limits how many logins one address may hold).
    private void Begin()
    {
        attempt.Cancel(); attempt.Dispose();
        attempt = CancellationTokenSource.CreateLinkedTokenSource(life.Token);
        var mine = flow = new LoginFlow(api, kind);
        mine.Changed += () => Dispatcher.UIThread.Post(() => { if (flow == mine) Render(); });
        var token = attempt.Token;
        Running = RunAsync(mine, token);
        Render();
    }

    private async Task RunAsync(LoginFlow mine, CancellationToken token)
    {
        await mine.RunAsync(token);
        if (mine.Phase == LoginPhase.Approved && flow == mine && !token.IsCancellationRequested) Finish(mine.Token!);
    }

    private void Finish(string token) { tokens.Save(origin, token); loggedIn(); }

    private async Task UseConsoleCodeAsync()
    {
        var code = consoleCode.Text ?? "";
        if (consoleBusy || string.IsNullOrWhiteSpace(code)) return;
        consoleBusy = true; consoleFailure = null; Render();
        try
        {
            var answer = await api.ConsoleAsync(code, kind, life.Token);
            if (string.IsNullOrEmpty(answer.Token)) { consoleFailure = LinuxStrings.ConnectView_UseConsoleCodeAsync_1; consoleBusy = false; Render(); return; }
            attempt.Cancel(); consoleBusy = false; Finish(answer.Token);
        }
        catch (OperationCanceledException) when (life.IsCancellationRequested) { return; }
        catch (BellApiException error) when (error.Code == "LOGIN_CODE_INVALID") { consoleFailure = LinuxStrings.ConnectView_UseConsoleCodeAsync_2; }
        catch (Exception error) { consoleFailure = LinuxStrings.ConnectView_UseConsoleCodeAsync_3(error.Message); }
        consoleBusy = false; Render();
    }

    private void Render()
    {
        var body = top; body.Children.Clear();
        var status = flow.Status;
        switch (flow.Phase)
        {
            case LoginPhase.Starting: body.Children.Add(Centered(MacUi.Text(LinuxStrings.ConnectView_Render_1, 15, BellTheme.Muted))); break;
            case LoginPhase.WaitingSecondHand:
                body.Children.Add(Centered(MacUi.Text(LinuxStrings.ConnectView_Render_2, 15, BellTheme.Ink)));
                body.Children.Add(Centered(MacUi.Text(LinuxStrings.ConnectView_Render_3, 13, BellTheme.Muted))); break;
            case LoginPhase.WaitingPhone when status?.Phone is { } phone:
                body.Children.Add(Centered(MacUi.Text(LinuxStrings.ConnectView_Render_4, 15, BellTheme.Ink)));
                var code = new SelectableTextBlock { Text = phone.ShortCode, FontSize = 44, FontWeight = FontWeight.Bold, FontFamily = new FontFamily("monospace"), Foreground = BellTheme.Ink, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 8) };
                AutomationProperties.SetName(code, LinuxStrings.ConnectView_Render_5); body.Children.Add(code);
                var check = Centered(MacUi.Text(LinuxStrings.ConnectView_Render_6(phone.CheckNumber), 20, BellTheme.Ink, FontWeight.SemiBold)); AutomationProperties.SetName(check, LinuxStrings.ConnectView_Render_7); body.Children.Add(check);
                body.Children.Add(Centered(MacUi.Text(LinuxStrings.ConnectView_Render_8, 13, BellTheme.Muted)));
                break;
            case LoginPhase.Refused or LoginPhase.Failed:
                body.Children.Add(Centered(MacUi.Text(flow.Message ?? LinuxStrings.ConnectView_Render_9, 15, BellTheme.Red)));
                var again = MacUi.Prominent(LinuxStrings.ConnectView_Render_10, Begin); again.HorizontalAlignment = HorizontalAlignment.Center; body.Children.Add(again); break;
            case LoginPhase.Approved: body.Children.Add(Centered(MacUi.Text(LinuxStrings.ConnectView_Render_11, 15, BellTheme.Muted))); break;
        }
        // A failed poll while waiting is shown and retried by itself (the code on screen stays valid until it expires).
        if (flow.Phase is LoginPhase.WaitingSecondHand or LoginPhase.WaitingPhone && flow.Message is { } retrying) body.Children.Add(Centered(MacUi.Text(retrying, 12, BellTheme.Red)));
        consoleCode.IsEnabled = consoleSend.IsEnabled = !consoleBusy;
        consoleNote.Text = consoleFailure; consoleNote.IsVisible = consoleFailure is not null;
    }

    private static Control Centered(TextBlock text) { text.TextAlignment = TextAlignment.Center; text.TextWrapping = TextWrapping.Wrap; text.HorizontalAlignment = HorizontalAlignment.Center; return text; }

    public void Dispose()
    {
        var mine = flow; life.Cancel();
        _ = mine.CancelAsync();
    }
}
