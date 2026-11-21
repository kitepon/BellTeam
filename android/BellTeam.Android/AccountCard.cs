using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using BellTeam.Linux;
using Kitepon.LoginBilling;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Android;

// a485 (login-billing contract 1.20): the account and subscription of this phone, laid out like the Mac 利用と課金 page (icon tile, title and one badge; the state sentence; the actions).
// Google sign-in, purchase, the receipt re-send, "stop all others" and sign-out go to the library; the pass never reaches this code. No e-mail or name exists anywhere.
// Only what applies is shown: a web-signed device (PassKind.Signed) asks to be let in by a phone unless the server says it already has a contract (Mint's ruling B).
public sealed class AccountCard : StackPanel
{
    private readonly CancellationToken token;
    private LoginBilling? billing => AccountStore.Billing;
    private ProductInfo? product;
    private string? failure;
    private bool busy, handoffAsked, handoffCancelled, confirmingStop;
    private bool? serverEntitled;   // CheckAsync's answer for a web-signed device (the stored entitlements can be stale)
    private LoginStart? handoff;
    private int epoch;

    public AccountCard(CancellationToken token)
    {
        this.token = token; Spacing = 0;
        Render();
        _ = LoadAsync();
    }

    private async Task LoadAsync()
    {
        if (billing is { PassKind: PassKind.Signed }) { await HandoffAsync(billing); return; }
        if (billing is not { PassKind: PassKind.Store }) { handoffAsked = false; return; }
        try { product = (await billing.ProductDetailsAsync([AccountStore.ProductId], subscription: true)).FirstOrDefault(); }
        catch (LoginBillingException error) { failure = StoreAccountText.Failure(error.Code, error.Reason); }
        if (!token.IsCancellationRequested) Render();
    }

    // Contract 1.20: ask the server first; a device that already has a contract shows no QR. Only a web-signed device starts a QR login (a Store pass answers signed_in before any request).
    private async Task HandoffAsync(LoginBilling lb)
    {
        if (handoffAsked) return;
        handoffAsked = true; handoffCancelled = false; var mine = ++epoch;
        try
        {
            serverEntitled = (await lb.CheckAsync()).Entitlements.Count != 0;
            if (serverEntitled == true) { if (!token.IsCancellationRequested) Render(); return; }
            handoff = await lb.StartLoginAsync(); serverEntitled = handoff is null;
            if (!token.IsCancellationRequested) Render();
            if (handoff is null) return;
            await lb.WaitForPassAsync();
            if (mine != epoch) return;   // the person pressed やめる
            handoff = null; serverEntitled = true;
        }
        catch (LoginBillingException error) { if (mine != epoch) return; handoff = null; failure = StoreAccountText.Failure(error.Code, error.Reason); handoffAsked = false; }
        if (!token.IsCancellationRequested) Render();
    }

    private async Task RunAsync(Func<LoginBilling, Task> action)
    {
        if (busy || billing is null) return;
        busy = true; failure = null; Render();
        try { await action(billing); handoffAsked = false; serverEntitled = null; await LoadAsync(); }
        catch (LoginBillingException error) { failure = StoreAccountText.Failure(error.Code, error.Reason); }
        busy = false;
        if (!token.IsCancellationRequested) Render();
    }

    private void Render()
    {
        Children.Clear();
        var lb = billing;
        var state = lb is null ? StoreAccountState.SignedOut : StoreAccount.Of(lb.PassKind switch { PassKind.Store => "store", PassKind.Handoff => "handoff", PassKind.Signed => "signed", _ => "none" }, lb.Entitlements.Count);
        var entitled = lb is not null && state != StoreAccountState.SignedOut && (state == StoreAccountState.Signed ? serverEntitled ?? lb.Entitlements.Count != 0 : lb.Entitlements.Count != 0);
        var status = StoreAccount.Status(entitled);

        // Head: tile, title, the one badge; then the state sentence (the Mac page head).
        var head = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto") };
        var tile = Tile(BellTeam.Linux.SettingsPage.Billing, 36); var title = Text(StoreAccountText.Title, 17, Ink, FontWeight.Bold, new Thickness(12, 0, 8, 0)); title.VerticalAlignment = VerticalAlignment.Center;
        var badge = Badge(status.Badge, status.Tone);
        Grid.SetColumn(title, 1); Grid.SetColumn(badge, 2); head.Children.Add(tile); head.Children.Add(title); head.Children.Add(badge);
        Children.Add(head);
        if (lb is null) { Children.Add(Text(StoreAccountText.NotConfigured, 14, Muted, null, new Thickness(0, 10, 0, 0))); return; }
        Children.Add(Text(state == StoreAccountState.SignedOut ? StoreAccountText.SignedOut : status.Line, 14, Secondary, null, new Thickness(0, 10, 0, 0)));

        if (state != StoreAccountState.SignedOut) Children.Add(AccountRow(state));
        if (state == StoreAccountState.SignedOut)
            Children.Add(Button(StoreAccountText.SignIn, () => RunAsync(async b => await b.SignInAsync(MainActivity.Current)), Look.Primary));
        else
        {
            foreach (var entitlement in lb.Entitlements)
                if (entitled && SubscriptionText.StoreOf(entitlement.Store) is { } store) Children.Add(Text(SubscriptionText.Active(store), 14, Ink, FontWeight.SemiBold, new Thickness(0, 10, 0, 0)));
            // A purchase on this phone that belongs to another account is never shown as owned.
            if (lb.OtherAccountProducts.Count != 0) Children.Add(Text(StoreAccountText.OtherAccount, 13, Muted, null, new Thickness(0, 10, 0, 0)));
            if (state == StoreAccountState.SignedInNeedsPurchase && product is not null)
                Children.Add(Button(StoreAccountText.Buy(product.Offers.FirstOrDefault()?.Phases.FirstOrDefault()?.FormattedPrice ?? product.OneTimePrice?.FormattedPrice ?? product.Title),
                    () => RunAsync(async b => await b.PurchaseAsync(MainActivity.Current, product.ProductId, product.Offers.FirstOrDefault()?.OfferToken)), Look.Primary));
            if (state == StoreAccountState.Signed) RenderSigned(entitled);
            if (state is StoreAccountState.SignedInNeedsPurchase or StoreAccountState.SignedInEntitled) Children.Add(Button(StoreAccountText.Refresh, () => RunAsync(async b => await b.RefreshAsync()), Look.Secondary));
            Children.Add(Button(StoreAccountText.SignOut, () => RunAsync(b => b.SignOutAsync()), Look.Secondary));
            RenderDanger();
        }
        if (failure is not null) Children.Add(Banner(failure));
    }

    // Who is signed in: the provider mark and one label (never an e-mail or a name; the library has none).
    private Control AccountRow(StoreAccountState state)
    {
        var web = state == StoreAccountState.Signed;
        Control mark = web ? Glyph(SettingsIcons.Globe, 18, Secondary)
            : new Border { Width = 20, Height = 20, CornerRadius = new CornerRadius(10), Background = Fill, Child = Text("G", 12, Ink, FontWeight.Bold) };
        if (mark is Border b) ((TextBlock)b.Child!).HorizontalAlignment = HorizontalAlignment.Center;
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 10, 0, 0) };
        row.Children.Add(mark);
        var label = Text(web ? StoreAccountText.SignedInBrowser : StoreAccountText.SignedIn, 14, Ink); label.VerticalAlignment = VerticalAlignment.Center; row.Children.Add(label);
        return row;
    }

    // A web-signed device never buys here: entitled shows the short summary; otherwise say why and show the QR with one way out.
    private void RenderSigned(bool entitled)
    {
        if (entitled) { Children.Add(Text(StoreAccountText.AlreadyEntitled, 14, Ink, FontWeight.SemiBold, new Thickness(0, 10, 0, 0))); return; }
        Children.Add(Text(StoreAccountText.WebCannotBuy, 13, Muted, null, new Thickness(0, 10, 0, 0)));
        if (handoff is { } login)
        {
            var block = new StackPanel { Margin = new Thickness(0, 14, 0, 0), Spacing = 6 };
            block.Children.Add(Text(StoreAccountText.HandoffTitle, 16, Ink, FontWeight.Bold));
            block.Children.Add(Text(StoreAccountText.HandoffLead, 13, Muted));
            var qr = new QrView(login.QrPayload, 220) { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 6) }; block.Children.Add(qr);
            var pair = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*") };
            var code = Pair(StoreAccountText.HandoffCode, login.ShortCode); var check = Pair(StoreAccountText.HandoffCheckNumber, login.CheckNumber); Grid.SetColumn(check, 1);
            pair.Children.Add(code); pair.Children.Add(check); block.Children.Add(pair);
            block.Children.Add(Text(StoreAccountText.HandoffCheckLine, 12, Muted));
            var waiting = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 4, 0, 0) };
            waiting.Children.Add(Glyph(SettingsIcons.Waiting, 16, Muted)); var wt = Text(StoreAccountText.HandoffWaiting, 13, Muted); wt.VerticalAlignment = VerticalAlignment.Center; waiting.Children.Add(wt);
            block.Children.Add(waiting);
            block.Children.Add(Button(StoreAccountText.HandoffCancel, () => { epoch++; handoff = null; handoffCancelled = true; Render(); return Task.CompletedTask; }, Look.Secondary));
            Children.Add(new Border { Child = block, Background = SettingsUi.Canvas, CornerRadius = new CornerRadius(16), Padding = new Thickness(16), Margin = new Thickness(0, 12, 0, 0) });
        }
        else if (handoffCancelled)
        {
            Children.Add(Text(StoreAccountText.HandoffCancelled, 13, Muted, null, new Thickness(0, 10, 0, 0)));
            Children.Add(Button(StoreAccountText.HandoffTitle, () => { handoffAsked = false; _ = HandoffAsync(billing!); return Task.CompletedTask; }, Look.Primary));
        }
    }

    private static Control Pair(string label, string value)
    {
        var p = new StackPanel { Spacing = 2 };
        p.Children.Add(Text(label, 12, Muted)); p.Children.Add(Text(value, 20, Ink, FontWeight.Bold)); return p;
    }

    // "Stop all others" is destructive: below sign-out, set apart, danger-coloured, with a short reason and a confirm step.
    private void RenderDanger()
    {
        Children.Add(new Border { Height = 1, Background = Hairline, Margin = new Thickness(0, 16, 0, 4) });
        if (!confirmingStop) { Children.Add(Button(StoreAccountText.StopAllOthers, () => { confirmingStop = true; Render(); return Task.CompletedTask; }, Look.Danger)); return; }
        Children.Add(Text(StoreAccountText.StopAllOthersWhy, 13, Muted, null, new Thickness(0, 8, 0, 0)));
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        row.Children.Add(Button(StoreAccountText.StopAllOthersConfirm, () => { confirmingStop = false; return RunAsync(async b => await b.StopAllOthersAsync(MainActivity.Current)); }, Look.DangerFilled));
        row.Children.Add(Button(StoreAccountText.HandoffCancel, () => { confirmingStop = false; Render(); return Task.CompletedTask; }, Look.Secondary));
        Children.Add(row);
    }

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
