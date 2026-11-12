using System.Net;
using System.Net.Http;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// 止め一覧 (docs/architecture/modules/lattice/screen-spec.md "止め一覧"; contract README "Stops (blockers)"): the rows ported from web/lattice-stops.js and the page's states.
public sealed class LatticeStopsTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 13, 3, 0, 0, TimeSpan.Zero);   // 12:00 JST
    private static LatticePerson? Roster(string id) => id == "bot-a" ? new LatticePerson("bot-a", "アドミ", "amber", "", true) : null;

    [Fact]
    public void RowsAreNewestFirstWithTheFaceRulesAndOneSpokenLabel()
    {
        LatticeStop?[] stops = [
            new() { StopId = "s-old", ProjectId = "p", ChartName = "夜間", Title = "古い", Lane = "kiro", Reason = "待ち", BlockedAt = "2026-11-10T01:00:00Z", BlockedBy = "bot-ghost" },
            new() { StopId = "s-new", ProjectId = "p", ChartCreatedBy = "bot-a", CardId = "p1/t1", Title = "新しい", Lane = "bot-a", Reason = "CI is red", BlockedAt = "2026-11-13T00:30:00Z", BlockedBy = "owner" },
            new() { StopId = "s-mid", ProjectId = "q", Title = "昨日の", Lane = "owner", BlockedAt = "2026-11-12T14:05:00Z" },
            new() { StopId = "s-bad", ProjectId = "q", Title = "時刻なし", BlockedAt = "not a time" },
            new() { ProjectId = "q", Title = "idなし" }, null,
        ];
        var rows = LatticeStops.Rows(stops, Now, Roster, "クオ");
        Assert.Equal(["s-new", "s-mid", "s-old", "s-bad"], rows.Select(row => row.StopId));
        Assert.Equal(("今日 09:30", "昨日 23:05", "11月10日 10:00", ""), (rows[0].Time, rows[1].Time, rows[2].Time, rows[3].Time));
        Assert.Equal(("アドミの工程表", "夜間", "名前のない工程表"), (rows[0].Chart, rows[2].Chart, rows[1].Chart));
        Assert.Equal(("アドミ", true), (rows[0].Lane!.Name, rows[0].Lane!.Known));
        Assert.True(rows[0].By!.IsOwner); Assert.Equal("クオ", rows[0].By!.Name);
        Assert.True(rows[1].Lane!.IsOwner);
        Assert.Equal(("kiro", true), (rows[2].Lane!.Name, rows[2].Lane!.Authored));
        Assert.Equal((LatticeChart.UnknownMember, false), (rows[2].By!.Name, rows[2].By!.Known));
        Assert.Null(rows[3].Lane);
        Assert.Equal("止まり、新しい、アドミの工程表、担当 アドミ、理由 CI is red、クオが今日 09:30に止めました", rows[0].Label);
        Assert.Equal("止まり、時刻なし、名前のない工程表、担当なし、担当なしが止めました", rows[3].Label);
    }

    [Theory]
    [InlineData(200, "removed", null, LatticeUnblockKind.Drop, "")]
    [InlineData(200, "already-gone", null, LatticeUnblockKind.Drop, "")]
    [InlineData(200, "something-new", null, LatticeUnblockKind.Later, "")]
    [InlineData(409, null, "もう取り下げ", LatticeUnblockKind.Refused, "もう取り下げ")]
    [InlineData(503, null, null, LatticeUnblockKind.Later, "")]
    [InlineData(400, null, null, LatticeUnblockKind.Later, "")]
    [InlineData(null, null, null, LatticeUnblockKind.Later, "")]
    public void AnUnblockAnswerDropsRefusesOrComesLater(int? status, string? outcome, string? reason, LatticeUnblockKind kind, string text)
        => Assert.Equal(new LatticeUnblockOutcome(kind, text), LatticeStops.Outcome(status, outcome, reason));

    [Fact]
    public void UnblockSendsOnlyTheStopIdAsJsonAndReadsTheRefusalReason() => Run(async () =>
    {
        string? body = null, type = null;
        var api = new BellApi(new Uri("http://localhost/"), new Handler(async request =>
        {
            body = await request.Content!.ReadAsStringAsync(); type = request.Content.Headers.ContentType?.MediaType;
            return new HttpResponseMessage(HttpStatusCode.Conflict) { Content = new StringContent("""{"error":"LATTICE_UNBLOCK_REFUSED","outcome":"refused","code":"X","reason":"外せない理由"}""", Encoding.UTF8, "application/json") };
        }));
        Assert.Equal(new LatticeUnblockOutcome(LatticeUnblockKind.Refused, "外せない理由"), await api.UnblockAsync("a b", "0123456789abcdef01234567"));
        Assert.Equal("""{"stopId":"0123456789abcdef01234567"}""", body);
        Assert.Equal("application/json", type);
        var down = new BellApi(new Uri("http://localhost/"), new Handler(_ => throw new HttpRequestException("down")));
        Assert.Equal(LatticeUnblockKind.Later, (await down.UnblockAsync("p", "s")).Kind);
    });

    [Fact]
    public void TheListOpensFromOneListAndShowsNoIdsOrCodes() => RunSta(() =>
    {
        var (workspace, window) = Open("stops-unread");
        var stops = window.Stops!;
        Assert.Equal(LatticeStopsPage.Phase.Ready, stops.State);
        Assert.Equal(5, stops.Rows.Count);
        var texts = Texts(window);
        Assert.Contains(LatticeStops.Unread, texts);
        Assert.Contains("止め一覧", texts);
        Assert.DoesNotContain(texts, text => text.Contains("bot-", StringComparison.Ordinal) || text.Contains("p1/", StringComparison.Ordinal) || text.Contains("LATTICE_", StringComparison.Ordinal) || text == "guide" || text.Contains("0a1b2c", StringComparison.Ordinal));
        Assert.Equal(5, LogicalTree.Find<FrameworkElement>(window.Content).Count(element => System.Windows.Automation.AutomationProperties.GetAutomationId(element) == "lattice-stop"));
        Close(workspace, window);
    });

    [Fact]
    public void RemoveIsTwoStepsInTheRowAndARefusalStaysOnTheRow() => RunSta(() =>
    {
        var (workspace, window) = Open("stops-refused");
        var stops = window.Stops!; var first = stops.Rows[0];
        Button Find(string id) => LogicalTree.Find<Button>(window.Content).First(button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == id);
        Find("lattice-stop-remove").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Assert.Equal(first.StopId, stops.Confirming);
        Assert.Contains(LatticeStops.Ask, Texts(window));
        window.Stops!.Escape();   // Esc closes only the confirm step
        Assert.Null(stops.Confirming); Assert.Same(stops, window.Stops);
        Find("lattice-stop-remove").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Find("lattice-stop-confirm").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Until(() => Texts(window).Contains(LatticeStops.Refused("この工程はもう取り下げられています。")));
        Until(() => stops.Reading.IsCompleted);
        Assert.Contains(LatticeStops.Refused("この工程はもう取り下げられています。"), Texts(window));   // the note stays after the re-read
        Assert.Equal(5, stops.Rows.Count);
        stops.Escape();   // no confirm open: back to 一覧
        Assert.Null(window.Stops);
        Close(workspace, window);
    });

    [Fact]
    public void ARowOpensItsChartAndTheCardsDetail() => RunSta(() =>
    {
        var (workspace, window) = Open("stops");
        var first = window.Stops!.Rows[0];
        LogicalTree.Find<Button>(window.Content).First(button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == "lattice-stop-open").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Assert.Null(window.Stops);
        Until(() => window.Chart?.SelectedCard is not null);
        Assert.Equal(first.CardId, window.Chart!.SelectedCard);
        window.Chart.Stop(); Close(workspace, window);
    });

    [Theory]
    [InlineData("stops-empty", "Ready", LatticeStops.Empty)]
    [InlineData("stops-old", "Old", LatticeStops.Old)]
    [InlineData("stops-retry", "Retry", LatticeStops.Retry)]
    public void EmptyOldAndRetrySayWhatIsHappening(string scene, string phase, string text) => RunSta(() =>
    {
        var (workspace, window) = Open(scene);
        Assert.Equal(phase, window.Stops!.State.ToString());
        Assert.Contains(text, Texts(window));
        Close(workspace, window);
    });

    private static (Workspace, LatticeWindow) Open(string scene)
    {
        var workspace = new Workspace(origin => new BellApi(origin, new LatticeFixture(scene)));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask) { Rendering = true };
        window.Sync(); Until(() => window.ListSettled);
        LogicalTree.Find<Button>(window.Content).First(button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == "lattice-stops").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Until(() => window.Stops!.State != LatticeStopsPage.Phase.Loading);
        return (workspace, window);
    }
    private static void Close(Workspace workspace, LatticeWindow window) { window.Close(); workspace.Dispose(); }
    private static List<string> Texts(LatticeWindow window) => LogicalTree.Find<TextBlock>(window.Content).Select(text => text.Text)
        .Concat(LogicalTree.Find<FrameworkElement>(window.Content).Select(element => System.Windows.Automation.AutomationProperties.GetName(element))).Where(text => text.Length > 0).ToList();

    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => answer(request);
    }
    private static void Run(Func<Task> test) => test().GetAwaiter().GetResult();
    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Await(Task task) { Until(() => task.IsCompleted); task.GetAwaiter().GetResult(); }
    private static void Until(Func<bool> done) { var until = DateTime.UtcNow.AddSeconds(10); while (!done()) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(5); } }
    private static void RunSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) throw failure;
    }
}
