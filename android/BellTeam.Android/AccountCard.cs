using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using BellTeam.Linux;
using Kitepon.LoginBilling;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Android;

// a485 (login-billing contract 1.20, part A on 0.9.0): the store account of this phone. Google sign-in, purchase, the receipt re-send, "stop all others" and sign-out go to the library;
// the pass never reaches this code (AuthorizedRequestAsync / CreateHttpHandler are the only ways to talk to the operator, and nothing here does). No e-mail or name exists anywhere.
// Part B (Apple on Android, the signed-device screens, the QR to receive and approve, the server proof) arrives with Purika's release (t4k) and Mint's wire (t3h); it has no placeholder here.
public sealed class AccountCard : StackPanel
{
    private readonly CancellationToken token;
    private LoginBilling? billing => AccountStore.Billing;
    private ProductInfo? product;
    private string? failure;
    private bool busy, handoffAsked;
    private LoginStart? handoff;
    private bool alreadyEntitled;

    public AccountCard(CancellationToken token)
    {
        this.token = token;
        Render();
        _ = LoadAsync();
    }

    // What Play knows of the one product, once signed in with a store pass; the purchase button shows its price.
    private async Task LoadAsync()
    {
        if (billing is { PassKind: PassKind.Signed }) { await HandoffAsync(billing); return; }
        if (billing is not { PassKind: PassKind.Store }) { handoffAsked = false; return; }
        try { product = (await billing.ProductDetailsAsync([AccountStore.ProductId], subscription: true)).FirstOrDefault(); }
        catch (LoginBillingException error) { failure = StoreAccountText.Failure(error.Code, error.Reason); }
        if (!token.IsCancellationRequested) Render();
    }

    // Contract 1.20 (Mint's ruling): only a web-signed device (PassKind.Signed) asks to be let in by a phone, and a device that is already entitled gets null and shows no QR.
    // A Store pass (native Google sign-in) never starts one: the library answers signed_in before any request, so this is not even asked.
    private async Task HandoffAsync(LoginBilling lb)
    {
        if (handoffAsked) return;
        handoffAsked = true;
        try
        {
            handoff = await lb.StartLoginAsync(); alreadyEntitled = handoff is null;
            if (!token.IsCancellationRequested) Render();
            if (handoff is null) return;
            await lb.WaitForPassAsync();
            handoff = null; alreadyEntitled = true;
        }
        catch (LoginBillingException error) { handoff = null; failure = StoreAccountText.Failure(error.Code, error.Reason); handoffAsked = false; }
        if (!token.IsCancellationRequested) Render();
    }

    private async Task RunAsync(Func<LoginBilling, Task> action)
    {
        if (busy || billing is null) return;
        busy = true; failure = null; Render();
        try { await action(billing); await LoadAsync(); }
        catch (LoginBillingException error) { failure = StoreAccountText.Failure(error.Code, error.Reason); }
        busy = false;
        if (!token.IsCancellationRequested) Render();
    }

    private void Render()
    {
        Children.Clear();
        Children.Add(Text(StoreAccountText.Title, 17, Ink, FontWeight.SemiBold));
        if (billing is not { } lb) { Children.Add(Text(StoreAccountText.NotConfigured, 14, Muted, null, new Thickness(0, 10, 0, 0))); return; }
        var state = StoreAccount.Of(lb.PassKind switch { PassKind.Store => "store", PassKind.Handoff => "handoff", PassKind.Signed => "signed", _ => "none" }, lb.Entitlements.Count);
        if (state == StoreAccountState.SignedOut)
        {
            Children.Add(Text(StoreAccountText.SignedOut, 14, Ink, null, new Thickness(0, 10, 0, 0)));
            Children.Add(Button(StoreAccountText.SignIn, () => RunAsync(async b => await b.SignInAsync(MainActivity.Current)), prominent: true));
        }
        else
        {
            Children.Add(Text(state is StoreAccountState.Handoff or StoreAccountState.Signed ? StoreAccountText.HandoffCannotBuy : StoreAccountText.SignedIn, 14, Ink, null, new Thickness(0, 10, 0, 0)));
            foreach (var entitlement in lb.Entitlements)
                if (SubscriptionText.StoreOf(entitlement.Store) is { } store) Children.Add(Text(SubscriptionText.Active(store), 14, Ink, FontWeight.SemiBold, new Thickness(0, 6, 0, 0)));
            // A purchase on this phone that belongs to another account is never shown as owned.
            if (lb.OtherAccountProducts.Count != 0) Children.Add(Text(StoreAccountText.OtherAccount, 13, Muted, null, new Thickness(0, 6, 0, 0)));
            if (state == StoreAccountState.SignedInNeedsPurchase && product is not null)
                Children.Add(Button(StoreAccountText.Buy(product.Offers.FirstOrDefault()?.Phases.FirstOrDefault()?.FormattedPrice ?? product.OneTimePrice?.FormattedPrice ?? product.Title),
                    () => RunAsync(async b => await b.PurchaseAsync(MainActivity.Current, product.ProductId, product.Offers.FirstOrDefault()?.OfferToken)), prominent: true));
            if (state == StoreAccountState.Signed) RenderHandoff();
            if (state != StoreAccountState.Signed) Children.Add(Button(StoreAccountText.Refresh, () => RunAsync(async b => await b.RefreshAsync())));
            if (state != StoreAccountState.SignedOut)
                Children.Add(Button(StoreAccountText.StopAllOthers, () => RunAsync(async b => await b.StopAllOthersAsync(MainActivity.Current))));
            Children.Add(Button(StoreAccountText.SignOut, () => RunAsync(b => b.SignOutAsync())));
        }
        if (failure is not null) Children.Add(Banner(failure));
    }

    // 7f: the handoff QR of a device with no store receipt, the sentences as written; the QR text is drawn as given, never wrapped in a link.
    private void RenderHandoff()
    {
        if (alreadyEntitled) { Children.Add(Text(StoreAccountText.AlreadyEntitled, 14, Ink, FontWeight.SemiBold, new Thickness(0, 10, 0, 0))); return; }
        if (handoff is not { } login) return;
        Children.Add(Text(StoreAccountText.HandoffTitle, 15, Ink, FontWeight.SemiBold, new Thickness(0, 14, 0, 0)));
        Children.Add(Text(StoreAccountText.HandoffLead, 13, Muted, null, new Thickness(0, 6, 0, 8)));
        var qr = new QrView(login.QrPayload, 220) { HorizontalAlignment = HorizontalAlignment.Left }; Children.Add(qr);
        Children.Add(Text(StoreAccountText.HandoffCode + "　" + login.ShortCode, 17, Ink, FontWeight.SemiBold, new Thickness(0, 10, 0, 0)));
        Children.Add(Text(StoreAccountText.HandoffCheckNumber + "　" + login.CheckNumber, 17, Ink, FontWeight.SemiBold, new Thickness(0, 4, 0, 0)));
        Children.Add(Text(StoreAccountText.HandoffCheckLine, 13, Muted, null, new Thickness(0, 6, 0, 0)));
        Children.Add(Text(StoreAccountText.HandoffWaiting, 13, Muted, null, new Thickness(0, 6, 0, 0)));
    }

    private Button Button(string label, Func<Task> click, bool prominent = false)
    {
        var button = Capsule(label, prominent ? BellTheme.ProminentFill : Fill, prominent ? Brushes.White : Ink, 8, 13, new Thickness(14, 8)); button.FontWeight = FontWeight.Normal; button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 10, 0, 0); button.IsEnabled = !busy;
        button.Click += async (_, _) => await click();
        return button;
    }
}
