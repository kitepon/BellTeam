using System.Net;
using System.Text;
using System.Text.Json;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// a337: the Stripe purchase entry on 利用と課金, against a stub server.
public sealed class PurchaseEntryTests
{
    private sealed class Server : HttpMessageHandler
    {
        public int Checkouts; public string? Verified, Opened;
        public bool Entitled, Developer; public HttpStatusCode CheckoutStatus = HttpStatusCode.OK; public string CheckoutUrl = "https://checkout.example/pay";
        private string State() => JsonSerializer.Serialize(new { subscription = new { entitled = Entitled, state = Entitled ? "active" : "not_purchased", accessMode = Developer ? "developer" : "subscription", isTrial = Entitled, autoRenewing = true, validUntil = Entitled ? "2026-12-17T03:00:00Z" : null, setupComplete = true } });
        private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            switch (request.RequestUri!.AbsolutePath)
            {
                case "/api/subscription" or "/api/subscription/refresh": return Json(State());
                case "/api/subscription/stripe/checkout":
                    Checkouts++;
                    return CheckoutStatus == HttpStatusCode.OK ? Json($$"""{"url":"{{CheckoutUrl}}","sessionId":"cs_test_1"}""") : Json("""{"error":"SUBSCRIPTION_NOT_CONFIGURED","message":"Stripeの設定が完了していません。"}""", CheckoutStatus);
                case "/api/subscription/stripe/verify":
                    using (var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token))) Verified = body.RootElement.GetProperty("stripeSessionId").GetString();
                    Entitled = true; return Json(State());
                default: return Json("{}", HttpStatusCode.NotFound);
            }
        }
        public PurchaseEntry Entry(CancellationToken token = default) => new(new SubscriptionApi(new BellApi(new("http://localhost/"), this)), url => Opened = url, token);
    }

    [Fact]
    public Task StartOpensTheCheckoutOnceThenVerifyReadsThePlanWithTheKeptSessionId() => Ui.Run(async () =>
    {
        var server = new Server(); var entry = server.Entry();
        await entry.LoadAsync();
        Assert.Equal(0, server.Checkouts); Assert.NotNull(Find(entry, SubscriptionText.Start)); Assert.Contains(SubscriptionText.Caption, Texts(entry)); Assert.Null(Find(entry, SubscriptionText.Verify));
        await Click(entry, SubscriptionText.Start, () => server.Opened is not null);
        Assert.Equal(1, server.Checkouts); Assert.Equal("https://checkout.example/pay", server.Opened);
        await Until(() => Find(entry, SubscriptionText.Verify) is not null); Assert.NotNull(Find(entry, SubscriptionText.Recheck));
        await Click(entry, SubscriptionText.Verify, () => entry.State?.Entitled == true);
        Assert.Equal("cs_test_1", server.Verified);
        Assert.Null(Find(entry, SubscriptionText.Start)); Assert.Null(Find(entry, SubscriptionText.Verify));
        Assert.Contains(Texts(entry), line => line.StartsWith("有効期限：")); Assert.Contains(SubscriptionText.Trial, Texts(entry));
    });

    [Fact]
    public Task NothingIsOfferedForAnActivePlanADeveloperServerOrStripeNotSetUp() => Ui.Run(async () =>
    {
        var active = new Server { Entitled = true }; var activeEntry = active.Entry(); await activeEntry.LoadAsync();
        Assert.Null(Find(activeEntry, SubscriptionText.Start)); Assert.Equal(0, active.Checkouts);
        var developer = new Server { Developer = true }; var developerEntry = developer.Entry(); await developerEntry.LoadAsync();
        Assert.Null(Find(developerEntry, SubscriptionText.Start));
        var dark = new Server { CheckoutStatus = HttpStatusCode.ServiceUnavailable }; var darkEntry = dark.Entry(); await darkEntry.LoadAsync();
        await Click(darkEntry, SubscriptionText.Start, () => !darkEntry.Offering);
        Assert.Null(Find(darkEntry, SubscriptionText.Start)); Assert.Null(Find(darkEntry, SubscriptionText.Recheck)); Assert.Null(dark.Opened);
    });

    [Fact]
    public Task OnlyAnHttpsAddressGoesToTheBrowser() => Ui.Run(async () =>
    {
        var server = new Server { CheckoutUrl = "file:///etc/passwd" }; var entry = server.Entry(); await entry.LoadAsync();
        await Click(entry, SubscriptionText.Start, () => Texts(entry).Any(line => line.Contains("読めませんでした")));
        Assert.Null(server.Opened);
    });

    private static Button? Find(Control root, string name) => root.GetVisualDescendants().OfType<Button>().FirstOrDefault(button => button.Content as string == name);
    private static string[] Texts(Control root) => root.GetVisualDescendants().OfType<TextBlock>().Select(text => text.Text ?? "").ToArray();
    private static async Task Click(Control root, string name, Func<bool> done) { Find(root, name)!.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); await Until(done); }
    private static async Task Until(Func<bool> condition) { var until = DateTime.UtcNow.AddSeconds(5); while (!condition()) { if (DateTime.UtcNow > until) throw new TimeoutException(); await Task.Delay(5); Dispatcher.UIThread.RunJobs(); } }
}
