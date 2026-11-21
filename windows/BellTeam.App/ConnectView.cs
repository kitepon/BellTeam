using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using BellTeam.Core;

namespace BellTeam.App;

// a485, shape 2 (app-sessions.md section 7b, twin of the Linux ConnectView): the server shows a code, the owner types it on a phone that is already logged in (or approves in an app that is in, or gives a console code), and this screen waits.
// The token the server issues is kept per server address (DPAPI) and sent as a Bearer token afterwards. The server's QR (SVG) is not drawn: the short code and the check number are the required display.
internal sealed class ConnectView : StartupBackdrop, IDisposable
{
    private readonly LoginApi api;
    private readonly string kind;
    private readonly Uri origin;
    private readonly ISessionTokenStore tokens;
    private readonly Action loggedIn;
    private readonly CancellationTokenSource life = new();
    // The dynamic part is redrawn at every poll; the console code field below it is built once so typing and focus survive.
    private readonly StackPanel top = new();
    private readonly TextBlock consoleNote = MacUi.Text("", 12, MacUi.Red, margin: new Thickness(0, 8, 0, 0));
    private readonly TextBox consoleCode = new() { FontSize = 15, Padding = new Thickness(10, 8, 10, 8), MinWidth = 280, MaxWidth = 360 };
    private readonly Button consoleSend;
    private LoginFlow flow;
    private CancellationTokenSource attempt = new();
    private string? consoleFailure;
    private bool consoleBusy;
    // The running attempt; tests wait on it.
    public Task Running { get; private set; } = Task.CompletedTask;
    internal LoginFlow Flow => flow;

    public ConnectView(LoginApi api, string kind, Uri origin, ISessionTokenStore tokens, Action loggedIn, Action changeServer)
    {
        this.api = api; this.kind = kind; this.origin = origin; this.tokens = tokens; this.loggedIn = loggedIn;
        flow = new LoginFlow(api, kind);
        var frame = new Grid { MaxWidth = 520, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(30, 40, 30, 40) };
        frame.RowDefinitions.Add(new RowDefinition()); frame.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var body = new StackPanel { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
        body.Children.Add(Centered(MacUi.Text("このサーバーにログイン", 28, MacUi.Ink, FontWeights.Bold)));
        body.Children.Add(Centered(MacUi.Text("スマホで承認する", 17, MacUi.Ink, FontWeights.SemiBold, new Thickness(0, 14, 0, 0))));
        body.Children.Add(top);
        body.Children.Add(Centered(MacUi.Text("サーバーのコードで入る", 17, MacUi.Ink, FontWeights.SemiBold, new Thickness(0, 22, 0, 8))));
        AutomationProperties.SetName(consoleCode, "サーバーのコンソールのコード");
        body.Children.Add(consoleCode);
        consoleSend = MacUi.Bordered("コードでログイン", () => _ = UseConsoleCodeAsync()); consoleSend.HorizontalAlignment = HorizontalAlignment.Center; consoleSend.Margin = new Thickness(0, 10, 0, 0); body.Children.Add(consoleSend); body.Children.Add(Centered(consoleNote));
        // Tronie's wording (app-sessions.md 7e), the same in every app: a person with no contract enters by a code.
        body.Children.Add(Centered(MacUi.Text("購読していない場合は、サーバーのコンソールで出したコード、またはすでに入っているアプリの「アプリを追加」で出したコードで入れます。", 12, MacUi.Muted, margin: new Thickness(0, 14, 0, 0))));
        frame.Children.Add(body);
        var change = MacUi.Bordered("接続先を変更", changeServer); change.HorizontalAlignment = HorizontalAlignment.Center; Grid.SetRow(change, 1); frame.Children.Add(change);
        Children.Add(frame);
        Begin();
    }

    // One attempt at a time; a new one starts only by the person pressing the button (the server limits how many logins one address may hold).
    private void Begin()
    {
        attempt.Cancel(); attempt.Dispose();
        attempt = CancellationTokenSource.CreateLinkedTokenSource(life.Token);
        var mine = flow = new LoginFlow(api, kind);
        mine.Changed += () => Dispatcher.BeginInvoke(() => { if (flow == mine) Render(); });
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
        var code = consoleCode.Text;
        if (consoleBusy || string.IsNullOrWhiteSpace(code)) return;
        consoleBusy = true; consoleFailure = null; Render();
        try
        {
            var answer = await api.ConsoleAsync(code, kind, life.Token);
            if (string.IsNullOrEmpty(answer.Token)) { consoleFailure = "サーバーからログインの鍵を受け取れませんでした。新しいコードで試してください。"; consoleBusy = false; Render(); return; }
            attempt.Cancel(); consoleBusy = false; Finish(answer.Token);
            return;
        }
        catch (OperationCanceledException) when (life.IsCancellationRequested) { return; }
        catch (BellApiException error) when (error.Code == "LOGIN_CODE_INVALID") { consoleFailure = "コードが正しくないか、すでに使われています。"; }
        catch (Exception error) { consoleFailure = "コードを送れませんでした。" + error.Message; }
        consoleBusy = false; Render();
    }

    private void Render()
    {
        top.Children.Clear();
        var status = flow.Status;
        switch (flow.Phase)
        {
            case LoginPhase.Starting: top.Children.Add(Centered(MacUi.Text("ログインを始めています…", 15, MacUi.Muted))); break;
            case LoginPhase.WaitingSecondHand:
                top.Children.Add(Centered(MacUi.Text("ログイン済みのアプリで許可してください。サーバーのコンソールで出したコードも使えます。", 15, MacUi.Ink)));
                top.Children.Add(Centered(MacUi.Text("許可を待っています…", 13, MacUi.Muted))); break;
            case LoginPhase.WaitingPhone when status?.Phone is { } phone:
                top.Children.Add(Centered(MacUi.Text("ログイン済みのスマートフォンのBellTeamで、次のコードを入力してください。", 15, MacUi.Ink)));
                var code = MacUi.Text(phone.ShortCode, 44, MacUi.Ink, FontWeights.Bold, new Thickness(0, 8, 0, 8)); code.FontFamily = new System.Windows.Media.FontFamily("Consolas"); AutomationProperties.SetName(code, "ログインのコード"); top.Children.Add(Centered(code));
                var check = Centered(MacUi.Text("確認番号 " + phone.CheckNumber, 20, MacUi.Ink, FontWeights.SemiBold)); AutomationProperties.SetName(check, "確認番号"); top.Children.Add(check);
                top.Children.Add(Centered(MacUi.Text("スマートフォンにも同じ確認番号が出たら許可してください。", 13, MacUi.Muted))); break;
            case LoginPhase.Refused or LoginPhase.Failed:
                top.Children.Add(Centered(MacUi.Text(flow.Message ?? "ログインできませんでした。", 15, MacUi.Red)));
                var again = MacUi.Prominent("もう一度始める", Begin); again.HorizontalAlignment = HorizontalAlignment.Center; again.Margin = new Thickness(0, 10, 0, 0); top.Children.Add(again); break;
            case LoginPhase.Approved: top.Children.Add(Centered(MacUi.Text("ログインしました。接続しています…", 15, MacUi.Muted))); break;
        }
        // A failed poll while waiting is shown and retried by itself (the code on screen stays valid until it expires).
        if (flow.Phase is LoginPhase.WaitingSecondHand or LoginPhase.WaitingPhone && flow.Message is { } retrying) top.Children.Add(Centered(MacUi.Text(retrying, 12, MacUi.Red)));
        consoleCode.IsEnabled = consoleSend.IsEnabled = !consoleBusy;
        consoleNote.Text = consoleFailure ?? ""; consoleNote.Visibility = consoleFailure is null ? Visibility.Collapsed : Visibility.Visible;
    }

    private static FrameworkElement Centered(TextBlock text) { text.TextAlignment = TextAlignment.Center; text.TextWrapping = TextWrapping.Wrap; text.HorizontalAlignment = HorizontalAlignment.Center; return text; }

    public void Dispose()
    {
        var mine = flow; life.Cancel();
        _ = mine.CancelAsync();
    }
}
