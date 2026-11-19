using System.Net;
using System.Text;
using System.Text.Json;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// a337: the three store rows of the purchase entry on 利用と課金, against a stub server.
public sealed class PurchaseEntryTests
{
    private sealed class Server : HttpMessageHandler
    {
        public int Checkouts, Manages; public string? Verified, Opened;
        public bool Entitled, Developer, Renewing = true; public HttpStatusCode ManageStatus = HttpStatusCode.OK; public string Source = "stripe"; public HttpStatusCode CheckoutStatus = HttpStatusCode.OK; public string CheckoutUrl = "https://checkout.example/pay";
        private string State() => JsonSerializer.Serialize(new { subscription = new { entitled = Entitled, state = Entitled ? "active" : "not_purchased", source = Entitled ? Source : null, accessMode = Developer ? "developer" : "subscription", isTrial = Entitled, autoRenewing = Renewing, billingSources = Entitled ? new[] { Source } : Array.Empty<string>(), canPurchase = !Entitled && !Developer, validUntil = Entitled ? "2026-12-17T03:00:00Z" : null, setupComplete = true } });
        private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            switch (request.RequestUri!.AbsolutePath)
            {
                case "/api/subscription" or "/api/subscription/refresh": return Json(State());
                case "/api/subscription/stripe/checkout":
                    Checkouts++;
                    return CheckoutStatus == HttpStatusCode.OK ? Json($$"""{"url":"{{CheckoutUrl}}","sessionId":"cs_test_1"}""") : Json("""{"error":"SUBSCRIPTION_NOT_CONFIGURED","message":"Stripeの設定が完了していません。"}""", CheckoutStatus);
                case "/api/subscription/stripe/manage":
                    Manages++;
                    return ManageStatus == HttpStatusCode.OK ? Json("""{"url":"https://billing.stripe.com/p/session/x"}""") : Json("""{"error":"NO_STRIPE_SUBSCRIPTION","message":"Stripeで購入した購読がありません。"}""", ManageStatus);
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
        Assert.Equal(0, server.Checkouts); Assert.NotNull(Find(entry, SubscriptionText.Start)); Assert.Null(Find(entry, SubscriptionText.Verify));
        // Contract rows: Stripe first, App Store and Google Play after it, each with the price and the free month; only the two others say they cannot be bought here.
        Assert.Equal(SubscriptionText.Stores, Texts(entry).Where(SubscriptionText.Stores.Contains).ToArray());
        Assert.Equal(3, Texts(entry).Count(line => line == $"{SubscriptionText.Price}　{SubscriptionText.FreeMonth}"));
        Assert.Contains(SubscriptionText.Unavailable("App Store"), Texts(entry)); Assert.Contains(SubscriptionText.Unavailable("Google Play"), Texts(entry)); Assert.DoesNotContain(SubscriptionText.Unavailable("Stripe"), Texts(entry));
        await Buy(entry, () => server.Opened is not null);
        Assert.Equal(1, server.Checkouts); Assert.Equal("https://checkout.example/pay", server.Opened);
        await Until(() => Find(entry, SubscriptionText.Verify) is not null); Assert.NotNull(Find(entry, SubscriptionText.Recheck));
        await Click(entry, SubscriptionText.Verify, () => entry.State?.Entitled == true);
        Assert.Equal("cs_test_1", server.Verified);
        Assert.Null(Find(entry, SubscriptionText.Start)); Assert.Null(Find(entry, SubscriptionText.Verify));
        Assert.Contains(Texts(entry), line => line.StartsWith("有効期限：")); Assert.Contains(SubscriptionText.Trial, Texts(entry));
        Assert.Contains(SubscriptionText.Active("Stripe"), Texts(entry));
    });

    [Fact]
    public Task NothingIsOfferedForAnActivePlanADeveloperServerOrStripeNotSetUp() => Ui.Run(async () =>
    {
        // An App Store plan: its row is marked active, the Stripe row has no button, and no second purchase is offered.
        var active = new Server { Entitled = true, Source = "apple" }; var activeEntry = active.Entry(); await activeEntry.LoadAsync();
        Assert.Null(Find(activeEntry, SubscriptionText.Start)); Assert.Equal(0, active.Checkouts); Assert.Contains(SubscriptionText.Active("App Store"), Texts(activeEntry)); Assert.DoesNotContain(SubscriptionText.Unavailable("App Store"), Texts(activeEntry));
        var developer = new Server { Developer = true }; var developerEntry = developer.Entry(); await developerEntry.LoadAsync();
        Assert.Null(Find(developerEntry, SubscriptionText.Start)); Assert.DoesNotContain("Stripe", Texts(developerEntry));
        var dark = new Server { CheckoutStatus = HttpStatusCode.ServiceUnavailable }; var darkEntry = dark.Entry(); await darkEntry.LoadAsync();
        await Buy(darkEntry, () => !darkEntry.Offering);
        Assert.Null(Find(darkEntry, SubscriptionText.Start)); Assert.Null(Find(darkEntry, SubscriptionText.Recheck)); Assert.Null(dark.Opened); Assert.DoesNotContain("Stripe", Texts(darkEntry));
    });

    [Fact]
    public Task PressingStartShowsThePoliPanelAndOnlyApplyAsksTheServerForCheckout() => Ui.Run(async () =>
    {
        var server = new Server(); var entry = server.Entry(); await entry.LoadAsync();
        Find(entry, SubscriptionText.Start)!.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        var texts = Texts(entry);
        // Poli's words, exactly; the one dynamic value is today + 30 days.
        foreach (var line in new[] { "購入内容の確認", "BellTeamの月額購読（解約するまで毎月自動で更新）", "月額980円（税込）。1年続けた場合の合計の目安：11,760円", "クレジットカード、Apple Pay、Google Pay（Stripe）", SubscriptionText.ConfirmFirstCharge(DateTime.Today), "支払い手続きの完了後、サーバーが契約を確認した時点から使えます（無料期間中も使えます）。", "いつでも「設定 > BellTeamの購読」→「購読を管理・解約」から解約できます。支払い済みの期間の終わりに終了します。無料期間中に解約すれば料金はかかりません。", "デジタルサービスのため、申込み後の返金・撤回はできません。ただし二重請求などは返金します。詳しくは特定商取引法に基づく表記をご覧ください。", "申し込むと、利用規約とBellTeam付属規約に同意したことになります。" }) Assert.Contains(line, texts);
        Assert.Equal(1, texts.Count(line => line.StartsWith("最初の1か月は無料です。") && line.Contains("に初回の980円を決済し、以後は毎月の更新日に自動で決済します。")));
        Assert.Null(Find(entry, SubscriptionText.Start)); Assert.Equal(0, server.Checkouts);
        await Click(entry, "特定商取引法に基づく表記", () => server.Opened is not null); Assert.Equal("https://kitepon.dev/specified-commercial-transactions/#bellteam", server.Opened);
        await Click(entry, "利用規約", () => server.Opened == "https://kitepon.dev/terms/");
        await Click(entry, "BellTeam付属規約", () => server.Opened == "https://kitepon.dev/apps/bellteam/terms/");
        Assert.Equal(0, server.Checkouts);
        await Click(entry, "戻る", () => Find(entry, SubscriptionText.Start) is not null);
        Assert.Equal(0, server.Checkouts); Assert.Null(Find(entry, "申し込む（Stripeの支払い画面へ進む）")); Assert.DoesNotContain("購入内容の確認", Texts(entry));
        await Buy(entry, () => server.Checkouts == 1);
        Assert.Equal(1, server.Checkouts); Assert.Null(Find(entry, "申し込む（Stripeの支払い画面へ進む）"));
    });

    [Fact]
    public void TheFirstChargeDateIsThirtyDaysAfterToday() => Assert.Equal("最初の1か月は無料です。2026年12月20日に初回の980円を決済し、以後は毎月の更新日に自動で決済します。", SubscriptionText.ConfirmFirstCharge(new DateTime(2026, 11, 20)));

    [Fact]
    public Task OnlyAnHttpsAddressGoesToTheBrowser() => Ui.Run(async () =>
    {
        var server = new Server { CheckoutUrl = "file:///etc/passwd" }; var entry = server.Entry(); await entry.LoadAsync();
        await Buy(entry, () => Texts(entry).Any(line => line.Contains("読めませんでした")));
        Assert.Null(server.Opened);
    });

    [Fact]
    public Task AStripePlanHasOneManageButtonThatOpensStripesPageAndAStoreWithoutOneDropsOut() => Ui.Run(async () =>
    {
        var server = new Server { Entitled = true, Renewing = false }; var entry = server.Entry(); await entry.LoadAsync();
        Assert.NotNull(Find(entry, SubscriptionText.Manage));
        Assert.Contains(Texts(entry), line => line.StartsWith("次回の更新はありません。") && line.EndsWith("まで使えます。"));
        Assert.Null(Find(entry, SubscriptionText.Start));
        await Click(entry, SubscriptionText.Manage, () => server.Opened is not null);
        Assert.Equal("https://billing.stripe.com/p/session/x", server.Opened); Assert.Equal(1, server.Manages);
        var none = new Server { Entitled = true, ManageStatus = HttpStatusCode.Conflict }; var noneEntry = none.Entry(); await noneEntry.LoadAsync();
        await Click(noneEntry, SubscriptionText.Manage, () => none.Manages == 1 && Find(noneEntry, SubscriptionText.Manage) is null);
        Assert.Null(Find(noneEntry, SubscriptionText.Manage)); Assert.Null(none.Opened);
    });

    [Fact]
    public Task AnAppStorePlanOpensTheStoresOwnPageWithoutAServerCall() => Ui.Run(async () =>
    {
        var server = new Server { Entitled = true, Source = "apple" }; var entry = server.Entry(); await entry.LoadAsync();
        await Click(entry, SubscriptionText.Manage, () => server.Opened is not null);
        Assert.Equal(SubscriptionText.ManageUrl("App Store"), server.Opened); Assert.Equal(0, server.Manages);
    });

    [Fact]
    public void NothingIsOfferedWhenTheServerDoesNotSayCanPurchase() => Assert.False(SubscriptionApi.OffersPurchase(new SubscriptionState { Entitled = false, AccessMode = "subscription" }));

    private static Button? Find(Control root, string name) => root.GetVisualDescendants().OfType<Button>().FirstOrDefault(button => button.Content as string == name);
    private static string[] Texts(Control root) => root.GetVisualDescendants().OfType<TextBlock>().Select(text => text.Text ?? "").ToArray();
    // 購入 opens the panel, 申し込む asks the server (a460).
    private static async Task Buy(Control root, Func<bool> done) { await Click(root, SubscriptionText.Start, () => Find(root, SubscriptionText.ConfirmApply) is not null); await Click(root, SubscriptionText.ConfirmApply, done); }
    private static async Task Click(Control root, string name, Func<bool> done) { Find(root, name)!.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); await Until(done); }
    private static async Task Until(Func<bool> condition) { var until = DateTime.UtcNow.AddSeconds(5); while (!condition()) { if (DateTime.UtcNow > until) throw new TimeoutException(); await Task.Delay(5); Dispatcher.UIThread.RunJobs(); } }
}
