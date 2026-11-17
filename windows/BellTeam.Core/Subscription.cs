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
    public string? AccessMode { get; init; }
    public bool SetupComplete { get; init; }
    public JsonElement? Error { get; init; }
}
public sealed record SubscriptionResponse { public required SubscriptionState Subscription { get; init; } }
// POST /api/subscription/stripe/checkout: the URL to open and the Session ID that stripe/verify takes after the return.
public sealed record StripeCheckout { public required string Url { get; init; } public required string SessionId { get; init; } }

public sealed class SubscriptionApi(BellApi api)
{
    public async Task<SubscriptionState> GetAsync(CancellationToken token = default) => (await api.GetAsync<SubscriptionResponse>("/api/subscription", token)).Subscription;
    public async Task<SubscriptionState> RefreshAsync(CancellationToken token = default) => (await api.PostAsync<SubscriptionResponse>("/api/subscription/refresh", new { }, token)).Subscription;
    // Each call makes a new Stripe Checkout (the server changes no state). 503 SUBSCRIPTION_NOT_CONFIGURED (Stripe not set up) and 409 SUBSCRIPTION_NOT_REQUIRED (developer server) mean there is nothing to buy: see OffersPurchase.
    public Task<StripeCheckout> CheckoutAsync(CancellationToken token = default) => api.PostAsync<StripeCheckout>("/api/subscription/stripe/checkout", new { }, token);
    public async Task<SubscriptionState> VerifyAsync(string sessionId, CancellationToken token = default) => (await api.PostAsync<SubscriptionResponse>("/api/subscription/stripe/verify", new { stripeSessionId = sessionId }, token)).Subscription;
    // Shared by every client: the purchase entry is hidden when the plan is already active or the server refuses a checkout for these two reasons.
    public static bool OffersPurchase(SubscriptionState? state) => state is { Entitled: false, AccessMode: not "developer" };
    public static bool NothingToBuy(Exception error) => error is BellApiException { Status: System.Net.HttpStatusCode.ServiceUnavailable or System.Net.HttpStatusCode.Conflict, Code: "SUBSCRIPTION_NOT_CONFIGURED" or "SUBSCRIPTION_NOT_REQUIRED" };
}

// The words of the purchase entry on the 利用と課金 page, the same on Web, Windows and Linux (Owner-side tie-break 2026-11-17: checkout is called when 月額購読を開始 is pressed, because every call makes a Stripe session).
public static class SubscriptionText
{
    public const string Start = "月額購読を開始";
    public const string Caption = "Stripeの購入画面をブラウザーで開きます。最初の1か月は無料です。";
    public const string Verify = "購入を確認";
    public const string Recheck = "再確認";
    public const string Trial = "無料期間中です。";
    public const string NotRenewing = "自動更新は停止しています。有効期限までは利用できます。";
    public static string ValidUntil(DateTimeOffset value) => "有効期限：" + value.ToLocalTime().ToString("yyyy年M月d日 H:mm");
    // The state lines of a plan that is active: expiry, then the trial and non-renewing notes when they apply.
    public static IEnumerable<string> StateLines(SubscriptionState state)
    {
        if (!state.Entitled) yield break;
        if (state.ValidUntil is { } until) yield return ValidUntil(until);
        if (state.IsTrial) yield return Trial;
        if (!state.AutoRenewing) yield return NotRenewing;
    }
}
