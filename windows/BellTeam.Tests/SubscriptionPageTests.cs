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
        public int Checkouts; public string? Verified; public string? Opened;
        public bool Entitled, Developer; public HttpStatusCode CheckoutStatus = HttpStatusCode.OK;
        private string State() => JsonSerializer.Serialize(new { subscription = new { entitled = Entitled, state = Entitled ? "active" : "not_purchased", accessMode = Developer ? "developer" : "subscription", isTrial = Entitled, autoRenewing = true, validUntil = Entitled ? "2026-12-17T03:00:00Z" : null, setupComplete = true } });
        public SubscriptionApi Api() => new(new BellApi(new("http://localhost/"), new StubHandler(async (request, token) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/api/subscription") return StubHandler.Json(State());
            if (path == "/api/subscription/refresh") return StubHandler.Json(State());
            if (path == "/api/subscription/stripe/checkout")
            {
                Checkouts++;
                return CheckoutStatus == HttpStatusCode.OK ? StubHandler.Json("""{"url":"https://checkout.example/pay","sessionId":"cs_test_1"}""") : StubHandler.Json("""{"error":"SUBSCRIPTION_NOT_CONFIGURED","message":"Stripeの設定が完了していません。"}""", CheckoutStatus);
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
        Assert.Equal(0, server.Checkouts); Assert.NotNull(Find(entry, SubscriptionText.Start)); Assert.Contains(SubscriptionText.Caption, Texts(entry)); Assert.Null(Find(entry, SubscriptionText.Verify));
        Click(entry, SubscriptionText.Start); Until(() => server.Opened is not null);
        Assert.Equal(1, server.Checkouts); Assert.Equal("https://checkout.example/pay", server.Opened);
        Until(() => Find(entry, SubscriptionText.Verify) is not null); Assert.NotNull(Find(entry, SubscriptionText.Recheck));
        Click(entry, SubscriptionText.Verify); Until(() => entry.State?.Entitled == true);
        Assert.Equal("cs_test_1", server.Verified);
        Assert.Null(Find(entry, SubscriptionText.Start)); Assert.Null(Find(entry, SubscriptionText.Verify));
        Assert.Contains(Texts(entry), line => line.StartsWith("有効期限：")); Assert.Contains(SubscriptionText.Trial, Texts(entry));
    });

    [Fact]
    public void NothingIsOfferedForAnActivePlanADeveloperServerOrStripeNotSetUp() => RunSta(() =>
    {
        var active = new Server { Entitled = true }; var activeEntry = new PurchaseEntry(active.Api(), _ => { }, CancellationToken.None); Await(activeEntry.LoadAsync());
        Assert.Null(Find(activeEntry, SubscriptionText.Start)); Assert.Equal(0, active.Checkouts);
        var developer = new Server { Developer = true }; var developerEntry = new PurchaseEntry(developer.Api(), _ => { }, CancellationToken.None); Await(developerEntry.LoadAsync());
        Assert.Null(Find(developerEntry, SubscriptionText.Start));
        var dark = new Server { CheckoutStatus = HttpStatusCode.ServiceUnavailable }; var darkEntry = new PurchaseEntry(dark.Api(), _ => throw new InvalidOperationException("opened"), CancellationToken.None); Await(darkEntry.LoadAsync());
        Click(darkEntry, SubscriptionText.Start); Until(() => !darkEntry.Offering);
        Assert.Null(Find(darkEntry, SubscriptionText.Start)); Assert.Null(Find(darkEntry, SubscriptionText.Recheck));
    });

    private static Button? Find(DependencyObject root, string name) => Descendants<Button>(root).FirstOrDefault(button => System.Windows.Automation.AutomationProperties.GetName(button) == name);
    private static void Click(DependencyObject root, string name) => Find(root, name)!.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent));
    private static string[] Texts(DependencyObject root) => Descendants<TextBlock>(root).Select(text => text.Text).ToArray();
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
