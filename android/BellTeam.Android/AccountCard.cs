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
    private bool? serverEntitled;   // CheckAsync's answer (the stored entitlements are empty after a restart and can be stale after the operator's state changed)
    private IReadOnlyList<Entitlement>? checkedEntitlements;
    private LoginStart? handoff;
    private int epoch;

    // The account gate (first run) waits for this: true once the pass has a contract.
    public bool Entitled { get; private set; }
    public event Action? EntitledChanged;

    public AccountCard(CancellationToken token)
    {
        this.token = token; Spacing = 0;
        Render();
        _ = LoadAsync();
    }

    private async Task LoadAsync()
    {
        if (billing is { PassKind: not PassKind.None } signedIn)
        {
            try { var check = await signedIn.CheckAsync(); serverEntitled = check.Entitlements.Count != 0; checkedEntitlements = check.Entitlements; }
            catch (LoginBillingException error) { failure = StoreAccountText.Failure(error.Code, error.Reason); }
            if (!token.IsCancellationRequested) Render();
        }
        if (billing is { PassKind: PassKind.Signed }) { await HandoffAsync(billing); return; }
        if (billing is not { PassKind: PassKind.Store }) { handoffAsked = false; return; }
#if DEBUG
        if (DevOperator.Url is not null) return;   // a dev operator has no Play: the product lookup would only answer billing_unavailable and hide the action's own result
#endif
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
            serverEntitled = (await lb.CheckAsync()).Entitlements.Count != 0;   // asked again here: the person may have waited on the QR for minutes
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
        var held = serverEntitled is { } asked ? (asked ? 1 : 0) : lb?.Entitlements.Count ?? 0;
        var state = lb is null ? StoreAccountState.SignedOut : StoreAccount.Of(lb.PassKind switch { PassKind.Store => "store", PassKind.Handoff => "handoff", PassKind.Signed => "signed", _ => "none" }, held);
        var entitled = lb is not null && state != StoreAccountState.SignedOut && held != 0;
        var status = StoreAccount.Status(entitled);
        if (Entitled != entitled) { Entitled = entitled; EntitledChanged?.Invoke(); }

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
        {
#if DEBUG
            if (DevOperator.Url is not null)   // dev operator run (contract 1.25): the id token comes from the operator's own process
            {
                Children.Add(Button(StoreAccountText.SignIn, () => RunAsync(async b => await b.SignInForTestingAsync("google", DevOperator.IdToken("google"))), Look.Primary));
                Children.Add(Button(StoreAccountText.SignInApple, () => RunAsync(async b => await b.SignInForTestingAsync("apple", DevOperator.IdToken("apple"))), Look.Primary));
            }
            else
#endif
            {
            Children.Add(Button(StoreAccountText.SignIn, () => RunAsync(async b => await b.SignInAsync(MainActivity.Current)), Look.Primary));
            Children.Add(Button(StoreAccountText.SignInApple, () => RunAsync(async b => await b.SignInWebAsync(MainActivity.Current, "apple")), Look.Primary));
            }
        }
        else
        {
            foreach (var entitlement in checkedEntitlements ?? lb.Entitlements)
                if (entitled && SubscriptionText.StoreOf(entitlement.Store) is { } store) Children.Add(Text(SubscriptionText.Active(store), 14, Ink, FontWeight.SemiBold, new Thickness(0, 10, 0, 0)));
            // A purchase on this phone that belongs to another account is never shown as owned.
            if (lb.OtherAccountProducts.Count != 0) Children.Add(Text(StoreAccountText.OtherAccount, 13, Muted, null, new Thickness(0, 10, 0, 0)));
            if (state == StoreAccountState.SignedInNeedsPurchase && product is not null)
            {
                var paid = product.Offers.FirstOrDefault()?.Phases.LastOrDefault(phase => phase.PriceMicros > 0);   // a free-trial phase comes first
                Children.Add(Button(paid is not null ? StoreAccountText.Buy(paid.FormattedPrice, paid.BillingPeriod) : StoreAccountText.Buy(product.OneTimePrice?.FormattedPrice ?? product.Title),
                    () => RunAsync(async b => await b.PurchaseAsync(MainActivity.Current, product.ProductId, product.Offers.FirstOrDefault()?.OfferToken)), Look.Primary));
            }
            if (state == StoreAccountState.Signed) RenderSigned(entitled);
            if (state is StoreAccountState.SignedInNeedsPurchase or StoreAccountState.SignedInEntitled) Children.Add(Button(StoreAccountText.Refresh, () => RunAsync(async b => await b.RefreshAsync()), Look.Secondary));
            Children.Add(Button(StoreAccountText.SignOut, () => RunAsync(async b => { if (AccountStore.Home is { } home) await home.EndAsync(token); await b.SignOutAsync(); }), Look.Secondary));   // the library's signOut does not end the home session
            if (lb.PassKind == PassKind.Store) Children.Add(new ApprovePanel(lb, token));   // only a store pass may approve and list (the library keeps the list on the store device only)
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
            Children.Add(AccountParts.HandoffBlock(login.QrPayload, login.ShortCode, login.CheckNumber, () => { epoch++; handoff = null; handoffCancelled = true; Render(); }));
        }
        else if (handoffCancelled)
        {
            Children.Add(Text(StoreAccountText.HandoffCancelled, 13, Muted, null, new Thickness(0, 10, 0, 0)));
            Children.Add(Button(StoreAccountText.HandoffAgain, () => { handoffAsked = false; _ = HandoffAsync(billing!); return Task.CompletedTask; }, Look.Primary));
        }
    }

    // "Stop all others" is destructive: below sign-out, set apart, danger-coloured, with a short reason and a confirm step.
    private void RenderDanger()
    {
        Children.Add(new Border { Height = 1, Background = Hairline, Margin = new Thickness(0, 16, 0, 4) });
        if (!confirmingStop) { Children.Add(Button(StoreAccountText.StopAllOthers, () => { confirmingStop = true; Render(); return Task.CompletedTask; }, Look.Danger)); return; }
        var web = billing?.PassKind == PassKind.Signed;   // a web-signed device stops the others by signing in again with the provider it used (the library does not say which)
        Children.Add(Text(web ? StoreAccountText.StopAllOthersWhyWeb : StoreAccountText.StopAllOthersWhy, 13, Muted, null, new Thickness(0, 8, 0, 0)));
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        if (web)
        {
            row.Children.Add(Button(StoreAccountText.StopAllOthersGoogle, () => { confirmingStop = false; return RunAsync(async b => await b.SignInWebAsync(MainActivity.Current, "google", stopOthers: true)); }, Look.DangerFilled));
            row.Children.Add(Button(StoreAccountText.StopAllOthersApple, () => { confirmingStop = false; return RunAsync(async b => await b.SignInWebAsync(MainActivity.Current, "apple", stopOthers: true)); }, Look.DangerFilled));
        }
        else row.Children.Add(Button(StoreAccountText.StopAllOthersConfirm, () => { confirmingStop = false; return RunAsync(async b => await b.StopAllOthersAsync(MainActivity.Current)); }, Look.DangerFilled));
        row.Children.Add(Button(StoreAccountText.StopAllOthersCancel, () => { confirmingStop = false; Render(); return Task.CompletedTask; }, Look.Secondary));
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
