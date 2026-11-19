using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// a336: the Stripe purchase entry on 利用と課金, against a stub server.
public sealed class SubscriptionPageTests
{
    private sealed class Server
    {
        public int Checkouts, Manages; public string? Verified; public string? Opened; public bool NotRenewing; public string? ManageCode, CheckoutCode = "SUBSCRIPTION_NOT_CONFIGURED";
        public bool Entitled, Developer; public HttpStatusCode CheckoutStatus = HttpStatusCode.OK;
        private string State() => JsonSerializer.Serialize(new { subscription = new { entitled = Entitled, state = Entitled ? "active" : "not_purchased", accessMode = Developer ? "developer" : "subscription", isTrial = Entitled, autoRenewing = !NotRenewing, billingSources = Entitled ? new[] { "stripe" } : Array.Empty<string>(), canPurchase = !Entitled && !Developer, source = Entitled ? "stripe" : null, validUntil = Entitled ? "2026-12-17T03:00:00Z" : null, setupComplete = true } });
        public SubscriptionApi Api() => new(new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/api/subscription") return StubHandler.Json(State());
            if (path == "/api/subscription/refresh") return StubHandler.Json(State());
            if (path == "/api/subscription/stripe/checkout")
            {
                Checkouts++;
                return CheckoutStatus == HttpStatusCode.OK ? StubHandler.Json("""{"url":"https://checkout.example/pay","sessionId":"cs_test_1"}""") : StubHandler.Json($$"""{"error":"{{CheckoutCode}}","message":"Stripeの設定が完了していません。"}""", CheckoutStatus);
            }
            if (path == "/api/subscription/stripe/manage")
            {
                Manages++;
                return ManageCode is null ? StubHandler.Json("""{"url":"https://billing.stripe.com/p/session/test_1"}""") : StubHandler.Json($$"""{"error":"{{ManageCode}}","message":"Stripeの購読がありません。"}""", HttpStatusCode.Conflict);
            }
            if (path == "/api/subscription/stripe/verify")
            {
                using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token)); Verified = body.RootElement.GetProperty("stripeSessionId").GetString(); Entitled = true; return StubHandler.Json(State());
            }
            return StubHandler.Json("{}", HttpStatusCode.NotFound);
        })));
    }

    [Fact]
    public void StartOpensTheCheckoutOnceThenVerifyReadsThePlanWithTheKeptSessionId() => RunSta(() =>
    {
        var server = new Server(); var entry = new PurchaseEntry(server.Api(), url => server.Opened = url, CancellationToken.None);
        Await(entry.LoadAsync());
        Assert.Equal(0, server.Checkouts); Assert.NotNull(Find(entry, SubscriptionText.Start)); Assert.Null(Find(entry, SubscriptionText.Verify));
        // contract rows: Stripe, App Store, Google Play in this order, each with price and free month; only Stripe has the button, the others the "cannot buy here" line.
        var texts = Texts(entry); Assert.Equal(["Stripe", "App Store", "Google Play"], texts.Where(SubscriptionText.Stores.Contains).ToArray());
        Assert.Equal(3, texts.Count(line => line == $"{SubscriptionText.Price}　{SubscriptionText.FreeMonth}"));
        Assert.Contains(SubscriptionText.Unavailable("App Store"), texts); Assert.Contains(SubscriptionText.Unavailable("Google Play"), texts); Assert.Single(Descendants<Button>(entry), button => System.Windows.Automation.AutomationProperties.GetName(button) == SubscriptionText.Start);
        Buy(entry); Until(() => server.Opened is not null);
        Assert.Equal(1, server.Checkouts); Assert.Equal("https://checkout.example/pay", server.Opened);
        Until(() => Find(entry, SubscriptionText.Verify) is not null); Assert.NotNull(Find(entry, SubscriptionText.Recheck));
        Click(entry, SubscriptionText.Verify); Until(() => entry.State?.Entitled == true);
        Assert.Equal("cs_test_1", server.Verified);
        Assert.Null(Find(entry, SubscriptionText.Start)); Assert.Null(Find(entry, SubscriptionText.Verify));
        Assert.Contains(Texts(entry), line => line.StartsWith("有効期限：")); Assert.Contains(SubscriptionText.Trial, Texts(entry));
        Assert.Contains(SubscriptionText.Active("Stripe"), Texts(entry)); Assert.Equal(3, Texts(entry).Count(SubscriptionText.Stores.Contains));
    });

    [Fact]
    public void NothingIsOfferedForAnActivePlanADeveloperServerOrStripeNotSetUp() => RunSta(() =>
    {
        var active = new Server { Entitled = true }; var activeEntry = new PurchaseEntry(active.Api(), _ => { }, CancellationToken.None); Await(activeEntry.LoadAsync());
        Assert.Null(Find(activeEntry, SubscriptionText.Start)); Assert.Equal(0, active.Checkouts);
        var developer = new Server { Developer = true }; var developerEntry = new PurchaseEntry(developer.Api(), _ => { }, CancellationToken.None); Await(developerEntry.LoadAsync());
        Assert.Null(Find(developerEntry, SubscriptionText.Start)); Assert.DoesNotContain(Texts(developerEntry), SubscriptionText.Stores.Contains);
        var dark = new Server { CheckoutStatus = HttpStatusCode.ServiceUnavailable }; var darkEntry = new PurchaseEntry(dark.Api(), _ => throw new InvalidOperationException("opened"), CancellationToken.None); Await(darkEntry.LoadAsync());
        Buy(darkEntry); Until(() => !darkEntry.Offering);
        Assert.Null(Find(darkEntry, SubscriptionText.Start)); Assert.Null(Find(darkEntry, SubscriptionText.Recheck));
    });

    [Fact]
    public void ManageOpensStripesPageAndShowsTheNonRenewingLineAndNoSecondPurchase() => RunSta(() =>
    {
        var server = new Server { Entitled = true, NotRenewing = true }; var entry = new PurchaseEntry(server.Api(), url => server.Opened = url, CancellationToken.None);
        Await(entry.LoadAsync());
        var manage = SubscriptionText.Manage + " Stripe";
        Assert.Single(Descendants<Button>(entry), button => System.Windows.Automation.AutomationProperties.GetName(button).StartsWith(SubscriptionText.Manage));
        Assert.Null(Find(entry, SubscriptionText.Start)); Assert.Contains(Texts(entry), line => line.StartsWith("次回の更新はありません。") && line.EndsWith("まで使えます。"));
        Assert.NotNull(Find(entry, SubscriptionText.Recheck));
        Click(entry, manage); Until(() => server.Opened is not null);
        Assert.Equal(1, server.Manages); Assert.Equal("https://billing.stripe.com/p/session/test_1", server.Opened); Assert.Equal(0, server.Checkouts);
    });

    [Fact]
    public void NoStripeSubscriptionHidesTheStripeManageButton() => RunSta(() =>
    {
        var server = new Server { Entitled = true, ManageCode = "NO_STRIPE_SUBSCRIPTION" }; var entry = new PurchaseEntry(server.Api(), _ => throw new InvalidOperationException("opened"), CancellationToken.None);
        Await(entry.LoadAsync()); Click(entry, SubscriptionText.Manage + " Stripe"); Until(() => Find(entry, SubscriptionText.Manage + " Stripe") is null);
        Assert.Equal(1, server.Manages);
    });

    [Fact]
    public void AnAlreadyActiveCheckoutShowsTheServersWordsAndReadsTheStatusAgain() => RunSta(() =>
    {
        var server = new Server { CheckoutStatus = HttpStatusCode.Conflict, CheckoutCode = "SUBSCRIPTION_ALREADY_ACTIVE" }; var entry = new PurchaseEntry(server.Api(), _ => throw new InvalidOperationException("opened"), CancellationToken.None);
        Await(entry.LoadAsync()); server.Entitled = true; Buy(entry);
        Until(() => Texts(entry).Any(line => line.Contains("Stripeの設定が完了していません。"))); Assert.True(entry.State?.Entitled); Assert.Null(Find(entry, SubscriptionText.Start));
    });

    // a460: 購入 only opens the confirmation panel; 申し込む is the press that asks the server for Checkout.
    [Fact]
    public void StartShowsTheConfirmationPanelAndOnlyApplyAsksTheServerForCheckout() => RunSta(() =>
    {
        var server = new Server(); var entry = new PurchaseEntry(server.Api(), url => server.Opened = url, CancellationToken.None);
        Await(entry.LoadAsync()); Click(entry, SubscriptionText.Start);
        var texts = Texts(entry);
        foreach (var line in new[] { SubscriptionText.ConfirmTitle, SubscriptionText.ConfirmPlan, SubscriptionText.ConfirmPrice, SubscriptionText.ConfirmPayment, SubscriptionText.ConfirmFirstCharge(DateTime.Today), SubscriptionText.ConfirmStart, SubscriptionText.ConfirmCancel, SubscriptionText.ConfirmRefund, SubscriptionText.ConfirmTerms }) Assert.Contains(line, texts);
        Assert.Contains("に初回の980円を決済し、以後は毎月の更新日に自動で決済します。", string.Concat(texts.Where(line => line.StartsWith("最初の1か月は無料です。"))));
        Assert.Null(Find(entry, SubscriptionText.Start)); Assert.NotNull(Find(entry, SubscriptionText.ConfirmBack)); Assert.Equal(0, server.Checkouts);
        foreach (var (label, url) in new[] { (SubscriptionText.ConfirmLawLink, SubscriptionText.ConfirmLawUrl), (SubscriptionText.ConfirmTermsLink, SubscriptionText.ConfirmTermsUrl), (SubscriptionText.ConfirmAnnexLink, SubscriptionText.ConfirmAnnexUrl) })
        {
            server.Opened = null; Descendants<System.Windows.Documents.Hyperlink>(entry).Single(link => string.Concat(Descendants<System.Windows.Documents.Run>(link).Select(run => run.Text)) == label).RaiseEvent(new RoutedEventArgs(System.Windows.Documents.Hyperlink.ClickEvent));
            Assert.Equal(url, server.Opened);
        }
        Assert.Equal(0, server.Checkouts);
        Click(entry, SubscriptionText.ConfirmBack); Until(() => Find(entry, SubscriptionText.Start) is not null);
        Assert.Equal(0, server.Checkouts); Assert.Null(Find(entry, SubscriptionText.ConfirmApply)); Assert.DoesNotContain(SubscriptionText.ConfirmTitle, Texts(entry));
        server.Opened = null; Buy(entry); Until(() => server.Opened is not null); Assert.Equal(1, server.Checkouts);
    });

    private static void Buy(DependencyObject root) { Click(root, SubscriptionText.Start); Click(root, SubscriptionText.ConfirmApply); }
    private static Button? Find(DependencyObject root, string name) => Descendants<Button>(root).FirstOrDefault(button => System.Windows.Automation.AutomationProperties.GetName(button) == name);
    private static void Click(DependencyObject root, string name) => Find(root, name)!.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent));
    private static string[] Texts(DependencyObject root) => Descendants<TextBlock>(root).Select(text => text.Text.Length > 0 ? text.Text : string.Concat(Descendants<System.Windows.Documents.Run>(text).Select(run => run.Text))).ToArray();
    private static IEnumerable<T> Descendants<T>(DependencyObject root) where T : DependencyObject { if (root is T found) yield return found; foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()) foreach (var item in Descendants<T>(child)) yield return item; }
    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Until(Func<bool> condition) { var until = DateTime.UtcNow.AddSeconds(5); while (!condition()) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); } }
    private static void Await(Task task) { Until(() => task.IsCompleted); task.GetAwaiter().GetResult(); }
    private static void RunSta(Action action)
    {
        Exception? failure = null; var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
