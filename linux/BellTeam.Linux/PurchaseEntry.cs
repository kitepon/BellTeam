using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Linux;

// The purchase entry on 利用と課金 (a337, the twin of windows PurchaseEntry): three equal store rows (docs/billing-client-contract.md); 購入 on the Stripe row opens the server's Stripe checkout in the browser, then 購入を確認 / 再確認 read the plan.
// The words and the "who is offered it" rules are Core's (SubscriptionText, SubscriptionApi), the same on Web, Windows and Linux.
public sealed class PurchaseEntry : StackPanel
{
    private readonly SubscriptionApi api;
    private readonly Action<string> open;
    private readonly CancellationToken token;
    private SubscriptionState? state;
    private StripeCheckout? checkout;
    private string? failure;
    private bool busy, nothingToBuy;

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

    private async Task StartAsync() => await RunAsync(async () =>
    {
        try { checkout = await api.CheckoutAsync(token); }
        catch (Exception error) when (SubscriptionApi.NothingToBuy(error)) { nothingToBuy = true; return; }
        // The URL comes from the server's answer: only an https page goes to the system browser.
        if (!Uri.TryCreate(checkout.Url, UriKind.Absolute, out var url) || url.Scheme != Uri.UriSchemeHttps) { failure = "購入画面のアドレスを読めませんでした。"; return; }
        try { open(url.AbsoluteUri); }
        catch (Exception error) { failure = "ページを開けませんでした。" + error.Message; }
    });
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
        if (Offering)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 2, 0, 0), Spacing = 8 };
            if (checkout is not null) row.Children.Add(ActionButton(SubscriptionText.Verify, VerifyAsync));
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
            if (Offering)
            {
                var start = Capsule(SubscriptionText.Start, Violet, Brushes.White, 8, 13, new Thickness(18, 8)); start.HorizontalAlignment = HorizontalAlignment.Left; start.IsEnabled = !busy; start.Click += async (_, _) => await StartAsync();
                body.Children.Add(start);
            }
        }
        else body.Children.Add(Text(SubscriptionText.Unavailable(store), 12, Muted));
        return new Border { Child = body, Background = Fill, CornerRadius = new CornerRadius(12), Padding = new Thickness(14), MinHeight = 96, Margin = new Thickness(0, 0, 0, 8) };
    }

    private Button ActionButton(string label, Func<Task> run)
    {
        var button = Capsule(label, Fill, Ink, 8, 13, new Thickness(12, 6)); button.IsEnabled = !busy; button.FontWeight = FontWeight.Normal;
        button.Click += async (_, _) => await run();
        return button;
    }
}
