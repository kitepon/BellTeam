using System.Net.Http;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using BellTeam.Core;
using Kitepon.LoginBilling.Desktop;

namespace BellTeam.App;

// GET /api/home/session: capability "login-billing-home/1", bound (an account owns the server), enforced (home wire v1, app-sessions.md reading 3).
internal sealed record HomeProbe { public string? Capability { get; init; } public bool Bound { get; init; } public bool Enforced { get; init; } }

internal static class HomeGate
{
    public const string Capability = "login-billing-home/1";

    // null = not a home server, or it could not be read: the normal connect goes on and says what is wrong (unreachable, an older server).
    public static async Task<HomeProbe?> ProbeAsync(Uri origin, CancellationToken token, HttpMessageHandler? transport = null)
    {
        try
        {
            using var api = transport is null ? new BellApi(origin) : new BellApi(origin, transport);
            var probe = await api.GetAsync<HomeProbe>("/api/home/session", token);
            return probe.Capability == Capability ? probe : null;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception) { return null; }
    }

    // The probe when this app must connect first (a home server and no kept token); otherwise null. With a kept token a due reprove runs; a failed one is not fatal: only a 401 ends the session and the library has dropped the record then.
    public static async Task<HomeProbe?> MustBindAsync(HomeConnection home, Uri origin, CancellationToken token)
    {
        if (await ProbeAsync(origin, token) is not { } probe) return null;
        if (home.HomeHeader(origin.AbsoluteUri) is null) return probe;
        try { await home.ReproveIfDueAsync(null, token); }
        catch (LoginBillingException) { }
        return null;
    }
}

// First run, step 3 (app-sessions.md 7d): the address is known; this app signs in at its own server with the pass. Unbound: the setup code the server printed. Bound: it connects at once.
// Only a definite 401 deletes the token (the library does that); an unreachable server is said as such, never as "sign in again".
internal sealed class HomeConnectView : StartupBackdrop, IDisposable
{
    private readonly HomeConnection home;
    private readonly HomeProbe probe;
    private readonly Uri origin;
    private readonly Action connected;
    private readonly CancellationTokenSource life = new();
    private readonly TextBox code = new() { FontSize = 15, Padding = new Thickness(10, 8, 10, 8), MinWidth = 280, MaxWidth = 360 };
    private readonly TextBlock note = MacUi.Text("", 14, MacUi.Muted, margin: new Thickness(0, 12, 0, 0));
    private readonly Button send;
    private bool busy;
    // The running attempt; tests wait on it.
    public Task Running { get; private set; } = Task.CompletedTask;

    public static string Failure(LoginBillingException error) => error.Code switch
    {
        "unreachable" => "サーバーに届きません。通信を確かめて、もう一度お試しください。",
        "LOGIN_CODE_INVALID" => SignInText.SetupCodeInvalid,
        "SETUP_CODE_REQUIRED" => SignInText.SetupCodeRequired,
        "NOT_OWNER_ACCOUNT" => SignInText.NotOwner,
        "AUDIENCE_UNKNOWN" => SignInText.AddressNotRegistered,
        "PROOF_REFUSED" or "pass_invalid" => "このアプリのサインインを確かめられませんでした。アカウントの画面でサインインし直してください。",
        "LOGIN_RATE_LIMITED" => "続けて試しすぎました。少し待ってから、もう一度お試しください。",
        "LOGIN_OPERATOR_UNREACHABLE" or "SESSION_STORE_UNAVAILABLE" => SignInText.ServerNotReady,
        _ => StoreAccountText.Failure(error.Status > 0 ? error.Code + " " + error.Status : error.Code),
    };

    public HomeConnectView(HomeConnection home, HomeProbe probe, Uri origin, Action connected, Action changeServer)
    {
        this.home = home; this.probe = probe; this.origin = origin; this.connected = connected;
        var frame = new Grid { MaxWidth = 520, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(30, 40, 30, 40) };
        frame.RowDefinitions.Add(new RowDefinition()); frame.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var body = new StackPanel { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
        body.Children.Add(Centered(MacUi.Text(StoreAccountText.GateNext, 28, MacUi.Ink, FontWeights.Bold)));
        if (!probe.Bound)
        {
            body.Children.Add(Centered(MacUi.Text(SignInText.SetupCodeLabel, 15, MacUi.Ink, FontWeights.SemiBold, new Thickness(0, 18, 0, 6))));
            AutomationProperties.SetName(code, SignInText.SetupCodeLabel);
            body.Children.Add(code);
            body.Children.Add(Centered(MacUi.Text(SignInText.SetupCodeHint, 12, MacUi.Muted, margin: new Thickness(0, 6, 0, 0))));
        }
        send = MacUi.Prominent(StoreAccountText.GateNext, Begin); send.HorizontalAlignment = HorizontalAlignment.Center; send.Margin = new Thickness(0, 14, 0, 0);
        body.Children.Add(send); body.Children.Add(Centered(note));
        frame.Children.Add(body);
        var change = MacUi.Bordered("接続先を変更", changeServer); change.HorizontalAlignment = HorizontalAlignment.Center; Grid.SetRow(change, 1); frame.Children.Add(change);
        Children.Add(frame);
        if (probe.Bound) Begin();
    }

    // One attempt at a time; a failed one is shown and retried only by the person pressing the button (the server limits proofs).
    public void Begin() => Running = RunAsync();

    private async Task RunAsync()
    {
        var setup = probe.Bound ? null : code.Text.Trim();
        if (busy || (!probe.Bound && setup!.Length == 0)) return;
        busy = true; Show(SignInText.Connecting, MacUi.Muted);
        try
        {
            await home.ConnectHomeAsync(origin.AbsoluteUri.TrimEnd('/') + "/api/home", "windows", setup, null, life.Token);
            busy = false; connected(); return;
        }
        catch (OperationCanceledException) when (life.IsCancellationRequested) { return; }
        catch (LoginBillingException error) { Show(Failure(error), MacUi.Red); }
        busy = false; code.IsEnabled = send.IsEnabled = true;
    }

    private void Show(string text, System.Windows.Media.Brush color) { note.Text = text; note.Foreground = color; code.IsEnabled = send.IsEnabled = !busy; }

    private static FrameworkElement Centered(TextBlock text) { text.TextAlignment = TextAlignment.Center; text.TextWrapping = TextWrapping.Wrap; text.HorizontalAlignment = HorizontalAlignment.Center; return text; }

    public void Dispose() => life.Cancel();
}
