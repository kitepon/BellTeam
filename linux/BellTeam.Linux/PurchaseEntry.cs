using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Linux;

// The purchase entry on 利用と課金 (a337, the twin of windows PurchaseEntry): three equal store rows (docs/billing-client-contract.md); 購入 on the Stripe row opens the server's Stripe checkout in the browser, then 購入を確認 / 再確認 read the plan.
// a460: 購入 shows the confirmation panel (特商法12条の6) inside the row; 申し込む alone calls the checkout.
// The words and the "who is offered it" rules are Core's (SubscriptionText, SubscriptionApi), the same on Web, Windows and Linux.
public sealed class PurchaseEntry : StackPanel
{
    private readonly SubscriptionApi api;
    private readonly Action<string> open;
    private readonly CancellationToken token;
    private SubscriptionState? state;
    private StripeCheckout? checkout;
    private string? failure;
    private bool busy, nothingToBuy, noStripe, confirming;

    // open is the browser (a test passes its own); a failure to open is shown, never swallowed.
    public PurchaseEntry(SubscriptionApi api, Action<string> open, CancellationToken token)
    {
        this.api = api; this.open = open; this.token = token;
        Margin = new Thickness(0, 14, 0, 0);
    }

    internal SubscriptionState? State => state;
    private bool ShowsRows => state is { AccessMode: not "developer" } && !nothingToBuy;
    internal bool Offering => SubscriptionApi.OffersPurchase(state) && !nothingToBuy;

    public Task LoadAsync() => RunAsync(async () => state = await api.GetAsync(token), failedText: "購読の状態を確認できませんでした。再確認してください。");

    // a460: 購入 only opens the confirmation panel; the server is asked for the Checkout page by 申し込む alone.
    private void Confirm(bool on) { confirming = on; Render(); }

    private async Task StartAsync() => await RunAsync(async () =>
    {
        confirming = false;
        try { checkout = await api.CheckoutAsync(token); }
        catch (Exception error) when (SubscriptionApi.NothingToBuy(error)) { nothingToBuy = true; return; }
        // a389: a store already bills this server, so no second purchase: show the server's words and read the status again.
        catch (Exception error) when (SubscriptionApi.AlreadyActive(error)) { failure = error.Message; state = await api.GetAsync(token); return; }
        Open(checkout.Url, "購入画面のアドレスを読めませんでした。");
    });

    // The address comes from the server's answer or the store's fixed page: only an https page goes to the system browser.
    private void Open(string address, string unreadable)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var url) || url.Scheme != Uri.UriSchemeHttps) { failure = unreadable; return; }
        try { open(url.AbsoluteUri); }
        catch (Exception error) { failure = "ページを開けませんでした。" + error.Message; }
    }

    // a389: Stripe's page comes from the server; the other stores open their own subscription page. The page is where the person cancels; 再確認 reads the result after they come back.
    private async Task ManageAsync(string store) => await RunAsync(async () =>
    {
        var address = SubscriptionText.ManageUrl(store);
        if (address is null)
        {
            try { address = (await api.ManageAsync(token)).Url; }
            catch (Exception error) when (SubscriptionApi.NoStripeSubscription(error)) { noStripe = true; return; }
        }
        Open(address, "管理画面のアドレスを読めませんでした。");
    });
    // A link in the panel: the system browser through the same https gate; a failure is shown on the row.
    private Button LinkButton(string label, string address)
    {
        var link = Capsule(label, Fill, Violet, 8, 12, new Thickness(10, 4)); link.HorizontalAlignment = HorizontalAlignment.Left; link.FontWeight = FontWeight.Normal;
        link.Click += (_, _) => { failure = null; Open(address, "ページのアドレスを読めませんでした。"); Render(); };
        return link;
    }

    private StackPanel ConfirmPanel()
    {
        var panel = new StackPanel { Spacing = 4 };
        panel.Children.Add(Text(SubscriptionText.ConfirmTitle, 13, Ink, FontWeight.SemiBold));
        foreach (var line in new[] { SubscriptionText.ConfirmPlan, SubscriptionText.ConfirmPrice, SubscriptionText.ConfirmPayment, SubscriptionText.ConfirmFirstCharge(DateTime.Today), SubscriptionText.ConfirmStart, SubscriptionText.ConfirmCancel, SubscriptionText.ConfirmRefund }) panel.Children.Add(Text(line, 12, Ink));
        panel.Children.Add(LinkButton(SubscriptionText.ConfirmLawLink, SubscriptionText.ConfirmLawUrl));
        panel.Children.Add(Text(SubscriptionText.ConfirmTerms, 12, Ink));
        var links = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        links.Children.Add(LinkButton(SubscriptionText.ConfirmTermsLink, SubscriptionText.ConfirmTermsUrl)); links.Children.Add(LinkButton(SubscriptionText.ConfirmAnnexLink, SubscriptionText.ConfirmAnnexUrl));
        panel.Children.Add(links);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 6, 0, 0) };
        var apply = Capsule(SubscriptionText.ConfirmApply, Violet, Brushes.White, 8, 13, new Thickness(18, 8)); apply.IsEnabled = !busy; apply.Click += async (_, _) => await StartAsync();
        buttons.Children.Add(apply); buttons.Children.Add(ActionButton(SubscriptionText.ConfirmBack, () => { Confirm(false); return Task.CompletedTask; }));
        panel.Children.Add(buttons);
        return panel;
    }

    private async Task VerifyAsync() => await RunAsync(async () => state = checkout is { } pending ? await api.VerifyAsync(pending.SessionId, token) : await api.RefreshAsync(token));
    private async Task RecheckAsync() => await RunAsync(async () => state = await api.RefreshAsync(token));

    // One request at a time; a failure is shown with the server's reason and nothing is retried (the Owner presses the button again).
    private async Task RunAsync(Func<Task> work, string? failedText = null)
    {
        if (busy) return;
        busy = true; failure = null; Render();
        try { await work(); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (Exception error) { failure = failedText is null ? error.Message : failedText + error.Message; }
        busy = false; Render();
    }

    private void Render()
    {
        Children.Clear();
        if (state is { } now) foreach (var line in SubscriptionText.StateLines(now)) Children.Add(Text(line, 13, Ink, null, new Thickness(0, 0, 0, 4)));
        if (ShowsRows) foreach (var store in SubscriptionText.Stores) Children.Add(StoreRow(store));
        if (Offering || state is { BillingSources.Length: > 0 })
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 2, 0, 0), Spacing = 8 };
            if (checkout is not null && Offering) row.Children.Add(ActionButton(SubscriptionText.Verify, VerifyAsync));
            row.Children.Add(ActionButton(SubscriptionText.Recheck, RecheckAsync));
            Children.Add(row);
        }
        else if (state is null && failure is not null) Children.Add(ActionButton(SubscriptionText.Recheck, LoadAsync));
        if (failure is not null) Children.Add(Banner(failure));
    }

    // One row per store, same height, font and spacing (contract rule 1); only the last line differs: the buy button, the active mark, or the "cannot buy here" line.
    private Border StoreRow(string store)
    {
        var body = new StackPanel();
        body.Children.Add(Text(store, 14, Ink, FontWeight.SemiBold));
        body.Children.Add(Text($"{SubscriptionText.Price}　{SubscriptionText.FreeMonth}", 12, Muted, null, new Thickness(0, 2, 0, 8)));
        if (state is { Entitled: true } && SubscriptionText.StoreOf(state.Source) == store) body.Children.Add(Text(SubscriptionText.Active(store), 13, Ink, FontWeight.SemiBold));
        else if (store == "Stripe")
        {
            // Stripe is the one source bought on this device; it carries no line while another store already holds the plan (no second purchase).
            if (Offering && confirming) body.Children.Add(ConfirmPanel());
            else if (Offering)
            {
                var start = Capsule(SubscriptionText.Start, Violet, Brushes.White, 8, 13, new Thickness(18, 8)); start.HorizontalAlignment = HorizontalAlignment.Left; start.IsEnabled = !busy; start.Click += (_, _) => Confirm(true);
                body.Children.Add(start);
            }
        }
        else body.Children.Add(Text(SubscriptionText.Unavailable(store), 12, Muted));
        if (state is { Entitled: true, AutoRenewing: false, ValidUntil: { } until } && SubscriptionText.StoreOf(state.Source) == store) body.Children.Add(Text(SubscriptionText.NotRenewingRow(until), 12, Muted, null, new Thickness(0, 6, 0, 0)));
        // One manage button on the row of every store that still bills this server (contract rule 8); Stripe's drops out when the server says it holds none.
        if (state is { } now && now.BillingSources.Contains(SubscriptionText.SourceOf(store)) && !(store == "Stripe" && noStripe))
        {
            var manage = Capsule(SubscriptionText.Manage, Fill, Ink, 8, 13, new Thickness(14, 8)); manage.HorizontalAlignment = HorizontalAlignment.Left; manage.IsEnabled = !busy; manage.FontWeight = FontWeight.Normal; manage.Margin = new Thickness(0, 8, 0, 0);
            manage.Click += async (_, _) => await ManageAsync(store);
            body.Children.Add(manage);
        }
        return new Border { Child = body, Background = Fill, CornerRadius = new CornerRadius(12), Padding = new Thickness(14), MinHeight = 96, Margin = new Thickness(0, 0, 0, 8) };
    }

    private Button ActionButton(string label, Func<Task> run)
    {
        var button = Capsule(label, Fill, Ink, 8, 13, new Thickness(12, 6)); button.IsEnabled = !busy; button.FontWeight = FontWeight.Normal;
        button.Click += async (_, _) => await run();
        return button;
    }
}
