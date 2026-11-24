using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using Kitepon.LoginBilling.Desktop;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Linux;

// a540 (login-billing contract 1.36 section 10, the local form): the account of this PC. It never buys. A PC shows the QR of one request; the phone that holds the purchase reads it and answers over the same network (LAN);
// this PC checks the answer itself and keeps the end of the period. Google signs in on this PC for each try; Apple is the iPhone's own sign-in. No server, no e-mail, no name exists anywhere.
public sealed class LinuxAccountCard : StackPanel
{
    private readonly CancellationToken token;
    private static DesktopLocal? Local => LinuxAccountStore.Local;
    private LocalPaid? paid;
    private LocalRequest? request;
    private CancellationTokenSource? attempt;
    private string? failure, notice;   // notice: the plain line under the status (PaidOk, or PeriodEnded when the kept period ran out); failure is the red one
    private DateTimeOffset expiry;     // when the QR stops being taken
    private bool busy, confirmingDelete;
    private readonly bool firstScreen;   // the gate of the first run (Approval Box's first screen is the model); the card in the settings keeps its own layout
    private readonly string? preview;    // render scenes only: a QR to show without a live request

    // The account gate (first run) waits for this: true while an accepted period holds.
    public bool Entitled => paid is not null;
    public event Action? EntitledChanged;

    public LinuxAccountCard(CancellationToken token, bool firstScreen = false, string? preview = null)
    {
        this.token = token; this.firstScreen = firstScreen; this.preview = preview; Spacing = 0;
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
        if (before && !Entitled) notice = LocalFormText.PeriodEnded;
        if (before != Entitled) EntitledChanged?.Invoke();
    }

    // One try: Google signs in in the browser, then the QR waits for the phone; every failure ends the try with its sentence, and the next step is a new QR (no automatic refresh).
    private async Task RequestAsync(string provider)
    {
        if (busy || Local is not { } local) return;
        busy = true; failure = notice = null; attempt = CancellationTokenSource.CreateLinkedTokenSource(token); Render();
        try
        {
            request = await local.MakeRequestAsync(provider, ct: attempt.Token); expiry = DateTimeOffset.Now.AddMinutes(LocalForm.ListenMinutes); Render();
            paid = await request.AwaitPaidAsync(attempt.Token); notice = LocalFormText.PaidOk;
        }
        catch (OperationCanceledException) { }   // the person pressed やめる, or the screen closed
        catch (LoginBillingException error) when (error.Code == "signin_cancelled") { }   // the person's own choice says nothing
        catch (LoginBillingException error) { failure = LocalFormText.Failure(error.Code, error.Status, error.Detail); }
        request?.Dispose(); request = null; attempt.Dispose(); attempt = null; busy = false;
        EntitledChanged?.Invoke();
        if (!token.IsCancellationRequested) Render();
    }

    private void Render()
    {
        Children.Clear();
        if (firstScreen && !Entitled && Local is not null) { RenderFirstScreen(); return; }
        RenderBody();
        if (firstScreen) { var items = Children.ToList(); Children.Clear(); var inner = new StackPanel(); inner.Children.AddRange(items); Children.Add(SettingsUi.Card(inner)); }
    }

    // The first screen while this device is not yet approved: before sign-in the name, the one line and the Owner's sentence with the two ways in; once a request is open the screen that waits for the parent device.
    private void RenderFirstScreen()
    {
        if ((request?.Qr ?? preview) is { } qr) { Children.Add(QrScreen(qr)); return; }
        // The app's own portrait above the name, 88 px with rounded corners (Windows' first screen has the same tile).
        var icon = Round.Clip(new Image { Source = EmbeddedAsset.Portrait(176), Stretch = Stretch.UniformToFill, Width = 88, Height = 88 }, 22); icon.HorizontalAlignment = HorizontalAlignment.Center; icon.Margin = new Thickness(0, 16, 0, 0);
        var name = Text(LocalFormText.AppName, 34, Ink, FontWeight.Bold, new Thickness(0, 14, 0, 0)); name.HorizontalAlignment = HorizontalAlignment.Center;
        var purpose = Text(LocalFormText.Purpose, 16, Muted, null, new Thickness(0, 8, 0, 24)); purpose.HorizontalAlignment = HorizontalAlignment.Center; purpose.TextAlignment = TextAlignment.Center;
        Children.Add(icon); Children.Add(name); Children.Add(purpose);
        var inner = new StackPanel();
        if (notice is not null) inner.Children.Add(Text(notice, 14, Ink, FontWeight.SemiBold, new Thickness(0, 0, 0, 8)));
        inner.Children.Add(Text(LocalFormText.FirstSignIn, 14, Secondary));
        // Apple's rule: its button is black and the first, and the only black one; Google's is white with a hairline, as on Windows.
        foreach (var (label, provider, look) in new[] { (SignInText.Apple, "apple", Look.Apple), (SignInText.Google, "google", Look.Google) })
        { var way = Button(label, () => RequestAsync(provider), look); way.HorizontalAlignment = HorizontalAlignment.Stretch; way.HorizontalContentAlignment = HorizontalAlignment.Center; inner.Children.Add(way); }
        if (busy && request is null && attempt is { } signing) { inner.Children.Add(Waiting(SignInText.Waiting)); var stop = Capsule(LocalFormText.Cancel, Fill, Ink, 12, 14, new Thickness(16, 10)); stop.HorizontalAlignment = HorizontalAlignment.Left; stop.Margin = new Thickness(0, 12, 0, 0); stop.Click += (_, _) => signing.Cancel(); inner.Children.Add(stop); }
        if (failure is not null) inner.Children.Add(Banner(failure));
        Children.Add(SettingsUi.Card(inner));
    }

    // The waiting screen: the title, the QR, how long it holds, the Owner's sentence, the way out (Approval Box 0.2.2's qr-screen; BellTeam has no 「この端末を親にする」).
    internal Control QrScreen(string qr)
    {
        var column = new StackPanel { Spacing = 6, Margin = new Thickness(0, 24, 0, 0) };
        column.Children.Add(Text(LocalFormText.WaitingTitle, 20, Ink, FontWeight.Bold));
        var code = new QrView(qr, 280) { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 6) }; Avalonia.Automation.AutomationProperties.SetName(code, LocalFormText.QrLabel);
        column.Children.Add(code);
        column.Children.Add(Waiting(LocalFormText.ValidUntil(request is null ? DateTimeOffset.Now.AddMinutes(LocalForm.ListenMinutes) : expiry)));
        column.Children.Add(Text(LocalFormText.Qr, 14, Ink, null, new Thickness(0, 6, 0, 0)));
        var stop = Capsule(LocalFormText.Cancel, Fill, Ink, 12, 14, new Thickness(16, 10)); stop.HorizontalAlignment = HorizontalAlignment.Left; stop.Margin = new Thickness(0, 12, 0, 0); stop.Click += (_, _) => attempt?.Cancel();
        column.Children.Add(stop);
        return column;
    }

    private void RenderBody()
    {
        // Rapi's table (docs/apple-qr-approval-wording): the card title and the status line are the table's; the badge stays as on the Windows card (not in the table).
        var status = StoreAccount.Status(Entitled);
        var head = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto") };
        var tile = Tile(SettingsPage.Billing, 36); var title = Text(LocalFormText.CardTitle, 17, Ink, FontWeight.Bold, new Thickness(12, 0, 8, 0)); title.VerticalAlignment = VerticalAlignment.Center;
        var badge = Badge(status.Badge, status.Tone); Grid.SetColumn(title, 1); Grid.SetColumn(badge, 2); head.Children.Add(tile); head.Children.Add(title); head.Children.Add(badge);
        Children.Add(head);
        if (Local is null) { Children.Add(Text(StoreAccountText.NotConfigured, 14, Muted, null, new Thickness(0, 10, 0, 0))); RenderDelete(); return; }
        Children.Add(Text(paid is { } now ? LocalFormText.Status(now.Until) : LocalFormText.StatusUnpaid, 14, Secondary, null, new Thickness(0, 10, 0, 0)));
        if (notice is not null && request is null) Children.Add(Text(notice, 14, Ink, FontWeight.SemiBold, new Thickness(0, 6, 0, 0)));

        if (request is { } open) Children.Add(QrBlock(open.Qr));
        else if (!Entitled)
        {
            Children.Add(Text(LocalFormText.Title, 16, Ink, FontWeight.Bold, new Thickness(0, 14, 0, 0)));
            Children.Add(Text(LocalFormText.Lead, 13, Muted, null, new Thickness(0, 6, 0, 0)));
            Children.Add(Text(LocalFormText.FirstSignIn, 13, Ink, null, new Thickness(0, 6, 0, 0)));
            Children.Add(Button(LocalFormText.Google, () => RequestAsync("google"), Look.Primary));
            Children.Add(Button(LocalFormText.Apple, () => RequestAsync("apple"), Look.Primary));
        }
        else Children.Add(Button(StoreAccountText.SignOut, () => { Local?.SignOutLocal(); Reload(); Render(); return Task.CompletedTask; }, Look.Secondary));
        // The browser sign-in has no signal when the person closes the tab: it waits for the return, so this is the way out (Apple's and Google's alike).
        if (busy && request is null && attempt is { } signing) { Children.Add(Waiting(StoreAccountText.SigningInWeb)); var stop = Capsule(LocalFormText.Cancel, Fill, Ink, 12, 14, new Thickness(16, 10)); stop.HorizontalAlignment = HorizontalAlignment.Left; stop.Margin = new Thickness(0, 12, 0, 0); stop.Click += (_, _) => signing.Cancel(); Children.Add(stop); }
        RenderDelete();
        if (failure is not null) Children.Add(Banner(failure));
    }

    // The QR of one request: the phone that holds the purchase reads it; this PC waits (10 minutes) and has one way out.
    internal Control QrBlock(string qr)
    {
        var block = new StackPanel { Margin = new Thickness(0, 14, 0, 0), Spacing = 6 };
        block.Children.Add(Text(LocalFormText.Title, 16, Ink, FontWeight.Bold));
        block.Children.Add(Text(LocalFormText.Lead, 13, Muted));
        var code = new QrView(qr, 280) { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 6) }; Avalonia.Automation.AutomationProperties.SetName(code, LocalFormText.QrLabel);
        block.Children.Add(code);
        // 1.49 (11.12): the library's own sentence, word for word, directly under the QR on every client.
        var guidance = Text(LocalFormText.Qr, 14, Ink); guidance.TextAlignment = TextAlignment.Center; block.Children.Add(guidance);
        block.Children.Add(Waiting(LocalFormText.WaitingUntil(expiry)));
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

    // 「アカウントを削除」: the last item, under a divider (Rapi's Mac reference). The subscription is the paying phone's store (a desktop never buys), so the words name no single store.
    private const string Subscription = "購読は購入したストアのものなので、この操作では解約されません。解約は購入したストアの購読の管理から行ってください。", Cancel = "購読を止めるには、購入したストアの購読の管理から解約してください。";
    private void RenderDelete()
    {
        if (AccountDeletion.Run is null) return;
        Children.Add(new Border { Height = 1, Background = Hairline, Margin = new Thickness(0, 16, 0, 4) });
        if (!confirmingDelete) { Children.Add(Button(AccountDeletionText.Button, () => { confirmingDelete = true; Render(); return Task.CompletedTask; }, Look.Danger)); return; }
        Children.Add(Text(AccountDeletionText.ConfirmTitle, 15, Ink, FontWeight.SemiBold, new Thickness(0, 8, 0, 0)));
        Children.Add(Text(AccountDeletionText.ConfirmBody(Subscription), 13, Muted, null, new Thickness(0, 6, 0, 0)));
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        row.Children.Add(Button(AccountDeletionText.ConfirmYes, DeleteAsync, Look.DangerFilled));
        row.Children.Add(Button(AccountDeletionText.ConfirmNo, () => { confirmingDelete = false; Render(); return Task.CompletedTask; }, Look.Secondary));
        Children.Add(row);
    }

    private async Task DeleteAsync()
    {
        confirmingDelete = false; busy = true; failure = null; Render();
        try { await AccountDeletion.Run!(); }
        catch (Exception error) { failure = error.Message; }
        busy = false;
        if (!token.IsCancellationRequested) Render();
    }

    public static string DoneText => AccountDeletionText.ResultBody(Cancel);

    private enum Look { Primary, Secondary, Danger, DangerFilled, Apple, Google }

    private Button Button(string label, Func<Task> click, Look look)
    {
        var (background, foreground) = look switch
        {
            Look.Primary => ((IBrush)BellTheme.ProminentFill, (IBrush)Brushes.White),
            Look.DangerFilled => (Red, Brushes.White),
            Look.Danger => (Fill, Red),
            Look.Apple => (Brushes.Black, Brushes.White),
            Look.Google => (Brushes.White, Ink),
            _ => (Fill, Ink),
        };
        var button = Capsule(label, background, foreground, 12, 14, new Thickness(16, 10));
        button.FontWeight = look == Look.Secondary ? FontWeight.Normal : FontWeight.SemiBold; button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 12, 0, 0); button.IsEnabled = !busy;
        if (look == Look.Google) { button.BorderBrush = Hairline; button.BorderThickness = new Thickness(1); }
        button.Click += async (_, _) => await click();
        return button;
    }
}
