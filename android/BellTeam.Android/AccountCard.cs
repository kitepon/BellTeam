using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using BellTeam.Core;
using BellTeam.Linux;
using Kitepon.LoginBilling;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Android;

// a540 (login-billing contract 1.36 section 10, the local form): the subscription of this phone, laid out like the Mac 利用と課金 page (icon tile, title and one badge; the state sentence; the actions).
// A phone that holds the Play purchase is paid by its own store check and may let another device in (ApprovePanel). A phone without one shows the QR of a request; a paying phone on the same network (LAN) answers it and this phone
// keeps the end of the period. The purchase and the proof stay in the library; no e-mail or name exists anywhere.
public sealed class AccountCard : StackPanel
{
    private readonly CancellationToken token;
    private static Kitepon.LoginBilling.LocalForm? Local => AccountStore.Local;
    private LocalPaid? paid;            // an accepted reply of a paying phone
    private bool owned;                 // Play holds this phone's own paid purchase
    private ProductInfo? product;
    private LocalRequest? request;
    private CancellationTokenSource? attempt;
    private string? failure, notice;   // notice: the plain line under the status (PaidOk, or PeriodEnded when the kept period ran out); failure is the red one
    private DateTimeOffset expiry;     // when the QR stops being taken
    private bool busy, confirmingDelete;
    private readonly bool firstScreen;   // the gate of the first run (Approval Box's first screen is the model); the card in the settings keeps its own layout
    private readonly string? preview;    // debug render only: "" = the first screen, a QR = the waiting screen, both without asking Play or opening a request

    private ApprovePanel? approve;

    // The account gate (first run) waits for this: true while this phone's purchase or an accepted period holds.
    public bool Entitled => owned || paid is not null;
    public event Action? EntitledChanged;

    public AccountCard(CancellationToken token, bool firstScreen = false, string? preview = null)
    {
        this.token = token; this.firstScreen = firstScreen; this.preview = preview; Spacing = 0;
        Render();
        if (preview is null) _ = ReloadAsync();
        AccountStore.Foreground += OnForeground; token.Register(() => AccountStore.Foreground -= OnForeground);
    }

    private void OnForeground() => Dispatcher.UIThread.Post(() => { if (!busy) _ = ReloadAsync(); });

    // Every opening and every foreground: the kept reply against this device's clock, and Play's own list of this phone's purchases (an ended or refunded one is no longer owned).
    // was: whether the card was entitled before the action that just ended (RunAsync), so a purchase made inside it still raises EntitledChanged.
    private async Task ReloadAsync(bool? was = null)
    {
        if (Local is not { } local) { Render(); return; }
        var before = was ?? Entitled;
        failure = null;
        try { paid = local.PaidUntil(); }
        catch (LoginBillingException error) { paid = null; failure = LocalFormText.Failure(error.Code, error.Reason); }
        try
        {
            owned = (await local.OwnPurchasesAsync()).Any(purchase => purchase.Products.Contains(LocalFormIds.ProductId));
            if (!owned && product is null) product = (await local.ProductDetailsAsync([LocalFormIds.ProductId], subscription: true)).FirstOrDefault();
        }
        catch (LoginBillingException error) { owned = false; failure = StoreAccountText.Failure(error.Code, error.Reason); }
        if (token.IsCancellationRequested) return;
        if (before && !Entitled) notice = LocalFormText.PeriodEnded;
        if (before != Entitled) EntitledChanged?.Invoke();
        Render();
    }

    private Func<string, Task<bool>>? taker;   // 1.60: this request's return link (lbr1) opened in this app or pasted

    private async Task RunAsync(Func<Kitepon.LoginBilling.LocalForm, Task> action)
    {
        if (busy || Local is not { } local) return;
        var was = Entitled;
        busy = true; failure = notice = null; Render();
        try { await action(local); }
        catch (OperationCanceledException) { }   // the person pressed やめる, or the screen closed
        catch (LoginBillingException error) when (error.Code == "signin_cancelled") { }   // the person's own choice says nothing
        catch (LoginBillingException error) { failure = LocalWords.Ja(error.Code) ?? LocalFormText.Failure(error.Code, error.Reason, error.Detail); }
        if (taker is not null) { JoinLink.Takers.Remove(taker); taker = null; } request?.Dispose(); request = null; attempt?.Dispose(); attempt = null; busy = false;
        if (!token.IsCancellationRequested) await ReloadAsync(was);
    }

    // One try: Google signs in on this phone (Apple is the paying iPhone's own sign-in), then the QR waits for the phone that holds the purchase; every failure ends the try with its sentence and the next step is a new QR.
    private Task RequestAsync(string provider) => RunAsync(async local =>
    {
        attempt = CancellationTokenSource.CreateLinkedTokenSource(token); Render();
        if (provider == "google")
        {
            await local.SignInLocalAsync(MainActivity.Current).WaitAsync(attempt.Token);
            // A listed account (freeAccounts, store "free": Play's reviewer) is paid by its sign-in alone: no QR to wait for.
            if (local.PaidUntil() is { } listed) { paid = listed; notice = LocalFormText.PaidOk; return; }
        }
        request = await local.MakeRequestAsync(MainActivity.Current, provider, parentAppId: "dev.kitepon.bellbot").WaitAsync(attempt.Token); JoinLink.Takers.Add(taker = JoinLink.Taker(link => local.TakeAsync(link))); expiry = DateTimeOffset.Now.AddMinutes(BellTeam.Core.LocalForm.ListenMinutes); Render();
        paid = await request.AwaitPaidAsync().WaitAsync(attempt.Token); notice = LocalFormText.PaidOk;
    });

    private void Render()
    {
        Children.Clear();
        if (firstScreen && !Entitled && Local is not null) { RenderFirstScreen(); return; }
        RenderBody();
        if (firstScreen) { var items = Children.ToList(); Children.Clear(); var inner = new StackPanel(); inner.Children.AddRange(items); Children.Add(SettingsUi.Card(inner)); }
    }

    // The first screen while this phone is not yet approved: before sign-in the name, the one line and the Owner's sentence with the two ways in (and the purchase, which only a phone can make); once a request is open the screen that waits for the parent device.
    private void RenderFirstScreen()
    {
        if ((request?.Qr ?? (preview is { Length: > 0 } ? preview : null)) is { } qr) { Children.Add(QrScreen(qr, request?.Code ?? (preview is { Length: > 0 } ? "https://login-billing.kitepon.dev/join/dev.kitepon.bellbot#lbj1:render-only-sample-not-a-real-code" : null))); return; }   // preview: render scenes only
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
        if (busy && attempt is { } signing) { inner.Children.Add(Text(SignInText.Waiting, 13, Muted, null, new Thickness(0, 12, 0, 0))); var stop = Capsule(LocalFormText.Cancel, Fill, Ink, 12, 14, new Thickness(16, 10)); stop.HorizontalAlignment = HorizontalAlignment.Left; stop.Margin = new Thickness(0, 12, 0, 0); stop.Click += (_, _) => signing.Cancel(); inner.Children.Add(stop); }
        if (failure is not null) inner.Children.Add(Banner(failure));
        Children.Add(SettingsUi.Card(inner));
        if (PurchaseButton() is { } buy) Children.Add(buy);
    }

    // Only a phone can buy: the Play product, when it can be read (the same button as the settings card).
    private Button? PurchaseButton()
    {
        if (product is not { } offered) return null;
        var price = offered.Offers.FirstOrDefault()?.Phases.LastOrDefault(phase => phase.PriceMicros > 0);   // a free-trial phase comes first
        var buy = Button(price is not null ? StoreAccountText.Buy(price.FormattedPrice, price.BillingPeriod) : StoreAccountText.Buy(offered.OneTimePrice?.FormattedPrice ?? offered.Title),
            () => RunAsync(async local => await local.PurchaseAsync(MainActivity.Current, offered.ProductId, offered.Offers.FirstOrDefault()?.OfferToken)), Look.Secondary);
        buy.HorizontalAlignment = HorizontalAlignment.Stretch; buy.HorizontalContentAlignment = HorizontalAlignment.Center; return buy;
    }

    // The waiting screen: the title, the QR, how long it holds, the Owner's sentence, the way out (Approval Box 0.2.2's qr-screen; BellTeam has no 「この端末を親にする」).
    private Control QrScreen(string qr, string? joinCode = null)
    {
        var column = new StackPanel { Spacing = 6, Margin = new Thickness(0, 24, 0, 0) };
        column.Children.Add(Text(LocalFormText.WaitingTitle, 20, Ink, FontWeight.Bold));
        var code = new QrView(qr, 260) { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 6) }; Avalonia.Automation.AutomationProperties.SetName(code, LocalFormText.QrLabel);
        column.Children.Add(code);
        var waiting = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 4, 0, 0) };
        waiting.Children.Add(Glyph(SettingsIcons.Waiting, 16, Muted)); var wt = Text(LocalFormText.ValidUntil(request is null ? DateTimeOffset.Now.AddMinutes(BellTeam.Core.LocalForm.ListenMinutes) : expiry), 13, Muted); wt.VerticalAlignment = VerticalAlignment.Center; waiting.Children.Add(wt);
        column.Children.Add(waiting);
        column.Children.Add(Text(LocalFormText.Qr, 14, Ink, null, new Thickness(0, 6, 0, 0)));
        if (JoinCodeView.Create(joinCode, LocalFormText.CodeHint) is { } join) column.Children.Add(join);
        if (PurchaseButton() is { } buy) column.Children.Add(buy);
        var stop = Capsule(LocalFormText.Cancel, Fill, Ink, 12, 14, new Thickness(16, 10)); stop.HorizontalAlignment = HorizontalAlignment.Left; stop.Margin = new Thickness(0, 12, 0, 0); stop.Click += (_, _) => attempt?.Cancel();
        column.Children.Add(stop);
        return column;
    }

    private void RenderBody()
    {
        // Rapi's table (docs/apple-qr-approval-wording): the card title and the status line are the table's; the badge stays as on the Windows card (not in the table).
        var status = StoreAccount.Status(Entitled);
        var head = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto") };
        var tile = Tile(BellTeam.Linux.SettingsPage.Billing, 36); var title = Text(LocalFormText.CardTitle, 17, Ink, FontWeight.Bold, new Thickness(12, 0, 8, 0)); title.VerticalAlignment = VerticalAlignment.Center;
        var badge = Badge(status.Badge, status.Tone); Grid.SetColumn(title, 1); Grid.SetColumn(badge, 2); head.Children.Add(tile); head.Children.Add(title); head.Children.Add(badge);
        Children.Add(head);
        if (Local is null) { Children.Add(Text(StoreAccountText.NotConfigured, 14, Muted, null, new Thickness(0, 10, 0, 0))); RenderDelete(); return; }
        Children.Add(Text(owned ? LocalFormText.Status(null) : paid is { } now ? LocalFormText.Status(now.Until) : LocalFormText.StatusUnpaid, 14, Secondary, null, new Thickness(0, 10, 0, 0)));   // an own Play purchase: its end is Play's, not read here
        if (notice is not null && request is null) Children.Add(Text(notice, 14, Ink, FontWeight.SemiBold, new Thickness(0, 6, 0, 0)));

        if (owned) { Children.Add(approve ??= new ApprovePanel(token)); }   // one panel for the card's life: a rebuilt one lost the asking question and the result line
        else if (request is { } open) Children.Add(QrBlock(open.Qr, open.Code));
        else if (paid is not null) Children.Add(Button(StoreAccountText.SignOut, () => { Local?.SignOutLocal(); paid = null; EntitledChanged?.Invoke(); Render(); return Task.CompletedTask; }, Look.Secondary));
        else
        {
            if (product is not null)
            {
                var price = product.Offers.FirstOrDefault()?.Phases.LastOrDefault(phase => phase.PriceMicros > 0);   // a free-trial phase comes first
                Children.Add(Button(price is not null ? StoreAccountText.Buy(price.FormattedPrice, price.BillingPeriod) : StoreAccountText.Buy(product.OneTimePrice?.FormattedPrice ?? product.Title),
                    () => RunAsync(async local => await local.PurchaseAsync(MainActivity.Current, product.ProductId, product.Offers.FirstOrDefault()?.OfferToken)), Look.Primary));
            }
            Children.Add(Text(LocalFormText.Title, 16, Ink, FontWeight.Bold, new Thickness(0, 14, 0, 0)));
            Children.Add(Text(LocalFormText.Lead, 13, Muted, null, new Thickness(0, 6, 0, 0)));
            Children.Add(Text(LocalFormText.FirstSignIn, 13, Ink, null, new Thickness(0, 6, 0, 0)));
            Children.Add(Button(LocalFormText.Google, () => RequestAsync("google"), Look.Primary));
            Children.Add(Button(LocalFormText.Apple, () => RequestAsync("apple"), Look.Primary));
        }
        // Apple's sign-in runs in a browser tab that gives no signal when the person closes it: the library waits for the return, so this is the way out.
        if (busy && request is null && attempt is { } signing) { Children.Add(Text(StoreAccountText.SigningInWeb, 13, Muted, null, new Thickness(0, 12, 0, 0))); var stop = Capsule(LocalFormText.Cancel, Fill, Ink, 12, 14, new Thickness(16, 10)); stop.HorizontalAlignment = HorizontalAlignment.Left; stop.Margin = new Thickness(0, 12, 0, 0); stop.Click += (_, _) => signing.Cancel(); Children.Add(stop); }
        if (!owned && request is null) Children.Add(Button(StoreAccountText.Refresh, () => ReloadAsync(), Look.Secondary));
        RenderDelete();
        if (failure is not null) Children.Add(Banner(failure));
    }

    // The QR of one request: the paying phone reads it; this phone waits (10 minutes) and has one way out.
    private Control QrBlock(string qr, string? joinCode = null)
    {
        var block = new StackPanel { Margin = new Thickness(0, 14, 0, 0), Spacing = 6 };
        block.Children.Add(Text(LocalFormText.Title, 16, Ink, FontWeight.Bold));
        block.Children.Add(Text(LocalFormText.Lead, 13, Muted));
        var code = new QrView(qr, 260) { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 6) }; Avalonia.Automation.AutomationProperties.SetName(code, LocalFormText.QrLabel);
        block.Children.Add(code);
        // 1.49 (11.12): the library's own sentence, word for word, directly under the QR on every client.
        var guidance = Text(LocalFormText.Qr, 14, Ink); guidance.TextAlignment = TextAlignment.Center; block.Children.Add(guidance);
        if (JoinCodeView.Create(joinCode, LocalFormText.CodeHint) is { } join) block.Children.Add(join);
        var waiting = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 4, 0, 0) };
        waiting.Children.Add(Glyph(SettingsIcons.Waiting, 16, Muted)); var wt = Text(LocalFormText.WaitingUntil(expiry), 13, Muted); wt.VerticalAlignment = VerticalAlignment.Center; waiting.Children.Add(wt);
        block.Children.Add(waiting);
        var stop = Capsule(LocalFormText.Cancel, Fill, Ink, 12, 14, new Thickness(16, 10));
        stop.HorizontalAlignment = HorizontalAlignment.Left; stop.Margin = new Thickness(0, 12, 0, 0); stop.Click += (_, _) => attempt?.Cancel();
        block.Children.Add(stop);
        return new Border { Child = block, Background = SettingsUi.Canvas, CornerRadius = new CornerRadius(16), Padding = new Thickness(16), Margin = new Thickness(0, 12, 0, 0) };
    }

    // 「アカウントを削除」: the last item, under a divider (Rapi's Mac reference); only the subscription sentences name this platform's store.
    private static string Subscription  => AndroidStrings.AccountCard_Subscription_1;
        private static string Cancel  => AndroidStrings.AccountCard_Cancel_1;
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
