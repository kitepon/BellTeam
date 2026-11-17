using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Linux;

// The purchase entry on 利用と課金 (a337, the twin of windows PurchaseEntry): 月額購読を開始 opens the server's Stripe checkout in the browser, then 購入を確認 / 再確認 read the plan.
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
        if (Offering)
        {
            var start = Capsule(SubscriptionText.Start, Violet, Brushes.White, 8, 13, new Thickness(18, 8)); start.HorizontalAlignment = HorizontalAlignment.Left; start.IsEnabled = !busy; start.Click += async (_, _) => await StartAsync();
            Children.Add(start);
            Children.Add(Text(SubscriptionText.Caption, 12, Muted, null, new Thickness(0, 6, 0, 0)));
            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 0), Spacing = 8 };
            if (checkout is not null) row.Children.Add(ActionButton(SubscriptionText.Verify, VerifyAsync));
            row.Children.Add(ActionButton(SubscriptionText.Recheck, RecheckAsync));
            Children.Add(row);
        }
        else if (state is null && failure is not null) Children.Add(ActionButton(SubscriptionText.Recheck, LoadAsync));
        if (failure is not null) Children.Add(Banner(failure));
    }

    private Button ActionButton(string label, Func<Task> run)
    {
        var button = Capsule(label, Fill, Ink, 8, 13, new Thickness(12, 6)); button.IsEnabled = !busy; button.FontWeight = FontWeight.Normal;
        button.Click += async (_, _) => await run();
        return button;
    }
}
