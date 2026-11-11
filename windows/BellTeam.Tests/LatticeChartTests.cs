using System.Net;
using System.Runtime.CompilerServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// 工程表 (docs/architecture/modules/lattice/screen-spec.md): the calculations ported from web/lattice-chart-model.js, the feed's connection states, and the window's text rules.
public sealed class LatticeChartTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 11, 12, 0, 0, TimeSpan.Zero);
    private static LatticeCard Card(string id, string state, string? producer, int depth = 0, string? reason = null) => new() { Id = id, Title = "工程" + id, State = state, Producer = producer, Depth = depth, BlockedReason = reason, StartedAt = Now.AddMinutes(-12) };
    private static LatticeSnapshot Snapshot(LatticeCard[] cards, LatticeEdge[]? edges = null, LatticeWait[]? waits = null, string state = "verified") => new()
    {
        ProjectId = "proj", State = state, VerifiedAt = Now.AddMinutes(-46),
        Members = [new("bot-a", "アドミ", "amber", ""), new("bot-k", "キロ", "sky", "")], Cards = cards, Edges = edges ?? [], Waits = waits ?? []
    };

    [Fact]
    public void TheChartNameNeverFallsBackToTheProjectId()
    {
        Assert.Equal("Lattice組込", LatticeChart.ChartName("Lattice組込", "bot-a", _ => "アドミ"));
        Assert.Equal("アドミの工程表", LatticeChart.ChartName(null, "bot-a", id => id == "bot-a" ? "アドミ" : null));
        Assert.Equal("名前のない工程表", LatticeChart.ChartName(null, "bot-ghost", _ => null));
        Assert.Equal("名前のない工程表", LatticeChart.ChartName("", null, _ => null));
    }

    [Fact]
    public void LanesAreKnownMembersByNameThenUnknownThenUnassignedAndColumnsFollowDepth()
    {
        var layout = LatticeChart.Layout(Snapshot([Card("1", "pending", null, 2), Card("2", "ready", "bot-ghost", 1), Card("3", "in-progress", "bot-k", 0), Card("4", "done", "bot-a", 1)]));
        Assert.Equal(["bot-a", "bot-k", "bot-ghost", null], layout.Lanes.Select(lane => lane.BotId));
        Assert.False(layout.Lanes[2].Member!.Known);
        Assert.Equal(LatticeChart.UnknownMember, layout.Lanes[2].Member!.Name);
        Assert.Null(layout.Lanes[3].Member);
        Assert.Equal(layout.Cards["3"].X + 2 * LatticeChart.ColumnWidth, layout.Cards["1"].X);
        Assert.Equal(LatticeChart.CardDoneHeight, layout.Cards["4"].Height);
    }

    [Fact]
    public void WaitRowsAreOldestFirstEmphasizeABlockedProducerAndNeverChatWithAnUnknownMember()
    {
        var snapshot = Snapshot([Card("1", "blocked", "bot-a", reason: "登録点が未定"), Card("2", "pending", "bot-k", 1), Card("3", "in-progress", "bot-ghost"), Card("4", "pending", "bot-k", 1)],
            [new("1", "2", true), new("3", "4", true)],
            [new("bot-k", "4", "3", "bot-ghost", "in-progress", Now.AddMinutes(-5)), new("bot-k", "2", "1", "bot-a", "blocked", Now.AddMinutes(-52))]);
        var rows = LatticeChart.WaitRows(snapshot, Now);
        Assert.Equal(["2>1", "4>3"], rows.Select(row => row.Key));
        Assert.True(rows[0].Emphasized);
        Assert.Equal("止まり: 登録点が未定", rows[0].StateText);
        Assert.Equal("52分", rows[0].Length);
        Assert.Equal("キロが工程1を待っています。つくっているのはアドミ、止まり: 登録点が未定", rows[0].Label);
        Assert.True(rows[0].CanChat);
        Assert.False(rows[1].CanChat);
        Assert.Equal(LatticeChart.UnknownMember, rows[1].Producer!.Name);
        Assert.Equal("作業中 12分", rows[1].StateText);
    }

    [Fact]
    public void BannersAndPillsArePlainSentences()
    {
        Assert.Null(LatticeChart.Banner(Snapshot([])));
        Assert.Equal("amber", LatticeChart.Banner(Snapshot([], state: "unverified"))!.Tone);
        var last = LatticeChart.Banner(Snapshot([], state: "last_verified"))!;
        Assert.True(last.Dim);
        Assert.Equal("いまの記録が読めないため、最後に確認できた状態（11月11日 20:14 JST）を表示しています。", last.Text);
        Assert.Equal(["最新の記録を読み直しています…", "メンバー情報を読み直しています…"], LatticeChart.DegradedPills(Snapshot([]) with { Degraded = ["lattice-read", "members", "other"] }));
    }

    [Fact]
    public void ReconnectWaitsDoubleToThirtySeconds()
    {
        Assert.Equal([1000, 2000, 4000, 8000, 16000, 30000, 30000], Enumerable.Range(0, 7).Select(attempt => LatticeChart.BackoffMs(attempt, () => .5)));
        // One particle every 600 ms for 1.4 s of travel: two or three in flight, each on its way (0..1).
        foreach (var now in new[] { 100.0, 700, 1300, 5000 }) { var flight = LatticeChart.FlowPositions(now).ToList(); Assert.InRange(flight.Count, 2, 3); Assert.All(flight, t => Assert.InRange(t, 0, 1)); }
    }

    [Fact]
    public async Task TheFeedReconnectsAfterADropAndStopsOnlyForNotFoundOrSignIn()
    {
        var waits = new List<TimeSpan>();
        var feed = new LatticeChartFeed((wait, _) => { waits.Add(wait); return Task.CompletedTask; });
        var opens = 0;
        async IAsyncEnumerable<LatticeSnapshot> Open(Action activity, [EnumeratorCancellation] CancellationToken token)
        {
            opens++;
            await Task.Yield();
            if (opens == 1) { yield return Snapshot([Card("1", "pending", null)]); throw new BellApiException("切れました"); }
            if (opens == 2) throw new BellApiException("503", HttpStatusCode.ServiceUnavailable, "LATTICE_UNAVAILABLE");
            if (opens == 3) throw new BellApiException("404", HttpStatusCode.NotFound, "NOT_FOUND");
            throw new BellApiException("404", HttpStatusCode.NotFound, "LATTICE_CHART_NOT_FOUND");
        }
        var states = new List<LatticeConnection>(); feed.Changed += () => states.Add(feed.Connection);
        await feed.RunAsync(Open, CancellationToken.None);
        Assert.Equal([LatticeConnection.Live, LatticeConnection.Reconnecting, LatticeConnection.Unsupported, LatticeConnection.NotFound], states.Distinct());
        Assert.Equal(TimeSpan.FromSeconds(60), waits[2]);
        Assert.NotNull(feed.Snapshot);   // the last drawing stays through the drops

        var signedOut = new LatticeChartFeed((_, _) => Task.CompletedTask);
        async IAsyncEnumerable<LatticeSnapshot> Login(Action activity, [EnumeratorCancellation] CancellationToken token) { await Task.Yield(); if (token.CanBeCanceled || true) throw new BellApiException("login", HttpStatusCode.Unauthorized); yield break; }
        await signedOut.RunAsync(Login, CancellationToken.None);
        Assert.Equal(LatticeConnection.Login, signedOut.Connection);
    }

    [Theory]
    [InlineData("chart")]
    [InlineData("unknown")]
    [InlineData("unverified")]
    public void TheWindowShowsNoIdsCodesOrPathsAndDisablesChatWithAnUnknownMember(string scene) => RunSta(() =>
    {
        using var workspace = new Workspace(origin => new BellApi(origin, new LatticeFixture(scene)));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask) { Rendering = true };
        window.Sync(); Until(() => window.ListSettled);
        window.OpenChart("lattice"); var chart = window.Chart!;
        Until(() => chart.Feed.Snapshot is not null);
        chart.OpenDetail("p1/t08", morph: false);
        var texts = LogicalTree.Find<TextBlock>(window.Content).Select(text => text.Text)
            .Concat(LogicalTree.Find<FrameworkElement>(window.Content).Select(element => System.Windows.Automation.AutomationProperties.GetName(element))).Where(text => text.Length > 0).ToList();
        Assert.Contains(texts, text => text.Contains("Lattice組込", StringComparison.Ordinal));
        Assert.DoesNotContain(texts, text => text.Contains("bot-", StringComparison.Ordinal) || text.Contains("p1/", StringComparison.Ordinal) || text.Contains("lattice-", StringComparison.Ordinal) || text.Contains("LATTICE_", StringComparison.Ordinal) || text == "lattice");
        // The crown and 統括 only on the coordinator chart (this one is).
        Assert.Contains("統括", texts);
        var chats = LogicalTree.Find<Button>(window.Content).Where(button => button.Content as string == "会話を開く").ToList();
        Assert.NotEmpty(chats);
        Assert.Equal(scene == "unknown", chats.Any(button => !button.IsEnabled));
        Assert.Equal(scene == "unknown", texts.Contains(LatticeChart.UnknownMember));
        Assert.Equal(scene == "unverified", LogicalTree.Find<Button>(window.Content).Any(button => button.Content as string == "統括と話す"));
        chart.Stop(); window.Close();
    });

    [Fact]
    public void AChartThatIsNotTheCoordinatorsHasNoCrown() => RunSta(() =>
    {
        using var workspace = new Workspace(origin => new BellApi(origin, new LatticeFixture("chart")));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask) { Rendering = true };
        window.Sync(); Until(() => window.ListSettled);
        window.OpenChart("web-polish"); var chart = window.Chart!;
        Until(() => chart.Feed.Snapshot is not null);
        var texts = LogicalTree.Find<TextBlock>(window.Content).Select(text => text.Text).ToList();
        Assert.Contains("アドミの工程表", texts);
        Assert.DoesNotContain("統括", texts);
        chart.Stop(); window.Close();
    });

    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Await(Task task) { Until(() => task.IsCompleted); task.GetAwaiter().GetResult(); }
    private static void Until(Func<bool> done) { var until = DateTime.UtcNow.AddSeconds(10); while (!done()) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); } }
    private static void RunSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
