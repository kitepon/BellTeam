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
// A phone that holds the Play purchase is paid by its own store check and may let another device in (ApprovePanel). A phone without one shows the QR of a request; a paying phone on the same Wi-Fi answers it and this phone
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
    private string? failure;
    private bool busy, confirmingDelete;

    // The account gate (first run) waits for this: true while this phone's purchase or an accepted period holds.
    public bool Entitled => owned || paid is not null;
    public event Action? EntitledChanged;

    public AccountCard(CancellationToken token)
    {
        this.token = token; Spacing = 0;
        Render();
        _ = ReloadAsync();
        AccountStore.Foreground += OnForeground; token.Register(() => AccountStore.Foreground -= OnForeground);
    }

    private void OnForeground() => Dispatcher.UIThread.Post(() => { if (!busy) _ = ReloadAsync(); });

    // Every opening and every foreground: the kept reply against this device's clock, and Play's own list of this phone's purchases (an ended or refunded one is no longer owned).
    private async Task ReloadAsync()
    {
        if (Local is not { } local) { Render(); return; }
        var before = Entitled;
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
        if (before != Entitled) EntitledChanged?.Invoke();
        Render();
    }

    private async Task RunAsync(Func<Kitepon.LoginBilling.LocalForm, Task> action)
    {
        if (busy || Local is not { } local) return;
        busy = true; failure = null; Render();
        try { await action(local); }
        catch (OperationCanceledException) { }   // the person pressed やめる, or the screen closed
        catch (LoginBillingException error) { failure = LocalFormText.Failure(error.Code, error.Reason); }
        request?.Dispose(); request = null; attempt?.Dispose(); attempt = null; busy = false;
        if (!token.IsCancellationRequested) await ReloadAsync();
    }

    // One try: Google signs in on this phone (Apple is the paying iPhone's own sign-in), then the QR waits for the phone that holds the purchase; every failure ends the try with its sentence and the next step is a new QR.
    private Task RequestAsync(string provider) => RunAsync(async local =>
    {
        attempt = CancellationTokenSource.CreateLinkedTokenSource(token);
        if (provider == "google") await local.SignInLocalAsync(MainActivity.Current);
        request = await local.MakeRequestAsync(MainActivity.Current, provider); Render();
        paid = await request.AwaitPaidAsync().WaitAsync(attempt.Token);
    });

    private void Render()
    {
        Children.Clear();
        var status = StoreAccount.Status(Entitled);
        var head = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto") };
        var tile = Tile(BellTeam.Linux.SettingsPage.Billing, 36); var title = Text(StoreAccountText.Title, 17, Ink, FontWeight.Bold, new Thickness(12, 0, 8, 0)); title.VerticalAlignment = VerticalAlignment.Center;
        var badge = Badge(status.Badge, status.Tone);
        Grid.SetColumn(title, 1); Grid.SetColumn(badge, 2); head.Children.Add(tile); head.Children.Add(title); head.Children.Add(badge);
        Children.Add(head);
        if (Local is null) { Children.Add(Text(StoreAccountText.NotConfigured, 14, Muted, null, new Thickness(0, 10, 0, 0))); RenderDelete(); return; }
        Children.Add(Text(!owned && paid is { Until: { } until } ? LocalFormText.Paid(until) : status.Line, 14, Secondary, null, new Thickness(0, 10, 0, 0)));

        if (owned) { Children.Add(new ApprovePanel(token)); }
        else if (request is { } open) Children.Add(QrBlock(open.Qr));
        else if (paid is not null) Children.Add(Button(StoreAccountText.SignOut, () => { Local?.SignOutLocal(); paid = null; EntitledChanged?.Invoke(); Render(); return Task.CompletedTask; }, Look.Secondary));
        else
        {
            if (product is not null)
            {
                var price = product.Offers.FirstOrDefault()?.Phases.LastOrDefault(phase => phase.PriceMicros > 0);   // a free-trial phase comes first
                Children.Add(Button(price is not null ? StoreAccountText.Buy(price.FormattedPrice, price.BillingPeriod) : StoreAccountText.Buy(product.OneTimePrice?.FormattedPrice ?? product.Title),
                    () => RunAsync(async local => await local.PurchaseAsync(MainActivity.Current, product.ProductId, product.Offers.FirstOrDefault()?.OfferToken)), Look.Primary));
            }
            Children.Add(Text(LocalFormText.Lead, 13, Muted, null, new Thickness(0, 10, 0, 0)));
            Children.Add(Button(LocalFormText.Google, () => RequestAsync("google"), Look.Primary));
            Children.Add(Button(LocalFormText.Apple, () => RequestAsync("apple"), Look.Primary));
        }
        if (!owned && request is null) Children.Add(Button(StoreAccountText.Refresh, () => ReloadAsync(), Look.Secondary));
        RenderDelete();
        if (failure is not null) Children.Add(Banner(failure));
    }

    // The QR of one request: the paying phone reads it; this phone waits (10 minutes) and has one way out.
    private Control QrBlock(string qr)
    {
        var block = new StackPanel { Margin = new Thickness(0, 14, 0, 0), Spacing = 6 };
        block.Children.Add(Text(LocalFormText.Title, 16, Ink, FontWeight.Bold));
        block.Children.Add(Text(LocalFormText.Lead, 13, Muted));
        block.Children.Add(new QrView(qr, 220) { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 6) });
        block.Children.Add(Text(LocalFormText.Window, 12, Muted));
        var waiting = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 4, 0, 0) };
        waiting.Children.Add(Glyph(SettingsIcons.Waiting, 16, Muted)); var wt = Text(LocalFormText.Waiting, 13, Muted); wt.VerticalAlignment = VerticalAlignment.Center; waiting.Children.Add(wt);
        block.Children.Add(waiting);
        var stop = Capsule(LocalFormText.Cancel, Fill, Ink, 12, 14, new Thickness(16, 10));
        stop.HorizontalAlignment = HorizontalAlignment.Left; stop.Margin = new Thickness(0, 12, 0, 0); stop.Click += (_, _) => attempt?.Cancel();
        block.Children.Add(stop);
        return new Border { Child = block, Background = SettingsUi.Canvas, CornerRadius = new CornerRadius(16), Padding = new Thickness(16), Margin = new Thickness(0, 12, 0, 0) };
    }

    // 「アカウントを削除」: the last item, under a divider (Rapi's Mac reference); only the subscription sentences name this platform's store.
    private const string Subscription = "購読はGoogle Playのものなので、この操作では解約されません。解約はGoogle Playの「定期購入」から行ってください。", Cancel = "購読を止めるには、Google Playの定期購入の管理から解約してください。";
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

    private enum Look { Primary, Secondary, Danger, DangerFilled }

    private Button Button(string label, Func<Task> click, Look look)
    {
        var (background, foreground) = look switch
        {
            Look.Primary => ((IBrush)BellTheme.ProminentFill, (IBrush)Brushes.White),
            Look.DangerFilled => (Red, Brushes.White),
            Look.Danger => (Fill, Red),
            _ => (Fill, Ink),
        };
        var button = Capsule(label, background, foreground, 12, 14, new Thickness(16, 10));
        button.FontWeight = look == Look.Secondary ? FontWeight.Normal : FontWeight.SemiBold; button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 12, 0, 0); button.IsEnabled = !busy;
        button.Click += async (_, _) => await click();
        return button;
    }
}
