using System.Text.Json;

namespace BellTeam.Core;

// GET /api/subscription (src/subscriptions.mjs status()). Error is the server's { code, status, message } object when the last check failed.
public sealed record SubscriptionState
{
    public bool Entitled { get; init; }
    public string State { get; init; } = "";
    public string? Source { get; init; }
    public bool IsTrial { get; init; }
    public DateTimeOffset? ValidUntil { get; init; }
    public bool AutoRenewing { get; init; }
    // a389: the stores that still bill this server ("apple" | "stripe" | "google"), and whether a purchase may be offered. An absent field reads as "no purchase" (billing-client-contract rule 6).
    public string[] BillingSources { get; init; } = [];
    public bool CanPurchase { get; init; }
    public string? AccessMode { get; init; }
    public bool SetupComplete { get; init; }
    public JsonElement? Error { get; init; }
}
public sealed record SubscriptionResponse { public required SubscriptionState Subscription { get; init; } }
// POST /api/subscription/stripe/checkout: the URL to open and the Session ID that stripe/verify takes after the return.
public sealed record StripeCheckout { public required string Url { get; init; } public required string SessionId { get; init; } }

// POST /api/subscription/stripe/manage: Stripe's customer portal page (cancel, undo, card, invoices).
public sealed record StripeManage { public required string Url { get; init; } }

public sealed class SubscriptionApi(BellApi api)
{
    public async Task<SubscriptionState> GetAsync(CancellationToken token = default) => (await api.GetAsync<SubscriptionResponse>("/api/subscription", token)).Subscription;
    public async Task<SubscriptionState> RefreshAsync(CancellationToken token = default) => (await api.PostAsync<SubscriptionResponse>("/api/subscription/refresh", new { }, token)).Subscription;
    // Each call makes a new Stripe Checkout (the server changes no state). 503 SUBSCRIPTION_NOT_CONFIGURED (Stripe not set up) and 409 SUBSCRIPTION_NOT_REQUIRED (developer server) mean there is nothing to buy: see OffersPurchase.
    public Task<StripeCheckout> CheckoutAsync(CancellationToken token = default) => api.PostAsync<StripeCheckout>("/api/subscription/stripe/checkout", new { }, token);
    public async Task<SubscriptionState> VerifyAsync(string sessionId, CancellationToken token = default) => (await api.PostAsync<SubscriptionResponse>("/api/subscription/stripe/verify", new { stripeSessionId = sessionId }, token)).Subscription;
    // a389: no body, no state change; 409 NO_STRIPE_SUBSCRIPTION means the server holds no Stripe subscription (see NoStripeSubscription).
    public Task<StripeManage> ManageAsync(CancellationToken token = default) => api.PostAsync<StripeManage>("/api/subscription/stripe/manage", new { }, token);
    // Shared by every client: the purchase entry is hidden when the plan is active, any store still bills (canPurchase false, no second charge) or the server refuses a checkout for these two reasons.
    public static bool OffersPurchase(SubscriptionState? state) => state is { Entitled: false, AccessMode: not "developer", CanPurchase: true };
    public static bool NoStripeSubscription(Exception error) => error is BellApiException { Status: System.Net.HttpStatusCode.Conflict, Code: "NO_STRIPE_SUBSCRIPTION" };
    // 409 from stripe/checkout: a store already bills this server. Show the server's message and read the status again.
    public static bool AlreadyActive(Exception error) => error is BellApiException { Status: System.Net.HttpStatusCode.Conflict, Code: "SUBSCRIPTION_ALREADY_ACTIVE" };
    public static bool NothingToBuy(Exception error) => error is BellApiException { Status: System.Net.HttpStatusCode.ServiceUnavailable or System.Net.HttpStatusCode.Conflict, Code: "SUBSCRIPTION_NOT_CONFIGURED" or "SUBSCRIPTION_NOT_REQUIRED" };
}

// The words of the purchase entry on the 利用と課金 page, the same on Web, Windows and Linux (Owner-side tie-break 2026-11-17: checkout is called when 購入 is pressed, because every call makes a Stripe session).
public static class SubscriptionText
{
    // docs/billing-client-contract.md (a358): Windows and Linux list Stripe first, then the other two stores, as equal rows; only Stripe can be bought here.
    public static readonly string[] Stores = ["Stripe", "App Store", "Google Play"];
    public const string Start = "購入";
    public const string Price = "月980円（税込）";
    public const string FreeMonth = "最初の1か月無料";
    public static string Unavailable(string store) => $"この端末では購入できません。{store}で購入した購読も、同じサーバーでこのアプリに使えます。";
    public static string Active(string store) => $"購読中（{store}）";
    // The server's subscription source ("apple" | "stripe" | "google") as the store name on a row.
    public static string? StoreOf(string? source) => source switch { "apple" => "App Store", "stripe" => "Stripe", "google" => "Google Play", _ => null };
    // The server's source name for a store row, the inverse of StoreOf.
    public static string SourceOf(string store) => store switch { "App Store" => "apple", "Google Play" => "google", _ => "stripe" };
    public const string Manage = "購読を管理・解約";
    // a389: Apple and Google Play have no server call; the manage button opens the store's own subscription page (Stripe's page comes from POST /api/subscription/stripe/manage).
    public static string? ManageUrl(string store) => store switch { "App Store" => "https://apps.apple.com/account/subscriptions", "Google Play" => "https://play.google.com/store/account/subscriptions", _ => null };
    // Shown on the active row while the subscription is cancelled but paid up to validUntil; it is undone through the manage button, never by a second purchase.
    public static string NotRenewingRow(DateTimeOffset until) => $"次回の更新はありません。{until.ToLocalTime():yyyy年M月d日 H:mm}まで使えます。";
    public const string Verify = "購入を確認";
    public const string Recheck = "再確認";
    // a485 (Bready's final wording): where the server has no live contract or is not logged in, no app buys anything here.
    public const string BuyOnApple = "iPhone・iPad・Macで購入し、このサーバーをログインさせてください。";
    public const string Trial = "無料期間中です。";
    public static string ValidUntil(DateTimeOffset value) => "有効期限：" + value.ToLocalTime().ToString("yyyy年M月d日 H:mm");
    // The state lines of a plan that is active: expiry, then the trial note when it applies (the non-renewing line sits on the source's row: NotRenewingRow).
    public static IEnumerable<string> StateLines(SubscriptionState state)
    {
        if (!state.Entitled) yield break;
        if (state.ValidUntil is { } until) yield return ValidUntil(until);
        if (state.IsTrial) yield return Trial;
    }
}
