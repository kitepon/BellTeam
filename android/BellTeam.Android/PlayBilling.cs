using Android.App;
using Android.BillingClient.Api;

namespace BellTeam.Android;

// Google Play Billing for the one monthly subscription (docs/billing-client-contract.md, Bready's a157 contract): buy it, list what the account owns, acknowledge a purchase.
// Nothing here talks to the BellTeam server; the shell sends the purchase token to POST /api/subscription/google/verify and acknowledges only after the server says entitled.
public sealed class PlayBilling : Java.Lang.Object, IPurchasesUpdatedListener
{
    private readonly BillingClient client;
    private TaskCompletionSource<IReadOnlyList<Purchase>>? buying;
    public PlayBilling(Activity activity)
    {
        client = BillingClient.NewBuilder(activity).SetListener(this).EnablePendingPurchases(PendingPurchasesParams.NewBuilder().EnableOneTimeProducts().Build()).Build();
    }

    // A failure is returned as an exception with Play's own message; nothing is retried here (the person presses the button again).
    private async Task ConnectAsync()
    {
        if (client.IsReady) return;
        var done = new TaskCompletionSource();
        client.StartConnection(new Setup(done));
        await done.Task;
    }

    public async Task<IReadOnlyList<Purchase>> OwnedAsync()
    {
        await ConnectAsync();
        var found = await client.QueryPurchasesAsync(QueryPurchasesParams.NewBuilder().SetProductType(BillingClient.ProductType.Subs).Build());
        return Check(found.Result, "Google Playの購入を読めませんでした。") ? found.Purchases.ToArray() : [];
    }

    // The Play purchase sheet. Completes with the purchases Play reports (empty when the person cancelled).
    public async Task<IReadOnlyList<Purchase>> BuyAsync(Activity activity, string productId)
    {
        await ConnectAsync();
        var product = QueryProductDetailsParams.Product.NewBuilder().SetProductId(productId).SetProductType(BillingClient.ProductType.Subs).Build();
        var found = await client.QueryProductDetailsAsync(QueryProductDetailsParams.NewBuilder().SetProductList([product]).Build());
        Check(found.Result, "Google Playの商品を読めませんでした。");
        global::Android.Util.Log.Info("BellTeamBilling", $"product query {productId}: code={found.Result.ResponseCode} message={found.Result.DebugMessage} found={found.ProductDetailsList?.Count} unfetched=[{string.Join(", ", found.UnfetchedProductList?.Select(item => $"{item.ProductId}:{item.StatusCodeValue}") ?? [])}]");
        // The list is null (seen on 0.1.6: ArgumentNullException "source") when Play returns no product details for this account.
        var detail = found.ProductDetailsList?.FirstOrDefault() ?? throw new InvalidOperationException($"Google Playに購読「{productId}」が登録されていません。");
        var offer = detail.GetSubscriptionOfferDetails()?.FirstOrDefault() ?? throw new InvalidOperationException("Google Playに購読の料金プランがありません。");
        var item = BillingFlowParams.ProductDetailsParams.NewBuilder().SetProductDetails(detail).SetOfferToken(offer.OfferToken).Build();
        buying = new();
        var result = client.LaunchBillingFlow(activity, BillingFlowParams.NewBuilder().SetProductDetailsParamsList([item]).Build());
        if (result.ResponseCode != BillingResponseCode.Ok) { buying = null; throw new InvalidOperationException(result.DebugMessage is { Length: > 0 } text ? text : "Google Playの購入画面を開けませんでした。"); }
        return await buying.Task;
    }

    public Task AcknowledgeAsync(Purchase purchase)
    {
        if (purchase.IsAcknowledged) return Task.CompletedTask;
        var done = new TaskCompletionSource();
        client.AcknowledgePurchase(AcknowledgePurchaseParams.NewBuilder().SetPurchaseToken(purchase.PurchaseToken).Build(), new Acknowledged(done));
        return done.Task;
    }

    // Play's own message is shown; an Ok answer passes, anything else ends the operation with that message.
    private static bool Check(BillingResult result, string fallback) => result.ResponseCode == BillingResponseCode.Ok ? true : throw new InvalidOperationException(result.DebugMessage is { Length: > 0 } text ? text : fallback);

    public void OnPurchasesUpdated(BillingResult result, IList<Purchase>? purchases)
    {
        var waiting = buying; buying = null;
        if (result.ResponseCode == BillingResponseCode.Ok) waiting?.TrySetResult(purchases?.ToArray() ?? []);
        else if (result.ResponseCode == BillingResponseCode.UserCancelled) waiting?.TrySetResult([]);
        else waiting?.TrySetException(new InvalidOperationException(result.DebugMessage is { Length: > 0 } text ? text : "Google Playの購入に失敗しました。"));
    }

    private sealed class Setup(TaskCompletionSource done) : Java.Lang.Object, IBillingClientStateListener
    {
        public void OnBillingServiceDisconnected() { }
        public void OnBillingSetupFinished(BillingResult result)
        {
            if (result.ResponseCode == BillingResponseCode.Ok) done.TrySetResult();
            else done.TrySetException(new InvalidOperationException(result.DebugMessage is { Length: > 0 } text ? text : "Google Playに接続できませんでした。"));
        }
    }
    private sealed class Acknowledged(TaskCompletionSource done) : Java.Lang.Object, IAcknowledgePurchaseResponseListener
    {
        public void OnAcknowledgePurchaseResponse(BillingResult result)
        {
            if (result.ResponseCode == BillingResponseCode.Ok) done.TrySetResult();
            else done.TrySetException(new InvalidOperationException(result.DebugMessage is { Length: > 0 } text ? text : "Google Playの購入を確認済みにできませんでした。"));
        }
    }
}
