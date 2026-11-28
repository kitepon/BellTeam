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
    private static LatticeSnapshot Snapshot(LatticeCard[] cards, LatticeEdge[]? edges = null, string state = "verified") => new()
    {
        ProjectId = "proj", State = state, VerifiedAt = Now.AddMinutes(-46),
        Members = [new("bot-a", "アドミ", "amber", ""), new("bot-k", "キロ", "sky", "")], Cards = cards, Edges = edges ?? []
    };
    // An open 接続 (a161) that began `minutes` ago: kind task (ref = an externals[] id), schedule (ref = its id) or priority (agent = the Bot that asked).
    private static LatticeConnectionEntry Join(string kind, string? reference, int minutes, string? agent = null, string? reason = null, string? state = "open") => new(kind, reference, agent, reason, Now.AddMinutes(-minutes), state);
    private static LatticeExternal Other(string id, string? state, string? producer, string? title = "題", string? chart = "別") => new(id, id[..id.IndexOf(':')], id[(id.IndexOf(':') + 1)..], chart, title, state, false, producer);

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
        var snapshot = Snapshot([Card("1", "in-progress", "bot-k"), Card("2", "pending", null, 1) with { Lane = "root" }, Card("3", "ready", null, 1) with { Lane = "anis" }, Card("4", "pending", null, 2) with { Connections = [Join("schedule", "sch-1", 3)] }, Card("5", "pending", "bot-ghost", 2)],
            [new("1", "2", true), new("2", "4", true)]);
        var layout = LatticeChart.Layout(snapshot);
        Assert.Equal(["キロ", "anis", "root", LatticeChart.UnknownMember, LatticeChart.Unassigned], layout.Lanes.Select(lane => LatticeChart.NameOf(lane.Member)));
        Assert.Equal(["bot-k", null, null, "bot-ghost", null], layout.Lanes.Select(lane => lane.BotId));
        Assert.Equal(["bot-k", "bot-ghost"], LatticeChart.Rail(snapshot, layout).Select(item => item.BotId));
        var row = Assert.Single(LatticeChart.ConnectionRows(snapshot, Now));
        Assert.Equal(("工程4", LatticeChart.Unassigned, "3分"), (row.Headline, row.OwnerText, row.Length));
        Assert.Equal("「工程4」（担当なし）は、予定の結果が条件になっています", row.Label);
        Assert.Equal("前工程：root", LatticeChart.EdgeChip(snapshot, new("2", "4", true)));
        Assert.Equal("前工程：キロ", LatticeChart.EdgeChip(snapshot, new("1", "2", true)));
        Assert.Equal("前工程：担当なし", LatticeChart.EdgeChip(snapshot, new("4", "5", true)));
        Assert.Equal("担当 anis", LatticeChart.CardNote(snapshot.Cards[2], LatticeChart.Owner(snapshot)(snapshot.Cards[2])));
        Assert.Equal("root", LatticeChart.Detail(snapshot, "2", Now)!.Producer!.Name);
    }

    [Fact]
    public void ADetailListsTheWaitersOfOtherChartsAfterNextOldestFirstAndMissingMeansNone()
    {
        var snapshot = Snapshot([Card("1", "done", "bot-k"), Card("2", "ready", "bot-k")], [new("1", "2", true)]) with { Externals = [Other("o:a/b", "in-progress", "bot-k", "待つ工程", "A"), Other("o:c/d", "retired", "bot-k"), Other("o:e/f", "done", null, null, null)] };
        snapshot.Cards[0] = snapshot.Cards[0] with { Waiters = [new("o:e/f", null, Now.AddMinutes(-1)), new("o:a/b", "橋が出てから", Now.AddMinutes(-9)), new("o:c/d", "x", Now.AddMinutes(-20)), new("x:y/z", "不明", Now.AddMinutes(-5)), new(null, "ref無し", null)] };
        var detail = LatticeChart.Detail(snapshot, "1", Now)!;
        Assert.Equal(["工程2"], detail.Next.Select(link => link.Title));   // the other charts never join the edges
        Assert.Equal(["待つ工程", "ほかの工程表の工程", "ほかの工程表の工程"], detail.Waiting!.Select(waiter => waiter.Title));   // retired and ref-less are not sent; oldest first
        var first = detail.Waiting![0];
        Assert.Equal(("Aの工程表", "橋が出てから", new LatticeCardRef("o", "a/b"), "次の工程：「待つ工程」（Aの工程表）、" + first.StateText), (first.Chart, first.Reason, first.External, first.Label));
        Assert.Equal(("ほかの工程表の工程表", LatticeChart.ExternalUnread), (detail.Waiting![1].Chart, detail.Waiting![1].StateText));   // an externals[] entry missing: words, 読めていません
        Assert.Empty(LatticeChart.Detail(snapshot, "2", Now)!.Waiting!);
        Assert.Empty(System.Text.Json.JsonSerializer.Deserialize<LatticeSnapshot>("""{"projectId":"proj","cards":[{"id":"p1/t01"}]}""", BellApi.Json)!.Cards[0].Waiters);
        Assert.Equal(new("o:a/b", "r", null), System.Text.Json.JsonSerializer.Deserialize<LatticeSnapshot>("""{"projectId":"proj","cards":[{"id":"p1/t01","waiters":[{"ref":"o:a/b","reason":"r"}]}]}""", BellApi.Json)!.Cards[0].Waiters![0]);
    }

    [Fact]
    public void ADetailsNextLeavesOutARetiredCardButPreviousKeepsIt()
    {
        var snapshot = Snapshot([Card("1", "done", "bot-k"), Card("2", "ready", "bot-k"), Card("3", "retired", "bot-k"), Card("4", "retired", "bot-k")],
            [new("1", "2", true), new("1", "3", false), new("3", "2", false), new("2", "4", false)]);
        Assert.Equal(["工程2"], LatticeChart.Detail(snapshot, "1", Now)!.Next.Select(link => link.Title));
        Assert.Empty(LatticeChart.Detail(snapshot, "2", Now)!.Next);
        Assert.Equal(["工程1", "工程3"], LatticeChart.Detail(snapshot, "2", Now)!.Previous.Select(link => link.Title));
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
    public void ArchivedCardsLeaveTheTreeAndLanesStayInTheHistoryAndOnlyCountedCardsCount()
    {
        // 1: a finished tree (counted false); 3: hidden but its tree is open (counted true); 4 and 5 carry no counted (an older child): not archived, so counted.
        var snapshot = Snapshot([Card("1", "done", "bot-a") with { Phase = "old", Archived = true, Counted = false, DoneAt = Now.AddHours(-1) }, Card("2", "pending", "bot-k") with { Phase = "new", Parent = "3" },
            Card("3", "retired", "bot-k") with { Phase = "new", Archived = true, Counted = true, DoneAt = Now.AddHours(-30) }, Card("4", "done", "bot-a") with { Phase = "new", DoneAt = Now.AddDays(-3) }, Card("5", "done", null)])
            with { Phases = [new("old", "済んだ"), new("new", "今の")] };
        var tree = LatticeChart.Tree(snapshot, "工程表");
        Assert.Equal(["2", "4", "5"], tree.Cards.Keys.Order());
        Assert.DoesNotContain(tree.Nodes, node => node.Key == "phase:old");
        Assert.Contains(tree.Links, link => link.From == "phase:new" && link.To == "2");
        var node = tree.Nodes.ToDictionary(item => item.Key);
        Assert.Equal((3, 4), (node["root"].Done, node["root"].Total));
        Assert.Equal((2, 3), (node["phase:new"].Done, node["phase:new"].Total));
        Assert.Equal(["2", "4", "5"], LatticeChart.Layout(snapshot).Cards.Keys.Order());
        Assert.Equal((4, 3), (LatticeChart.Counts(snapshot).Total, LatticeChart.Counts(snapshot).Done));
        Assert.False((snapshot.Cards[0] with { Counted = null }).IsCounted); // an older child: an archived card does not count
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
        var snapshot = Snapshot([Card("1", "in-progress", "bot-a"), Card("2", "pending", "owner", 1) with { Connections = [Join("task", "other:p/q", 3)] }], [new("1", "2", true)]) with { Externals = [Other("other:p/q", "in-progress", "owner")] };
        var unknown = LatticeChart.Lookup(snapshot)("owner")!;
        Assert.Equal((LatticeChart.OwnerFallback, true, true, false), (unknown.Name, unknown.IsOwner, unknown.Known, unknown.CanChat));
        var named = snapshot with { OwnerName = "クオ", OwnerAvatarVersion = "v1" };
        var layout = LatticeChart.Layout(named);
        Assert.Equal(["アドミ", "クオ"], layout.Lanes.Select(lane => LatticeChart.NameOf(lane.Member)));
        Assert.Equal(["bot-a"], LatticeChart.Rail(named, layout).Select(item => item.BotId));
        var row = Assert.Single(LatticeChart.ConnectionRows(named, Now));
        Assert.Equal(("担当 クオ", false), (row.OwnerText, row.CanChat));   // the Owner makes the awaited task: no 会話を開く
        Assert.Equal("前工程：アドミ", LatticeChart.EdgeChip(named, new("1", "2", true)));
        Assert.Equal("前工程：クオ", LatticeChart.EdgeChip(named, new("2", "1", true)));
        Assert.DoesNotContain(LatticeChart.Detail(named, "2", Now)!.StateText, "owner");
    }

    [Fact]
    public void ConnectionRowsAreOldestFirstEmphasizeABlockedProducerAndNeverChatWithAnUnknownMember()
    {
        var snapshot = Snapshot([Card("1", "blocked", "bot-a", reason: "登録点が未定"), Card("2", "pending", "bot-k", 1) with { Connections = [Join("task", "o:a/b", 52)] }, Card("3", "in-progress", "bot-ghost"), Card("4", "pending", "bot-k", 1) with { Connections = [Join("task", "o:c/d", 5)] }]) with
        {
            Externals = [Other("o:a/b", "blocked", "bot-a", "題1", "A"), Other("o:c/d", "in-progress", "bot-ghost", "題2", "B")]
        };
        var rows = LatticeChart.ConnectionRows(snapshot, Now);
        Assert.Equal(["2>task:o:a/b", "4>task:o:c/d"], rows.Select(row => row.Key));
        Assert.True(rows[0].Emphasized);
        Assert.Equal("ブロック", rows[0].StateText);
        Assert.Equal("52分", rows[0].Length);
        Assert.Equal("「工程2」（担当 キロ）は、「題1」（Aの工程表）の完了が条件になっています。つくっているのはアドミ、ブロック", rows[0].Label);
        Assert.True(rows[0].CanChat);
        Assert.False(rows[1].CanChat);
        Assert.False(rows[1].Emphasized);
        Assert.Equal(LatticeChart.UnknownMember, rows[1].Producer!.Name);
        Assert.Equal("作業中", rows[1].StateText);
        Assert.Equal("blocked", LatticeChart.StateInfo("blocked").Tone);
        Assert.Equal("ブロック", LatticeChart.StateInfo("blocked").Badge);
    }

    [Fact]
    public void ConnectionsAreInTheAreaAndOnTheCardNeverALineAndOnlyOpenOnesCount()
    {
        // Wire (lattice README snapshot, a161): per card `connections` (open entries), counts and externals; an older server sends none, which reads as none.
        var snapshot = System.Text.Json.JsonSerializer.Deserialize<LatticeSnapshot>("""
            {"projectId":"proj","members":[{"botId":"bot-a","name":"アドミ"},{"botId":"bot-k","name":"キロ"}],
             "cards":[{"id":"p1/t05","title":"組み込む","state":"pending","producer":"bot-a","connections":[
                         {"kind":"task","state":"open","ref":"lattice:lattice-0990/release","reason":"0.99.0 first","since":"2026-11-11T11:30:00Z"},
                         {"kind":"task","state":"settled","ref":"gone:p/q","reason":"","since":"2026-11-11T11:00:00Z"},
                         {"kind":"schedule","ref":"sch-9","reason":"","since":"2026-11-11T11:10:00Z"}]},
                      {"id":"p1/t06","title":"配る","state":"pending","connections":[{"kind":"priority","state":"open","agent":"bot-k","reason":"すぐ動きたい","since":"2026-11-11T11:50:00Z"},{"kind":"priority","agent":"bot-new","since":"2026-11-11T11:55:00Z"},{"kind":"future","since":"2026-11-11T11:56:00Z"}]},
                      {"id":"p1/t07","title":"終わった","state":"done","connections":[]}],
             "edges":[{"from":"p1/t05","to":"p1/t06","waiting":true}],
             "externals":[{"id":"lattice:lattice-0990/release","projectId":"lattice","cardId":"lattice-0990/release","chartName":"Lattice","title":"0.99.0を出す","state":"in-progress","finished":false,"producer":"bot-k"}]}
            """, BellApi.Json)!;
        Assert.Empty(System.Text.Json.JsonSerializer.Deserialize<LatticeSnapshot>("""{"projectId":"proj","cards":[{"id":"p1/t01"}]}""", BellApi.Json)!.Cards[0].Connections);
        Assert.Equal(4, LatticeChart.Counts(snapshot).Connections);   // open task + schedule + two priorities; the settled entry and the unknown kind do not count
        var rows = LatticeChart.ConnectionRows(snapshot, Now);
        Assert.Equal(["p1/t05>schedule:sch-9", "p1/t05>task:lattice:lattice-0990/release", "p1/t06>priority:bot-k", "p1/t06>priority:bot-new"], rows.Select(row => row.Key));
        Assert.Equal("予定の結果が条件になっています", rows[0].Mark);
        Assert.Equal(("0.99.0を出す", "Latticeの工程表", "作業中", "0.99.0 first"), (rows[1].Title, rows[1].Chart, rows[1].StateText, rows[1].Reason));
        Assert.Equal(new LatticeCardRef("lattice", "lattice-0990/release"), rows[1].External);
        Assert.True(rows[1].CanChat);
        Assert.Equal("「組み込む」（担当 アドミ）は、「0.99.0を出す」（Latticeの工程表）の完了が条件になっています。つくっているのはキロ、作業中", rows[1].Label);
        Assert.Equal("キロが、着手できるようになったらすぐ動きたいと伝えています", rows[2].Mark);
        Assert.Equal("「配る」（担当なし）は、キロが、着手できるようになったらすぐ動きたいと伝えています", rows[2].Label);
        Assert.Equal(LatticeChart.UnknownMember + "が、着手できるようになったらすぐ動きたいと伝えています", rows[3].Mark);   // a Bot not in the roster
        Assert.All(rows.Where(row => row.Kind != "task"), row => { Assert.Null(row.External); Assert.False(row.CanChat); });
        // The 接続 is no line: the same-chart edge stays, nothing is drawn for a 接続; an unread task falls back to words.
        Assert.Single(LatticeChart.Tree(snapshot, "工程表").Arcs);
        var unread = LatticeChart.ConnectionRows(snapshot with { Externals = [] }, Now)[1];
        Assert.Equal(("ほかの工程表の工程", "ほかの工程表の工程表", LatticeChart.ExternalUnread), (unread.Title, unread.Chart, unread.StateText));
        Assert.Equal(new LatticeCardRef("lattice", "lattice-0990/release"), unread.External);
        // The chip 「接続 N」 and the spoken label; 前の工程 lists same-chart cards only.
        Assert.Equal("組み込む、未着手、つくっている アドミ、接続 2", LatticeChart.CardLabel(snapshot.Cards[0], LatticeChart.Owner(snapshot)(snapshot.Cards[0])));
        Assert.Equal("終わった、完了、つくっている 担当なし", LatticeChart.CardLabel(snapshot.Cards[2], null));
        Assert.Equal(["組み込む"], LatticeChart.Detail(snapshot, "p1/t06", Now)!.Previous.Select(link => link.Title));
        // Rail and highlight: アドミ owns the card with two entries, キロ makes the awaited task and asked for a 優先接続.
        Assert.Equal([1], LatticeChart.Rail(snapshot, LatticeChart.Layout(snapshot)).Select(item => item.Connections));   // アドミ's cards that have an open entry
        Assert.Equal(["p1/t05>schedule:sch-9", "p1/t05>task:lattice:lattice-0990/release"], LatticeChart.Highlight(snapshot, "bot-a").Connections.Order());
        Assert.Equal(["p1/t05>task:lattice:lattice-0990/release", "p1/t06>priority:bot-k"], LatticeChart.Highlight(snapshot, "bot-k").Connections.Order());
    }

    [Fact]
    public void TheListCardsReadConnectionsFromTheCountsAndSayTheirWord()
    {
        var list = System.Text.Json.JsonSerializer.Deserialize<LatticeChartList>("""{"charts":[{"projectId":"a","name":"A","counts":{"total":3,"done":1,"working":1,"waiting":2,"blocked":0,"connections":2}},{"projectId":"b","name":"B","counts":{"total":2,"done":0,"working":0,"waiting":1,"blocked":0}}]}""", BellApi.Json)!;
        var items = LatticeChart.ListItems(list, _ => null);
        Assert.Equal([2, 0], items.Select(item => item.Connections));   // an older server sends no connections: 0
        Assert.Equal("A、完了 1/3、接続 2", items[0].Label);
    }
    [Fact]
    public void TheListCardsCarryTheNudgeFlagOnlyWhenTheServerSaysTrue()
    {
        var list = System.Text.Json.JsonSerializer.Deserialize<LatticeChartList>("""{"charts":[{"projectId":"a","name":"A","counts":{"total":3,"done":1,"working":1,"blocked":0,"connections":2},"reminders":true},{"projectId":"b","name":"B","counts":{"total":2,"done":0,"working":0,"blocked":0},"reminders":false},{"projectId":"c","name":"C","counts":{"total":2,"done":0,"working":0,"blocked":0}}]}""", BellApi.Json)!;
        var items = LatticeChart.ListItems(list, _ => null);
        Assert.Equal([true, false, false], items.Select(item => item.Reminders));   // a missing field (older server) = no badge
        Assert.Equal("A、完了 1/3、接続 2、催促オン", items[0].Label);
        Assert.Equal("B、完了 0/2、接続 0", items[1].Label);
    }
    [Fact]
    public void ThePinnedAndTheOtherCardsShowTheNudgeBadgeOnlyOnChartsWithNudgeOn() => RunSta(() =>
    {
        using var workspace = new Workspace(origin => new BellApi(origin, new LatticeFixture("list-nudge")));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask) { Rendering = true };
        window.Sync(); Until(() => window.ListSettled);
        var cards = LogicalTree.Find<Button>(window.Content).Where(button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == "lattice-chart-card").ToList();
        bool Badge(Button card) => LogicalTree.Find<Border>(card).Any(border => System.Windows.Automation.AutomationProperties.GetAutomationId(border) == "lattice-nudge-badge");
        Assert.Equal(5, cards.Count);
        Assert.Equal(["Lattice組込", "通話ブリッジの刷新"], cards.Where(Badge).Select(card => System.Windows.Automation.AutomationProperties.GetName(card).Split('、')[0]).Order());
        window.Close();
    });
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
        // 詳細 lists the other charts' waiters under 次の工程 (oldest first), as plain rows that open that chart.
        Assert.Equal(2, LogicalTree.Find<Button>(window.Content).Count(button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == "lattice-waiter"));
        Assert.DoesNotContain(texts, text => text.Contains("bot-", StringComparison.Ordinal) || text.Contains("p1/", StringComparison.Ordinal) || text.Contains("lattice-", StringComparison.Ordinal) || text.Contains("LATTICE_", StringComparison.Ordinal) || text == "lattice");
        // The crown and 統括 only on the coordinator chart (this one is).
        Assert.Contains("統括", texts);
        // 待ち / 止め are retired words (a161): the screen says 接続 and ブロック.
        Assert.DoesNotContain(texts, text => new[] { "待ちの流れ", "待ち ", "止め一覧", "止まり", "止めた人", "が待っています" }.Any(word => text.Contains(word, StringComparison.Ordinal)));
        Assert.Contains("接続", texts);
        Assert.Contains("ブロック", texts);
        var chats = LogicalTree.Find<Button>(window.Content).Where(button => button.Content as string == "会話を開く").ToList();
        Assert.NotEmpty(chats);
        var rows = LatticeChart.ConnectionRows(chart.Feed.Snapshot!, window.Now());
        Assert.Equal(scene == "unknown", rows.Any(row => row.Producer is { Known: false } && !row.CanChat));
        Assert.Equal(scene == "unknown", texts.Contains(LatticeChart.UnknownMember));
        Assert.Equal(scene == "unverified", LogicalTree.Find<Button>(window.Content).Any(button => button.Content as string == "統括と話す"));
        chart.Stop(); window.Close();
    });

    [Fact]
    public void ADecisionNeedsAnIdAndAKnownStatusAndTheTitleIsOptional()
    {
        LatticeDecision? Of(string json) => LatticeChart.DecisionOf(System.Text.Json.JsonDocument.Parse(json).RootElement);
        Assert.Equal(new LatticeDecision("K-1", "held", "承認しますか"), Of("""{"decisionId":"K-1","status":"held","title":"承認しますか"}"""));
        Assert.Null(Of("""{"decisionId":"","status":"held","title":"t"}"""));
        Assert.Null(Of("""{"decisionId":"K-1","status":"open","title":"t"}"""));
        Assert.Equal(new LatticeDecision("K-1", "held", ""), Of("""{"decisionId":"K-1","status":"held"}"""));   // ids and state only since the /v1 close: the card still opens the decision
        Assert.Null(Of("""{"error":"NOT_FOUND"}"""));
        Assert.Null(Of("[]"));
    }

    // 詳細 of an Owner-lane card: the decision's title and state, never its id; 404 (the extension absent) leaves no block and no message.
    [Theory]
    [InlineData("owner")]
    [InlineData("owner-lanes")]
    public void AnOwnerCardsDetailShowsItsDecisionOnlyWhenTheExtensionAnswers(string scene) => RunSta(() =>
    {
        using var workspace = new Workspace(origin => new BellApi(origin, new LatticeFixture(scene)));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask) { Rendering = true };
        window.Sync(); Until(() => window.ListSettled);
        window.OpenChart("lattice"); var chart = window.Chart!;
        Until(() => chart.Feed.Snapshot is not null);
        chart.OpenDetail("p1/t11", morph: false);
        Until(() => chart.Decisions.ContainsKey("p1/t11"));
        var texts = LogicalTree.Find<TextBox>(window.Content).Select(box => box.Text).Concat(LogicalTree.Find<TextBlock>(window.Content).Select(text => text.Text)).ToList();
        Assert.Equal(scene == "owner", texts.Contains("3画面の受け取りを承認しますか（待ち）"));
        Assert.Equal(scene == "owner", texts.Contains("決裁"));
        Assert.DoesNotContain(texts, text => text.Contains("K-FIXTUR", StringComparison.Ordinal));
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

    // Owner 2026-11-14 (a74): the 接続 panel (formerly 待ちの流れ) starts folded as the right-edge handle with the 接続 count; the handle opens it, its close button folds it.
    [Fact]
    public void TheConnectionPanelStartsFoldedAndTheHandleOpensAndFoldsIt() => RunSta(() =>
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
        var rows = LatticeChart.ConnectionRows(chart.Feed.Snapshot!, window.Now()).Count;
        Assert.True(rows > 0);
        Assert.Equal($"接続を開く、{rows}件", System.Windows.Automation.AutomationProperties.GetName(Find("lattice-waits-open")));
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

    // a457: 過去ログ reads the closed trees' finished cards from the history route when it is opened (first page), then the next page at the list's end; the count needs no request.
    [Fact]
    public void HistoryReadsTheClosedTreesWhenOpenedAndMergesThePagesIntoTheList() => RunSta(() =>
    {
        using var workspace = new Workspace(origin => new BellApi(origin, new LatticeFixture("history")));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask) { Rendering = true };
        try
        {
            LatticeChartPage.View = "tree";
            window.Sync(); Until(() => window.ListSettled);
            window.OpenChart("lattice"); var chart = window.Chart!;
            Until(() => chart.Feed.Snapshot is not null);
            var root = (FrameworkElement)window.Content; root.Measure(new Size(1360, 860)); root.Arrange(new Rect(0, 0, 1360, 860)); root.UpdateLayout();
            List<string> Texts() => LogicalTree.Find<TextBlock>(window.Content).Select(text => text.Text).ToList();
            Assert.Contains("過去ログ 6", Texts());   // 3 finished cards of the snapshot + history.closed 3, before any page is read
            chart.SetView("history");
            Until(() => { root.UpdateLayout(); return LogicalTree.Find<Button>(window.Content).Count(button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == "lattice-history-row") == 6; });
            var texts = Texts();
            Assert.Contains("閉じたツリーの最後の確認", texts); Assert.Contains("旧い組込案の取り下げ", texts);   // pages 1 and 2
            Assert.DoesNotContain(LogicalTree.Find<FrameworkElement>(window.Content), element => System.Windows.Automation.AutomationProperties.GetAutomationId(element) is "lattice-history-loading" or "lattice-history-failed");
            chart.Stop();
        }
        finally { LatticeChartPage.View = "tree"; window.Close(); }
    });

    [Fact]
    public void AFailedFirstHistoryPageKeepsTheSnapshotRowsAndShowsAPlainRetryRow() => RunSta(() =>
    {
        using var workspace = new Workspace(origin => new BellApi(origin, new LatticeFixture("history-failed")));
        Await(workspace.ConnectAsync("http://localhost", listen: false));
        var window = new LatticeWindow(workspace, _ => Task.CompletedTask) { Rendering = true };
        try
        {
            LatticeChartPage.View = "tree";
            window.Sync(); Until(() => window.ListSettled);
            window.OpenChart("lattice"); var chart = window.Chart!;
            Until(() => chart.Feed.Snapshot is not null);
            var root = (FrameworkElement)window.Content; root.Measure(new Size(1360, 860)); root.Arrange(new Rect(0, 0, 1360, 860)); root.UpdateLayout();
            chart.SetView("history");
            Until(() => { root.UpdateLayout(); return LogicalTree.Find<TextBlock>(window.Content).Any(text => text.Text == "続きを読めませんでした。"); });
            Assert.Equal(3, LogicalTree.Find<Button>(window.Content).Count(button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == "lattice-history-row"));
            Assert.Contains(LogicalTree.Find<Button>(window.Content), button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == "lattice-history-retry");
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
