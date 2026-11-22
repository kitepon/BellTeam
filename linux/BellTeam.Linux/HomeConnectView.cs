using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

// a492: the login screen of a home server (login-billing 0.16.0 HomeConnection). Unbound: the setup code the server printed. Bound: this app logs in with its own pass at once. Linux and Android share it.
// Provisional words. Only a definite 401 deletes the token (the library does that); an unreachable server is said as such and never as "log in again".
internal sealed class HomeConnectView : StartupBackdrop, IDisposable
{
    private readonly IHomeLink home;
    private readonly HomeProbe probe;
    private readonly string kind;
    private readonly Uri origin;
    private readonly Action loggedIn;
    private readonly CancellationTokenSource life = new();
    private readonly StackPanel body = new() { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center, Spacing = 10 };
    private readonly TextBox code = new() { PlaceholderText = "セットアップコード", Padding = new Thickness(10, 8), FontSize = 15, MinWidth = 280 };
    private readonly TextBlock note = new() { FontSize = 13, TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap };
    private readonly Button send;
    private bool busy;
    public Task Running { get; private set; } = Task.CompletedTask;

    public static string Failure(HomeLinkException error) => error.Code switch
    {
        "unreachable" => "サーバーに届きません。通信を確かめて、もう一度お試しください。",
        "LOGIN_CODE_INVALID" => "セットアップコードが正しくないか、期限が切れています。サーバーに出ている新しいコードを入れてください。",
        "SETUP_CODE_REQUIRED" => "このサーバーには、サーバーに出ているセットアップコードが要ります。",
        "NOT_OWNER_ACCOUNT" => "このサーバーの持ち主のアカウントではないため、ログインできませんでした。",
        "AUDIENCE_UNKNOWN" => "このアドレスは、サーバーに登録されていません。",
        "PROOF_REFUSED" or "pass_invalid" => "このアプリのサインインを確かめられませんでした。アカウントの画面でサインインし直してください。",
        "LOGIN_RATE_LIMITED" => "続けて試しすぎました。少し待ってから、もう一度お試しください。",
        "LOGIN_OPERATOR_UNREACHABLE" or "SESSION_STORE_UNAVAILABLE" => "サーバーの準備中です。少し待って、もう一度お試しください。",
        _ => "ログインできませんでした（" + error.Code + (error.Status > 0 ? " " + error.Status : "") + "）。",
    };

    public HomeConnectView(IHomeLink home, HomeProbe probe, string kind, Uri origin, Action loggedIn, Action changeServer)
    {
        this.home = home; this.probe = probe; this.kind = kind; this.origin = origin; this.loggedIn = loggedIn;
        var frame = new Grid { MaxWidth = 520, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(30, 40), RowDefinitions = new RowDefinitions("*,Auto") };
        body.Children.Add(Centered(MacUi.Text("このサーバーにログイン", 28, BellTheme.Ink, FontWeight.Bold)));
        if (probe.Bound) body.Children.Add(Centered(MacUi.Text("このアプリのアカウントで入ります。", 15, BellTheme.Ink)));
        else
        {
            body.Children.Add(Centered(MacUi.Text("初めて使うサーバーです。サーバーに出ているセットアップコードを入れてください。", 15, BellTheme.Ink)));
            body.Children.Add(code);
        }
        send = MacUi.Prominent(probe.Bound ? "ログイン" : "コードでログイン", () => Begin()); send.HorizontalAlignment = HorizontalAlignment.Center; body.Children.Add(send); body.Children.Add(note);
        frame.Children.Add(body);
        var change = MacUi.Bordered("接続先を変更", changeServer); change.HorizontalAlignment = HorizontalAlignment.Center; Grid.SetRow(change, 1); frame.Children.Add(change);
        Children.Add(frame);
        if (probe.Bound) Begin();
    }

    // One attempt at a time; a failed one is shown and retried only by the person pressing the button (the server limits proofs).
    public void Begin() => Running = RunAsync();

    private async Task RunAsync()
    {
        var setup = probe.Bound ? null : code.Text?.Trim();
        if (busy || (!probe.Bound && string.IsNullOrEmpty(setup))) return;
        busy = true; Show("ログインしています…", BellTheme.Muted);
        try
        {
            await home.ConnectAsync(origin.AbsoluteUri.TrimEnd('/') + "/api/home", kind, setup, life.Token);
            busy = false; loggedIn(); return;
        }
        catch (OperationCanceledException) when (life.IsCancellationRequested) { return; }
        catch (HomeLinkException error) { Show(Failure(error), BellTheme.Red); }
        busy = false; Refresh();
    }

    private void Show(string text, IBrush color) => Dispatcher.UIThread.Post(() => { note.Text = text; note.Foreground = color; Refresh(); });
    private void Refresh() { code.IsEnabled = send.IsEnabled = !busy; }

    private static Control Centered(TextBlock text) { text.TextAlignment = TextAlignment.Center; text.TextWrapping = TextWrapping.Wrap; text.HorizontalAlignment = HorizontalAlignment.Center; return text; }

    public void Dispose() => life.Cancel();
}
