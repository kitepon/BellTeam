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
    public void ChartsWithAZeroDenominatorAreNotListed()
    {
        LatticeChartSummary Chart(string id, int? total) => new() { ProjectId = id, Name = id, Counts = total is { } t ? new(t, 0, 0, 0, 0) : null };
        var list = new LatticeChartList { Charts = [Chart("a", 3), Chart("zero", 0), Chart("none", null), Chart("b", 1)] };
        Assert.Equal(["a", "b"], LatticeChart.Shown(list).Select(chart => chart.ProjectId));
        Assert.Equal(["a", "b"], LatticeChart.ListItems(list, _ => null).Select(item => item.ProjectId));
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
    public void AnAuthoredLaneIsTheOwnerWhenNobodyStartedItInItsOwnLaneAfterTheMembers()
    {
        var snapshot = Snapshot([Card("1", "in-progress", "bot-k"), Card("2", "pending", null, 1) with { Lane = "root" }, Card("3", "ready", null, 1) with { Lane = "anis" }, Card("4", "pending", null, 2), Card("5", "pending", "bot-ghost", 2)],
            [new("1", "2", true), new("2", "4", true)], [new(null, "2", "1", "bot-k", "in-progress", Now.AddMinutes(-9)), new(null, "4", "2", null, "pending", Now.AddMinutes(-3))]);
        var layout = LatticeChart.Layout(snapshot);
        Assert.Equal(["キロ", "anis", "root", LatticeChart.UnknownMember, LatticeChart.Unassigned], layout.Lanes.Select(lane => LatticeChart.NameOf(lane.Member)));
        Assert.Equal(["bot-k", null, null, "bot-ghost", null], layout.Lanes.Select(lane => lane.BotId));
        Assert.Equal(["bot-k", "bot-ghost"], LatticeChart.Rail(snapshot, layout).Select(item => item.BotId));
        var rows = LatticeChart.WaitRows(snapshot, Now);
        Assert.Equal(("工程2", "担当 root"), (rows[0].Headline, rows[0].OwnerText));
        Assert.Equal(("工程4", LatticeChart.Unassigned), (rows[1].Headline, rows[1].OwnerText));
        Assert.Equal("「工程4」（担当なし）は、「工程2」が終わるのを待っています。つくっているのはroot、未着手: 担当 root", rows[1].Label);
        Assert.Equal("次の工程が待っています", LatticeChart.EdgeChip(snapshot, new("2", "4", true)));
        Assert.Equal("未着手: 担当 root", rows[1].StateText);
        Assert.False(rows[1].CanChat);
        Assert.Equal("rootが待っています", LatticeChart.EdgeChip(snapshot, new("1", "2", true)));
        Assert.Equal("担当 anis", LatticeChart.CardNote(snapshot.Cards[2], LatticeChart.Owner(snapshot)(snapshot.Cards[2])));
        Assert.Equal("root", LatticeChart.Detail(snapshot, "2", Now)!.Producer!.Name);
    }

    [Fact]
    public void TheTreeHangsCardsFromParentThenPhaseThenTheChartAndArcsTheDependencies()
    {
        var snapshot = Snapshot([Card("1", "blocked", "bot-a") with { Phase = "ph" }, Card("2", "in-progress", "bot-k") with { Parent = "1" }, Card("3", "done", null) with { Phase = "ph" }, Card("4", "pending", null) with { Parent = "4" }],
            [new("3", "2", false), new("1", "4", true)]) with { Phases = [new("ph", null), new("empty", "空")] };
        var tree = LatticeChart.Tree(snapshot, "工程表");
        var node = tree.Nodes.ToDictionary(item => item.Key);
        Assert.Equal((LatticeChart.UnnamedPhase, 1, 2, "blocked"), (node["phase:ph"].Label, node["phase:ph"].Done, node["phase:ph"].Total, node["phase:ph"].Tone));
        Assert.Equal(("pending", 0), (node["phase:empty"].Tone, node["phase:empty"].Total));
        Assert.Equal((1, 4), (node["root"].Done, node["root"].Total));
        Assert.Equal(node["1"].X + LatticeChart.TreeCardWidth + LatticeChart.TreeGap, node["2"].X);
        Assert.Equal(node["2"].Y, node["1"].Y);
        Assert.Contains(tree.Links, link => link.From == "root" && link.To == "4");
        Assert.Equal([false, true], tree.Arcs.Select(arc => arc.Waiting));
        Assert.True(tree.Arcs.All(arc => arc.Bulge > Math.Max(arc.X0, arc.X1 - 6)));
        Assert.Equal(["1", "2", "3", "4"], tree.Cards.Keys.Order());
    }

    [Fact]
    public void ArchivedCardsLeaveTheTreeAndLanesAndFractionsCountOnlyCountedCards()
    {
        var snapshot = Snapshot([Card("1", "done", "bot-a") with { Phase = "old", Archived = true, DoneAt = Now.AddHours(-1) }, Card("2", "pending", "bot-k") with { Phase = "new", Parent = "3" },
            Card("3", "retired", "bot-k") with { Phase = "new", Archived = true, Counted = true, DoneAt = Now.AddHours(-30) }, Card("4", "done", "bot-a") with { Phase = "new", DoneAt = Now.AddDays(-3) }, Card("5", "done", null)])
            with { Phases = [new("old", "済んだ"), new("new", "今の")] };
        var tree = LatticeChart.Tree(snapshot, "工程表");
        Assert.Equal(["2", "4", "5"], tree.Cards.Keys.Order());
        Assert.DoesNotContain(tree.Nodes, node => node.Key == "phase:old");
        Assert.Contains(tree.Links, link => link.From == "phase:new" && link.To == "2");
        var node = tree.Nodes.ToDictionary(item => item.Key);
        // a96: card 3 is hidden but its tree is open (counted); card 1 has no counted field (older child) and is archived, so it is not counted.
        Assert.Equal((3, 4), (node["root"].Done, node["root"].Total));
        Assert.Equal((2, 3), (node["phase:new"].Done, node["phase:new"].Total));
        Assert.Equal(["2", "4", "5"], LatticeChart.Layout(snapshot).Cards.Keys.Order());
        Assert.Equal((4, 3), (LatticeChart.Counts(snapshot).Total, LatticeChart.Counts(snapshot).Done));
        var log = LatticeChart.History(snapshot, Now);
        Assert.Equal(4, log.Count);
        Assert.Equal(["今日", "昨日", "11月8日", "日時の分からない工程"], log.Groups.Select(group => group.Heading));
        Assert.Equal(("1", "20:00", "工程1、完了、今日 20:00、アドミ"), (log.Groups[0].Rows[0].Id, log.Groups[0].Rows[0].Time, log.Groups[0].Rows[0].Label));
        Assert.Equal(("5", "", "工程5、完了、担当なし"), (log.Groups[3].Rows[0].Id, log.Groups[3].Rows[0].Time, log.Groups[3].Rows[0].Label));
        Assert.Equal(0, LatticeChart.History(Snapshot([Card("9", "pending", null)]), Now).Count);
    }

    [Fact]
    public void TheOwnerValueIsTheOwnerProfileWithItsOwnLaneNoChatAndNoRailFace()
    {
        var snapshot = Snapshot([Card("1", "in-progress", "bot-a"), Card("2", "pending", "owner", 1)], [new("1", "2", true)], [new("owner", "2", "1", "bot-a", "in-progress", Now.AddMinutes(-3)), new("bot-a", "1", "2", "owner", "pending", Now.AddMinutes(-1))]);
        var unknown = LatticeChart.Lookup(snapshot)("owner")!;
        Assert.Equal((LatticeChart.OwnerFallback, true, true, false), (unknown.Name, unknown.IsOwner, unknown.Known, unknown.CanChat));
        var named = snapshot with { OwnerName = "クオ", OwnerAvatarVersion = "v1" };
        var layout = LatticeChart.Layout(named);
        Assert.Equal(["アドミ", "クオ"], layout.Lanes.Select(lane => LatticeChart.NameOf(lane.Member)));
        Assert.Equal(["bot-a"], LatticeChart.Rail(named, layout).Select(item => item.BotId));
        var rows = LatticeChart.WaitRows(named, Now);
        Assert.Equal(("担当 クオ", true), (rows[0].OwnerText, rows[0].CanChat));
        Assert.False(rows[1].CanChat);   // the Owner makes the awaited card: no 会話を開く
        Assert.Equal("クオが待っています", LatticeChart.EdgeChip(named, new("1", "2", true)));
        Assert.DoesNotContain(LatticeChart.Detail(named, "2", Now)!.StateText, "owner");
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
        Assert.Equal("「工程2」（担当 キロ）は、「工程1」が終わるのを待っています。つくっているのはアドミ、止まり: 登録点が未定", rows[0].Label);
        Assert.True(rows[0].CanChat);
        Assert.False(rows[1].CanChat);
        Assert.Equal(LatticeChart.UnknownMember, rows[1].Producer!.Name);
        Assert.Equal("作業中 12分", rows[1].StateText);
    }

    [Fact]
    public void ATaskOfAnotherChartIsTextWithItsChartAndOpensThatChartNeverALine()
    {
        // Wire (lattice README snapshot, task a60): externals[] and edge external; a snapshot without them reads as none.
        var snapshot = System.Text.Json.JsonSerializer.Deserialize<LatticeSnapshot>("""
            {"projectId":"proj","members":[{"botId":"bot-a","name":"アドミ"},{"botId":"bot-k","name":"キロ"}],
             "cards":[{"id":"p1/t05","title":"組み込む","state":"pending","producer":"bot-a"},{"id":"p1/t06","title":"配る","state":"pending"}],
             "edges":[{"from":"lattice:lattice-0990/release","to":"p1/t05","waiting":true,"external":true},{"from":"other:p/q","to":"p1/t06","waiting":true,"external":true}],
             "externals":[{"id":"lattice:lattice-0990/release","projectId":"lattice","cardId":"lattice-0990/release","chartName":"Lattice","title":"0.99.0を出す","state":"in-progress","finished":false,"producer":"bot-k"},
                          {"id":"other:p/q","projectId":"other","cardId":"p/q","chartName":null,"title":null,"state":null,"finished":false,"producer":null}],
             "waits":[{"waiter":"bot-a","waitingCard":"p1/t05","forCard":"lattice:lattice-0990/release","producer":"bot-k","producerState":"in-progress","since":"2026-11-11T11:30:00Z"},
                      {"waiter":null,"waitingCard":"p1/t06","forCard":"other:p/q","producer":null,"producerState":null,"since":"2026-11-11T11:50:00Z"}]}
            """, BellApi.Json)!;
        Assert.True(snapshot.Edges[0].External);
        Assert.Empty(System.Text.Json.JsonSerializer.Deserialize<LatticeSnapshot>("""{"projectId":"proj"}""", BellApi.Json)!.Externals);
        var rows = LatticeChart.WaitRows(snapshot, Now);
        Assert.Equal(("0.99.0を出す", "Latticeの工程表", "作業中"), (rows[0].Title, rows[0].Chart, rows[0].StateText));
        Assert.Equal(new LatticeCardRef("lattice", "lattice-0990/release"), rows[0].External);
        Assert.True(rows[0].CanChat);
        Assert.Equal("「組み込む」（担当 アドミ）は、「0.99.0を出す」（Latticeの工程表）が終わるのを待っています。つくっているのはキロ、作業中", rows[0].Label);
        Assert.Equal(("ほかの工程表の工程", "ほかの工程表の工程表", LatticeChart.ExternalUnread), (rows[1].Title, rows[1].Chart, rows[1].StateText));
        Assert.Null(rows[1].Producer);
        var previous = Assert.Single(LatticeChart.Detail(snapshot, "p1/t05", Now)!.Previous);
        Assert.Equal(("0.99.0を出す", "Latticeの工程表", "キロ", new LatticeCardRef("lattice", "lattice-0990/release")), (previous.Title, previous.Chart, previous.Producer?.Name, previous.External));
        Assert.Equal(LatticeChart.ExternalUnread, Assert.Single(LatticeChart.Detail(snapshot, "p1/t06", Now)!.Previous).StateText);
        Assert.Empty(LatticeChart.Tree(snapshot, "工程表").Arcs);
        Assert.False(LatticeChart.Layout(snapshot).Cards.ContainsKey("lattice:lattice-0990/release"));
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

    // Owner 2026-11-14 (a74): 待ちの流れ starts folded as the right-edge handle with the wait count; the handle opens it, its close button folds it.
    [Fact]
    public void TheWaitFlowStartsFoldedAndTheHandleOpensAndFoldsIt() => RunSta(() =>
    {
        LatticeChartPage.WaitsOpen = false;
        using var workspace = new Workspace(origin => new BellApi(origin, new LatticeFixture("chart")));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask) { Rendering = true };
        window.Sync(); Until(() => window.ListSettled);
        window.OpenChart("lattice"); var chart = window.Chart!;
        Until(() => chart.Feed.Snapshot is not null);
        Button Find(string id) => LogicalTree.Find<Button>(window.Content).Single(button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == id);
        Visibility Shown(Button button) => ((FrameworkElement)LogicalTreeHelper.GetParent(button) is ContentControl host ? host : FindPanel(button)).Visibility;
        FrameworkElement FindPanel(DependencyObject element) { var at = element; while (at is not null && !(at is Border { Child: DockPanel })) at = LogicalTreeHelper.GetParent(at); return (FrameworkElement)at!; }
        var rows = LatticeChart.WaitRows(chart.Feed.Snapshot!, window.Now()).Count;
        Assert.True(rows > 0);
        Assert.Equal($"待ちの流れを開く、{rows}件", System.Windows.Automation.AutomationProperties.GetName(Find("lattice-waits-open")));
        Assert.Equal(Visibility.Visible, Shown(Find("lattice-waits-open")));
        Assert.Equal(Visibility.Collapsed, Shown(Find("lattice-waits-close")));
        Find("lattice-waits-open").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Assert.True(LatticeChartPage.WaitsOpen);
        Assert.Equal(Visibility.Collapsed, Shown(Find("lattice-waits-open")));
        Assert.Equal(Visibility.Visible, Shown(Find("lattice-waits-close")));
        Find("lattice-waits-close").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Assert.False(LatticeChartPage.WaitsOpen);
        Assert.Equal(Visibility.Visible, Shown(Find("lattice-waits-open")));
        chart.Stop(); window.Close();
    });

    [Fact]
    public void AnOlderServerListSaysWhatHappensNext() => RunSta(() =>
    {
        using var workspace = new Workspace(origin => new BellApi(origin, new LatticeFixture("old-server")));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask) { Rendering = true };
        window.Sync(); Until(() => window.ListSettled);
        var texts = LogicalTree.Find<TextBlock>(window.Content).Select(text => text.Text).ToList();
        Assert.Contains(LatticeChart.OldServer, texts);
        Assert.Contains(LatticeChart.OldServerNext, texts);
        window.Close();
    });

    [Fact]
    public void ReadersReleaseTheirTokenSourcesAndStillRestart() => RunSta(() =>
    {
        using var workspace = new Workspace(origin => new BellApi(origin, new LatticeFixture("chart")));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask) { Rendering = true };
        var listField = typeof(LatticeWindow).GetField("listLoop", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        window.Sync(); Until(() => window.ListSettled);
        var list = (CancellationTokenSource)listField.GetValue(window)!;
        window.OpenChart("lattice");
        Until(() => window.ListRead.IsCompleted);
        Assert.Null(listField.GetValue(window));
        Assert.Throws<ObjectDisposedException>(() => list.Token);   // released after its reader finished

        var chart = window.Chart!; var runField = typeof(LatticeChartPage).GetField("run", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        Until(() => chart.Feed.Snapshot is not null);
        var first = (CancellationTokenSource)runField.GetValue(chart)!;
        chart.Stop();
        Assert.False(chart.Running);
        Until(() => { try { _ = first.Token; return false; } catch (ObjectDisposedException) { return true; } });
        window.Sync();   // shown again: the chart reads again on a new source
        Assert.True(chart.Running);
        var second = (CancellationTokenSource)runField.GetValue(chart)!;
        Assert.NotSame(first, second);
        chart.Stop(); window.Close();
    });

    [Fact]
    public void HistoryKeepsTheSelectedCardTheHighlightAndThePositionAcrossViews() => RunSta(() =>
    {
        using var workspace = new Workspace(origin => new BellApi(origin, new LatticeFixture("chart")));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask) { Rendering = true };
        try
        {
            LatticeChartPage.View = "lanes";
            window.Sync(); Until(() => window.ListSettled);
            window.OpenChart("lattice"); var chart = window.Chart!;
            Until(() => chart.Feed.Snapshot is not null);
            var root = (FrameworkElement)window.Content; root.Measure(new Size(1360, 860)); root.Arrange(new Rect(0, 0, 1360, 860)); root.UpdateLayout();
            chart.Highlight("bot-admi"); chart.OpenDetail("p1/t03", morph: false);
            chart.SetView("history"); root.UpdateLayout();
            var rows = LogicalTree.Find<Button>(window.Content).Where(button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == "lattice-history-row").ToList();
            Assert.Equal(3, rows.Count);
            var selected = Assert.Single(rows, button => ((Border)button.Content).BorderThickness.Top == 2);
            Assert.StartsWith("旧・組込案の比較", System.Windows.Automation.AutomationProperties.GetName(selected));
            Assert.Equal([1d], rows.Where(button => button.Opacity == 1).Select(button => button.Opacity));   // only アドミ's card stays lit
            Assert.Same(selected, rows.Single(button => button.Opacity == 1));
            var at = chart.CardRect("p1/t03");
            Assert.False(at.IsEmpty);
            Assert.True(at.Y > chart.CardRect("p1/t01").Y);
            chart.Highlight(null); chart.CloseDetail();
            Assert.All(rows, button => Assert.Equal((1d, 1d), (button.Opacity, ((Border)button.Content).BorderThickness.Top)));
            chart.Stop();
        }
        finally { LatticeChartPage.View = "tree"; window.Close(); }
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
