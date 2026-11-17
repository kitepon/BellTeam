using System.Net;
using BellTeam.Core;
using Xunit;

namespace BellTeam.Tests;

public sealed class SubscriptionTests
{
    // a336a: the purchase entry's shared decisions (who is offered it, which refusals mean "nothing to buy", the state lines).
    [Fact]
    public void ThePurchaseEntryIsOfferedOnlyToAnInactivePlanOnASubscriptionServer()
    {
        Assert.False(SubscriptionApi.OffersPurchase(null));
        Assert.True(SubscriptionApi.OffersPurchase(new SubscriptionState { Entitled = false, AccessMode = "subscription" }));
        Assert.False(SubscriptionApi.OffersPurchase(new SubscriptionState { Entitled = true, AccessMode = "subscription" }));
        Assert.False(SubscriptionApi.OffersPurchase(new SubscriptionState { Entitled = false, AccessMode = "developer" }));
    }

    [Fact]
    public void OnlyStripeNotConfiguredAndNotRequiredMeanNothingToBuy()
    {
        Assert.True(SubscriptionApi.NothingToBuy(new BellApiException("x", HttpStatusCode.ServiceUnavailable, "SUBSCRIPTION_NOT_CONFIGURED")));
        Assert.True(SubscriptionApi.NothingToBuy(new BellApiException("x", HttpStatusCode.Conflict, "SUBSCRIPTION_NOT_REQUIRED")));
        Assert.False(SubscriptionApi.NothingToBuy(new BellApiException("x", HttpStatusCode.ServiceUnavailable, "SUBSCRIPTION_CONNECTION_FAILED")));
        Assert.False(SubscriptionApi.NothingToBuy(new BellApiException("x")));
    }

    [Fact]
    public void TheStateLinesFollowTheServerFlags()
    {
        var until = new DateTimeOffset(2026, 12, 17, 3, 0, 0, TimeSpan.Zero);
        Assert.Empty(SubscriptionText.StateLines(new SubscriptionState { Entitled = false, ValidUntil = until }));
        Assert.Equal([SubscriptionText.ValidUntil(until)], SubscriptionText.StateLines(new SubscriptionState { Entitled = true, ValidUntil = until, AutoRenewing = true }));
        Assert.Equal([SubscriptionText.ValidUntil(until), SubscriptionText.Trial, SubscriptionText.NotRenewing], SubscriptionText.StateLines(new SubscriptionState { Entitled = true, ValidUntil = until, IsTrial = true }));
    }
}
