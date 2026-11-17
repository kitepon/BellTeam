using Android.App;
using Android.BillingClient.Api;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using BellTeam.Linux;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Android;

// The purchase rows on 利用と課金 (a350; docs/billing-client-contract.md): Google Play first, then App Store and Stripe, three equal rows. Only the Google Play row is bought on this device:
// 購入 opens the Play sheet, 購入を復元 reads what the account already owns; each purchase token goes to the server (POST /api/subscription/google/verify) and Play is told the purchase is acknowledged only after the server says entitled.
public sealed class PurchaseEntry : StackPanel
{
    public static readonly string[] Stores = ["Google Play", "App Store", "Stripe"];
    private readonly BellApi api;
    private readonly SubscriptionApi subscription;
    private readonly PlayBilling billing;
    private readonly Func<Activity> activity;
    private readonly CancellationToken token;
    private readonly string productId;
    private SubscriptionState? state;
    private string? failure;
    private bool busy;

    public PurchaseEntry(BellApi api, PlayBilling billing, Func<Activity> activity, CancellationToken token)
    {
        this.api = api; subscription = new SubscriptionApi(api); this.billing = billing; this.activity = activity; this.token = token;
        using (var product = System.Text.Json.JsonDocument.Parse(EmbeddedAsset.Text("product.json"))) productId = product.RootElement.GetProperty("productId").GetString() ?? throw new InvalidOperationException("product.json に productId がありません。");
        Margin = new Thickness(0, 14, 0, 0);
    }

    internal bool ShowsRows => state is { AccessMode: not "developer" };
    internal bool Offering => SubscriptionApi.OffersPurchase(state);

    public Task LoadAsync() => RunAsync(async () => state = await subscription.GetAsync(token), "購読の状態を確認できませんでした。再確認してください。");

    // GET /api/subscription, then (while no plan is active) what Play says the account owns, so a purchase made before the server could check it is picked up.
    private Task BuyAsync() => RunAsync(async () => await VerifyAllAsync(await billing.BuyAsync(activity(), productId)));
    private Task RestoreAsync() => RunAsync(async () => await VerifyAllAsync(await billing.OwnedAsync()));
    private Task RecheckAsync() => RunAsync(async () => state = await subscription.RefreshAsync(token));

    private async Task VerifyAllAsync(IReadOnlyList<Purchase> purchases)
    {
        foreach (var purchase in purchases.Where(item => item.PurchaseState == PurchaseState.Purchased))
        {
            try { state = (await api.PostAsync<SubscriptionResponse>("/api/subscription/google/verify", new { purchaseToken = purchase.PurchaseToken, productId }, token)).Subscription; }
            catch (BellApiException error) when (error.Status == System.Net.HttpStatusCode.NotFound) { throw new InvalidOperationException("このサーバーはGoogle Playの購読にまだ対応していません。サーバーを更新してからもう一度お試しください。"); }
            if (state is { Entitled: true }) await billing.AcknowledgeAsync(purchase);
        }
    }

    // One request at a time; a failure is shown with its reason and nothing is retried (the person presses the button again).
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
        if (ShowsRows) foreach (var store in Stores) Children.Add(StoreRow(store));
        if (Offering)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 2, 0, 0), Spacing = 8 };
            row.Children.Add(ActionButton(SubscriptionText.Recheck, RecheckAsync));
            Children.Add(row);
        }
        else if (state is null && failure is not null) Children.Add(ActionButton(SubscriptionText.Recheck, LoadAsync));
        if (failure is not null) Children.Add(Banner(failure));
    }

    // Same height, font and spacing on every row; only the last line differs: the buy buttons, the active mark, or the "cannot buy here" line.
    private Border StoreRow(string store)
    {
        var body = new StackPanel();
        body.Children.Add(Text(store, 14, Ink, FontWeight.SemiBold));
        body.Children.Add(Text($"{SubscriptionText.Price}　{SubscriptionText.FreeMonth}", 12, Muted, null, new Thickness(0, 2, 0, 8)));
        if (state is { Entitled: true } && SubscriptionText.StoreOf(state.Source) == store) body.Children.Add(Text(SubscriptionText.Active(store), 13, Ink, FontWeight.SemiBold));
        else if (store == Stores[0])
        {
            // Google Play is the one source bought on this device; it carries no button while another store already holds the plan (no second purchase).
            if (Offering)
            {
                var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
                var buy = Capsule(SubscriptionText.Start, Violet, Brushes.White, 8, 13, new Thickness(18, 8)); buy.IsEnabled = !busy; buy.Click += async (_, _) => await BuyAsync();
                var restore = Capsule("購入を復元", Fill, Ink, 8, 13, new Thickness(14, 8)); restore.IsEnabled = !busy; restore.FontWeight = FontWeight.Normal; restore.Click += async (_, _) => await RestoreAsync();
                buttons.Children.Add(buy); buttons.Children.Add(restore); body.Children.Add(buttons);
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
