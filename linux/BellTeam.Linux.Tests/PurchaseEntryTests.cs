using System.Net;
using System.Text;
using Avalonia.Controls;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// a485: nothing is bought in Linux and Android. The entry shows what the server reports and, with no live contract, the one sentence; a missing field reads as "none".
public sealed class PurchaseEntryTests
{
    private sealed class Server(string subscription) : HttpMessageHandler
    {
        public readonly List<string> Calls = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Calls.Add(request.Method + " " + request.RequestUri!.AbsolutePath);
            return Task.FromResult(request.RequestUri.AbsolutePath == "/api/subscription"
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(subscription, Encoding.UTF8, "application/json") }
                : new HttpResponseMessage(HttpStatusCode.NotFound));
        }
    }
    private static async Task<(PurchaseEntry Entry, Server Server)> Load(string subscription)
    {
        var server = new Server(subscription);
        var entry = new PurchaseEntry(new SubscriptionApi(new BellApi(new("http://localhost/"), server)), default);
        await entry.LoadAsync();
        return (entry, server);
    }
    private static string[] Texts(Control root) => root.GetVisualDescendants().OfType<TextBlock>().Select(text => text.Text ?? "").ToArray();

    [Fact]
    public Task WithoutALiveContractItSaysToBuyOnAnAppleDeviceAndOffersNoPurchase() => Ui.Run(async () =>
    {
        // The server leaves out isTrial, billingSources and canPurchase: they read as none, and nothing can be bought here.
        var (entry, server) = await Load("""{"subscription":{"entitled":false,"state":"not_purchased","accessMode":"subscription"}}""");
        Assert.Contains(SubscriptionText.BuyOnApple, Texts(entry));
        Assert.DoesNotContain(entry.GetVisualDescendants().OfType<Button>(), button => button.Content as string == SubscriptionText.Start);
        Assert.Equal(["GET /api/subscription"], server.Calls);
    });

    [Fact]
    public Task AnActivePlanShowsItsStoreAndExpiryAndNoSentence() => Ui.Run(async () =>
    {
        var (entry, _) = await Load("""{"subscription":{"entitled":true,"state":"active","source":"apple","validUntil":"2026-12-17T03:00:00Z"}}""");
        Assert.Contains(SubscriptionText.Active("App Store"), Texts(entry)); Assert.Contains(Texts(entry), line => line.StartsWith("有効期限："));
        Assert.DoesNotContain(SubscriptionText.BuyOnApple, Texts(entry));
    });

    [Fact]
    public Task ADeveloperServerShowsNothingAndAFailedReadOffersARecheck() => Ui.Run(async () =>
    {
        var (developer, _) = await Load("""{"subscription":{"entitled":false,"state":"not_purchased","accessMode":"developer"}}""");
        Assert.Empty(developer.Children);
        var broken = new PurchaseEntry(new SubscriptionApi(new BellApi(new("http://localhost/"), new Server("{}"))), default);
        await broken.LoadAsync();
        Assert.Contains(broken.GetVisualDescendants().OfType<Button>(), button => button.Content as string == SubscriptionText.Recheck);
    });
}
