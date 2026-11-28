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
    // a485 7e: the server's own entitlement, "active" | "none" | "unknown"; an older server has no field.
    public string? EntitlementState { get; init; }
}
public sealed record SubscriptionResponse { public required SubscriptionState Subscription { get; init; } }
// POST /api/subscription/stripe/checkout: the URL to open and the Session ID that stripe/verify takes after the return.
public sealed record StripeCheckout { public required string Url { get; init; } public required string SessionId { get; init; } }

// POST /api/subscription/stripe/manage: Stripe's customer portal page (cancel, undo, card, invoices).
public sealed record StripeManage { public required string Url { get; init; } }

public sealed class SubscriptionApi(BellApi api)
{
    public async Task<SubscriptionState> GetAsync(CancellationToken token = default) => (await api.GetAsync<SubscriptionResponse>("/api/subscription", token)).Subscription;
    // a485 7e (Tronie): only "none" shows the paywall. A server without the field, "active", "unknown" and a failed read all show the app: the paywall is the server's answer, never a guess.
    public async Task<bool> PaywalledAsync(CancellationToken token = default)
    {
        try { return (await GetAsync(token)).EntitlementState == "none"; }
        catch (Exception) when (!token.IsCancellationRequested) { return false; }
    }
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
    // a485/a486 7e (Owner 2026-11-22): shown instead of the native app when the server's entitlement is "none"; there is no browser version.
    public static string Paywall  => CoreStrings.Subscription_Paywall_1;
    public static string Start  => CoreStrings.Subscription_Start_1;
    public static string Price  => CoreStrings.Subscription_Price_1;
    public static string FreeMonth  => CoreStrings.Subscription_FreeMonth_1;
    public static string Unavailable(string store) => CoreStrings.Subscription_Unavailable_1(store);
    public static string Active(string store) => CoreStrings.Subscription_Active_1(store);
    // The server's subscription source ("apple" | "stripe" | "google") as the store name on a row.
    public static string? StoreOf(string? source) => source switch { "apple" => "App Store", "stripe" => "Stripe", "google" => "Google Play", _ => null };
    // The server's source name for a store row, the inverse of StoreOf.
    public static string SourceOf(string store) => store switch { "App Store" => "apple", "Google Play" => "google", _ => "stripe" };
    public static string Manage  => CoreStrings.Subscription_Manage_1;
    // a389: Apple and Google Play have no server call; the manage button opens the store's own subscription page (Stripe's page comes from POST /api/subscription/stripe/manage).
    public static string? ManageUrl(string store) => store switch { "App Store" => "https://apps.apple.com/account/subscriptions", "Google Play" => "https://play.google.com/store/account/subscriptions", _ => null };
    // Shown on the active row while the subscription is cancelled but paid up to validUntil; it is undone through the manage button, never by a second purchase.
    public static string NotRenewingRow(DateTimeOffset until) => CoreStrings.Subscription_NotRenewingRow_1(until.ToLocalTime());
    public static string Verify  => CoreStrings.Subscription_Verify_1;
    public static string Recheck  => CoreStrings.StoreAccount_Refresh_1;
    // a485 (Bready's final wording): where the server has no live contract or is not logged in, no app buys anything here.
    public static string BuyOnApple  => CoreStrings.Subscription_BuyOnApple_1;
    public static string Trial  => CoreStrings.Subscription_Trial_1;
    public static string ValidUntil(DateTimeOffset value) => CoreStrings.Subscription_ValidUntil_2(value.ToLocalTime().ToString(CoreStrings.GoalModels_Date_1));
    // The state lines of a plan that is active: expiry, then the trial note when it applies (the non-renewing line sits on the source's row: NotRenewingRow).
    public static IEnumerable<string> StateLines(SubscriptionState state)
    {
        if (!state.Entitled) yield break;
        if (state.ValidUntil is { } until) yield return ValidUntil(until);
        if (state.IsTrial) yield return Trial;
    }
}
