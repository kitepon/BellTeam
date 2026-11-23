using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using Kitepon.LoginBilling.Desktop;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Linux;

// a540 (login-billing contract 1.36 section 10, the local form): the account of this PC. It never buys. A PC shows the QR of one request; the phone that holds the purchase reads it and answers over the same Wi-Fi;
// this PC checks the answer itself and keeps the end of the period. Google signs in on this PC for each try; Apple is the iPhone's own sign-in. No server, no e-mail, no name exists anywhere.
public sealed class LinuxAccountCard : StackPanel
{
    private readonly CancellationToken token;
    private static DesktopLocal? Local => LinuxAccountStore.Local;
    private LocalPaid? paid;
    private LocalRequest? request;
    private CancellationTokenSource? attempt;
    private string? failure;
    private bool busy;

    // The account gate (first run) waits for this: true while an accepted period holds.
    public bool Entitled => paid is not null;
    public event Action? EntitledChanged;

    public LinuxAccountCard(CancellationToken token)
    {
        this.token = token; Spacing = 0;
        Reload(); Render();
        LinuxAccountStore.Foreground += OnForeground; token.Register(() => LinuxAccountStore.Foreground -= OnForeground);
    }

    private void OnForeground() => Avalonia.Threading.Dispatcher.UIThread.Post(() => { if (token.IsCancellationRequested || busy) return; Reload(); Render(); });

    // The kept reply checked again against this device's clock (every opening and every foreground); null: never paid, or the period ended.
    private void Reload()
    {
        var before = Entitled;
        try { paid = Local?.PaidUntil(); }
        catch (LoginBillingException error) { paid = null; failure = LocalFormText.Failure(error.Code, error.Status); }
        if (before != Entitled) EntitledChanged?.Invoke();
    }

    // One try: Google signs in in the browser, then the QR waits for the phone; every failure ends the try with its sentence, and the next step is a new QR (no automatic refresh).
    private async Task RequestAsync(string provider)
    {
        if (busy || Local is not { } local) return;
        busy = true; failure = null; attempt = CancellationTokenSource.CreateLinkedTokenSource(token); Render();
        try
        {
            request = await local.MakeRequestAsync(provider, ct: attempt.Token); Render();
            paid = await request.AwaitPaidAsync(attempt.Token);
        }
        catch (OperationCanceledException) { }   // the person pressed やめる, or the screen closed
        catch (LoginBillingException error) { failure = LocalFormText.Failure(error.Code, error.Status); }
        request?.Dispose(); request = null; attempt.Dispose(); attempt = null; busy = false;
        EntitledChanged?.Invoke();
        if (!token.IsCancellationRequested) Render();
    }

    private void Render()
    {
        Children.Clear();
        var status = StoreAccount.Status(Entitled);
        var head = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto") };
        var tile = Tile(SettingsPage.Billing, 36); var title = Text(StoreAccountText.Title, 17, Ink, FontWeight.Bold, new Thickness(12, 0, 8, 0)); title.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(title, 1); head.Children.Add(tile); head.Children.Add(title);
        var badge = Badge(status.Badge, status.Tone); Grid.SetColumn(badge, 2); head.Children.Add(badge);
        Children.Add(head);
        if (Local is null) { Children.Add(Text(StoreAccountText.NotConfigured, 14, Muted, null, new Thickness(0, 10, 0, 0))); return; }
        Children.Add(Text(paid is { } now ? (now.Until is { } until ? LocalFormText.Paid(until) : status.Line) : status.Line, 14, Secondary, null, new Thickness(0, 10, 0, 0)));

        if (request is { } open) Children.Add(QrBlock(open.Qr));
        else if (!Entitled)
        {
            Children.Add(Text(LocalFormText.Lead, 13, Muted, null, new Thickness(0, 10, 0, 0)));
            Children.Add(Button(LocalFormText.Google, () => RequestAsync("google"), true));
            Children.Add(Button(LocalFormText.Apple, () => RequestAsync("apple"), true));
        }
        else Children.Add(Button(StoreAccountText.SignOut, () => { Local?.SignOutLocal(); Reload(); Render(); return Task.CompletedTask; }, false));
        if (busy && request is null) Children.Add(Waiting(StoreAccountText.SigningInWeb));
        if (failure is not null) Children.Add(Banner(failure));
    }

    // The QR of one request: the phone that holds the purchase reads it; this PC waits (10 minutes) and has one way out.
    private Control QrBlock(string qr)
    {
        var block = new StackPanel { Margin = new Thickness(0, 14, 0, 0), Spacing = 6 };
        block.Children.Add(Text(LocalFormText.Title, 16, Ink, FontWeight.Bold));
        block.Children.Add(Text(LocalFormText.Lead, 13, Muted));
        block.Children.Add(new QrView(qr, 220) { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 6) });
        block.Children.Add(Text(LocalFormText.Window, 12, Muted));
        block.Children.Add(Waiting(LocalFormText.Waiting));
        var stop = Capsule(LocalFormText.Cancel, Fill, Ink, 12, 14, new Thickness(16, 10));
        stop.HorizontalAlignment = HorizontalAlignment.Left; stop.Margin = new Thickness(0, 12, 0, 0); stop.Click += (_, _) => attempt?.Cancel();
        block.Children.Add(stop);
        return new Border { Child = block, Background = SettingsUi.Canvas, CornerRadius = new CornerRadius(16), Padding = new Thickness(16), Margin = new Thickness(0, 12, 0, 0) };
    }

    private static Control Waiting(string words)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 12, 0, 0) };
        row.Children.Add(Glyph(SettingsIcons.Waiting, 16, Muted)); var text = Text(words, 13, Muted); text.VerticalAlignment = VerticalAlignment.Center; row.Children.Add(text);
        return row;
    }

    private Button Button(string label, Func<Task> click, bool primary)
    {
        var button = Capsule(label, primary ? BellTheme.ProminentFill : Fill, primary ? Brushes.White : Ink, 12, 14, new Thickness(16, 10));
        button.FontWeight = primary ? FontWeight.SemiBold : FontWeight.Normal; button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 12, 0, 0); button.IsEnabled = !busy;
        button.Click += async (_, _) => await click();
        return button;
    }
}
