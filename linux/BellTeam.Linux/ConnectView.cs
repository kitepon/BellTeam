using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;

namespace BellTeam.Linux;

// a485, C-04 (app-sessions.md sections 2 and 4, Apple's ServerLoginView and Windows' ServerCodeView are the pattern): a server that mounts the login-billing home part takes a code from its console.
// The code goes once to POST /api/home/login/console (a failed attempt asks for a new code, never resends); the token it returns is kept per server address and sent as a Bearer token afterwards. Linux and Android share it.
internal sealed class ConnectView : StartupBackdrop, IDisposable
{
    private readonly BellApi api;
    private readonly Uri origin;
    private readonly ISessionTokenStore tokens;
    private readonly Action loggedIn;
    private readonly CancellationTokenSource life = new();
    private readonly TextBlock note = new() { FontSize = 12, Foreground = BellTheme.Red, TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap, IsVisible = false };
    private readonly Button send;
    private readonly TextBox code = new() { PlaceholderText = LinuxStrings.ConnectView_consoleCode_1, Padding = new Thickness(10, 8), FontSize = 15, MinWidth = 280 };
    private string? failure;
    private bool busy;
    // The running attempt; tests wait on it.
    public Task Running { get; private set; } = Task.CompletedTask;
    public string? Failure => failure;

    // The view owns api (a client without the stale token) and disposes it.
    public ConnectView(BellApi api, Uri origin, ISessionTokenStore tokens, Action loggedIn, Action changeServer)
    {
        this.api = api; this.origin = origin; this.tokens = tokens; this.loggedIn = loggedIn;
        var frame = new Grid { MaxWidth = 520, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(30, 40), RowDefinitions = new RowDefinitions("*,Auto") };
        var body = new StackPanel { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center, Spacing = 10 };
        body.Children.Add(Centered(MacUi.Text(LinuxStrings.ConnectView_ConnectView_1, 28, BellTheme.Ink, FontWeight.Bold)));
        body.Children.Add(Centered(MacUi.Text(LinuxStrings.ConnectView_ConnectView_3, 17, BellTheme.Ink, FontWeight.SemiBold, new Thickness(0, 22, 0, 0))));
        body.Children.Add(code);
        send = MacUi.Bordered(LinuxStrings.ConnectView_ConnectView_4, () => Running = SubmitAsync()); send.HorizontalAlignment = HorizontalAlignment.Center; body.Children.Add(send); body.Children.Add(note);
        frame.Children.Add(body);
        var change = MacUi.Bordered(LinuxStrings.ConnectView_ConnectView_5, changeServer); change.HorizontalAlignment = HorizontalAlignment.Center; Grid.SetRow(change, 1); frame.Children.Add(change);
        Children.Add(frame);
    }

    private async Task SubmitAsync()
    {
        var text = code.Text ?? "";
        if (busy || string.IsNullOrWhiteSpace(text)) return;
        busy = true; failure = null; Render();
        try
        {
            var answer = await new HomeLoginApi(api).ConsoleAsync(text, life.Token);
            tokens.Save(origin, answer.Token!);
            busy = false; loggedIn(); return;
        }
        catch (OperationCanceledException) when (life.IsCancellationRequested) { return; }
        catch (Exception error) { failure = HomeLoginText.Of(error); }
        busy = false; Render();
    }

    private void Render()
    {
        code.IsEnabled = send.IsEnabled = !busy;
        note.Text = failure; note.IsVisible = failure is not null;
    }

    private static Control Centered(TextBlock text) { text.TextAlignment = TextAlignment.Center; text.TextWrapping = TextWrapping.Wrap; text.HorizontalAlignment = HorizontalAlignment.Center; return text; }

    public void Dispose() { life.Cancel(); api.Dispose(); }
}
