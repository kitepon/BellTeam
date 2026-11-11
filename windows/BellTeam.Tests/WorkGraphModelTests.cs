using System.Net;
using System.Text.Json;
using BellTeam.Core;
using static BellTeam.Core.WorkGraphModel;
using static BellTeam.Core.WorkGraphSimulation;

namespace BellTeam.Tests;

// Port of ios/BellBot/BellBotTests/WorkGraphModelTests.swift (model behaviour only). The expected numbers are the Swift ones,
// which were taken from layout-sim.mjs. Text measurement is a deterministic fake; time is passed in.
public sealed class WorkGraphModelTests
{
    private static WorkGraphModel NewModel() => new(name => name.Length * 8.0);
    private static WorkGraphNode Node(string id, string state = "working") => new(id, id, "violet", "", state, null);
    private static WorkGraphEdge Edge(string from, string to, string? id = null, string? label = "依頼") => new(id ?? $"{from}>{to}", from, from, to, label, "running");
    private static WorkGraphSnapshot Snapshot(string epoch, int version, string[] degraded, WorkGraphNode[] nodes, WorkGraphEdge[] edges) => new(epoch, version, degraded, nodes, edges);
    private static WorkGraphBatch Batch(int version, params WorkGraphChange[] changes) => new("e", version, [], changes);
    private static IEnumerable<double> Stride(double from, double to, double by) { for (var i = 0; from + i * by < to; i++) yield return from + i * by; }
    private static GraphPoint P(double x, double y) => new(x, y);
    private static GraphPoint[] Points(params (double, double)[] xy) => xy.Select(p => new GraphPoint(p.Item1, p.Item2)).ToArray();
    private static GraphPoint Center(GraphRect rect) => new(rect.MidX, rect.MidY);
    private static readonly GraphInsets NoInsets = default;
    private static void Frame(WorkGraphModel model, double now, GraphSize size) => model.Step(now, size, NoInsets);

    private static void AssertForces(GraphVector[] got, (double, double)[] want, string message = "")
    {
        Assert.Equal(want.Length, got.Length);
        for (var i = 0; i < want.Length; i++)
        {
            Assert.True(Math.Abs(got[i].Dx - want[i].Item1) <= 1e-7, $"{message} dx[{i}] {got[i].Dx} vs {want[i].Item1}");
            Assert.True(Math.Abs(got[i].Dy - want[i].Item2) <= 1e-7, $"{message} dy[{i}] {got[i].Dy} vs {want[i].Item2}");
        }
    }

    [Fact]
    public void SnapshotThenBatchAppliesInOrderAndReconnectKeepsPositions()
    {
        var model = NewModel(); var size = new GraphSize(800, 600);
        Frame(model, 0, size);
        model.Apply(Snapshot("e1", 1, [], [Node("a"), Node("b", "linked")], [Edge("a", "b")]), 0);
        Assert.Equal(WorkGraphConnection.Live, model.Connection);
        Assert.Equal(["a", "b"], model.Order.Order());
        model.Apply(new WorkGraphBatch("e1", 2, [], [new WorkGraphChange.MemberEnter(Node("c")), new WorkGraphChange.EdgeStart(Edge("c", "a")), new WorkGraphChange.EdgeEnd("a>b"), new WorkGraphChange.MemberLeave("b")]), 1);
        Assert.NotNull(model.Bodies["b"].LeavingAt); // leave stays only for the fly-away
        Assert.NotNull(model.Lines["a>b"].EndedAt);
        Assert.True(model.Lines.ContainsKey("c>a"));
        foreach (var t in Stride(1, 3, 1.0 / 60)) Frame(model, t, size);
        Assert.False(model.Bodies.ContainsKey("b")); // gone after the 0.6 s leave
        Assert.False(model.Lines.ContainsKey("a>b"));
        var kept = model.Bodies["a"].Position;
        // The snapshot after a reconnect is a diff; nodes in both keep their positions.
        model.Apply(Snapshot("e2", 1, ["queue"], [Node("a"), Node("c")], []), 3);
        Assert.Equal(kept, model.Bodies["a"].Position);
        Assert.True(model.Degraded);
        Assert.NotNull(model.Lines["c>a"].EndedAt);
    }

    [Fact]
    public void LayoutStaysInsideAndApartWithManyMembers()
    {
        var model = NewModel(); var size = new GraphSize(390, 760);
        Frame(model, 0, size);
        var ids = Enumerable.Range(0, 24).Select(i => $"m{i}").ToArray();
        model.Apply(Snapshot("e", 1, [], ids.Select(id => Node(id)).ToArray(), Enumerable.Range(0, 10).Select(i => Edge(ids[i], ids[(i * 7 + 3) % 24])).ToArray()), 0);
        foreach (var t in Stride(0, 20, 1.0 / 60)) Frame(model, t, size);
        var side = model.Side(24);
        Assert.True(side < 56, "many members shrink");
        Assert.True(side >= 36);
        var points = ids.Select(id => model.Bodies[id].Position).ToArray();
        foreach (var p in points)
        {
            Assert.True(p.X >= 24 + side / 2 - 0.5 && p.X <= size.Width - 24 - side / 2 + 0.5, p.ToString());
            Assert.True(p.Y >= 24 + side / 2 - 0.5 && p.Y <= size.Height - 24 - side / 2 + 0.5, p.ToString());
        }
        var closest = double.PositiveInfinity;
        for (var i = 0; i < points.Length; i++) for (var j = i + 1; j < points.Length; j++) closest = Math.Min(closest, Math.Sqrt(Math.Pow(points[i].X - points[j].X, 2) + Math.Pow(points[i].Y - points[j].Y, 2)));
        Assert.True(closest > side, "avatars do not overlap");
    }

    // MARK: Uncrossing swaps (expected values come from layout-sim.mjs crossings() / bestSwap())

    [Fact]
    public void CrossingsAndBestSwapMatchTheReferenceSimulation()
    {
        var square = Points((0, 0), (100, 0), (0, 100), (100, 100));
        Assert.Equal(1, Crossings(square, [(0, 3), (1, 2)]));
        Assert.Equal(1, Crossings(square, [(0, 3), (3, 0), (1, 2)])); // A to B and B to A are one segment
        var swap = BestSwap(square, [(0, 3), (1, 2)]);
        Assert.Equal((0, 1), swap!.Value.Pair);
        Assert.Equal(1, swap.Value.Gain);
        var parallel = Points((0, 0), (100, 0), (0, 50), (100, 50));
        Assert.Equal(0, Crossings(parallel, [(0, 1), (2, 3)]));
        Assert.Null(BestSwap(parallel, [(0, 1), (2, 3)])); // no crossing, no swap
        Assert.Equal(0, Crossings(square, [(0, 3), (0, 2)])); // segments sharing a node never cross
        // Five fully connected members never reach 0: five crossings stay and one trade does not remove them.
        var clique = Points((0, 0), (200, 0), (300, 150), (100, 300), (-100, 150));
        (int, int)[] all = [(0, 1), (0, 2), (0, 3), (0, 4), (1, 2), (1, 3), (1, 4), (2, 3), (2, 4), (3, 4)];
        Assert.Equal(5, Crossings(clique, all));
        Assert.Null(BestSwap(clique, all));
    }

    [Fact]
    public void BestSwapTieGoesToTheFirstPair()
    {
        // Four pairs ((0,2) (0,3) (1,2) (1,3)) each remove one; the first by index wins.
        var swap = BestSwap(Points((0, 0), (100, 100), (100, 0), (0, 100)), [(0, 1), (2, 3)]);
        Assert.Equal((0, 2), swap!.Value.Pair);
        Assert.Equal(1, swap.Value.Gain);
    }

    // MARK: Clearance (expected values come from the same functions of layout-sim.mjs; chip boxes use the Mac chipFrame with the tail)

    // layout-sim nodeBox (S 56, nameHeight 18, not grown) relative to the center. nameHeight 50 gives height 108.
    private static GraphRect SimBox(double nameHeight = 18) => new(-44.8, -28, 89.6, 58 + nameHeight);

    [Fact]
    public void SegmentHitsBoxMatchesTheReferenceSimulation()
    {
        var box = new GraphRect(0, 0, 10, 10);
        bool Hits((double, double) a, (double, double) b) => SegmentHitsBox(P(a.Item1, a.Item2), P(b.Item1, b.Item2), box);
        Assert.True(Hits((-5, 5), (15, 5)));
        Assert.False(Hits((-5, 15), (15, 15)));
        Assert.True(Hits((5, 5), (50, 50)));
        Assert.False(Hits((-5, -5), (15, -5)));
        Assert.False(Hits((11, -5), (11, 15)));
    }

    [Fact]
    public void ClearancePushesAnUnrelatedMemberOffTheLineLikeTheSimulation()
    {
        var a = P(100, 300); var b = P(500, 300);
        GraphVector[] Run(GraphPoint c, double nameHeight = 18) => Clearance([a, b, c], Enumerable.Repeat(SimBox(nameHeight), 3).ToList(), [(0, 1, (GraphSize?)null)]);
        AssertForces(Run(P(300, 320)), [(0, -0.0015), (0, -0.0015), (0, 0.003)]);
        AssertForces(Run(P(150, 320)), [(0, -0.002625), (0, -0.000375), (0, 0.003)]); // closest point left of middle (t = 0.3125)
        AssertForces(Run(P(300, 290)), [(0, -0.0015), (0, -0.0015), (0, 0.003)]); // box center exactly on the line: along the normal
        AssertForces(Run(P(300, 420)), [(0, 0), (0, 0), (0, 0)]);
        AssertForces(Run(P(300, 240)), [(0, 0), (0, 0), (0, 0)]);
        AssertForces(Run(P(300, 240), 40), [(0, 0.0015), (0, 0.0015), (0, -0.003)]); // the name height decides the box
    }

    [Fact]
    public void BlockedChipLengthensItsEdgeAndPushesMembersLikeTheSimulation()
    {
        var p = new[] { P(100, 300), P(170, 300), P(135, 250) };
        var boxes = Enumerable.Repeat(SimBox(), 3).ToList();
        var chip = new GraphSize(100, 30);
        Assert.NotNull(BlockedChip(p, boxes, 0, 1, chip));
        AssertForces(Clearance(p, boxes, [(0, 1, (GraphSize?)chip)]), [(-0.003, 0.003), (0.003, 0.003), (0, -0.006)], "ends move apart along the line, C leaves the chip");
        AssertForces(Clearance(p, boxes, [(0, 1, (GraphSize?)null)]), [(0, 0.0015), (0, 0.0015), (0, -0.003)], "no chip: line push only");
        Assert.Null(BlockedChip([P(100, 300), P(700, 300)], [SimBox(), SimBox()], 0, 1, chip)); // a long line has free slots
    }

    [Fact]
    public void EveryBlockedChipActsWhenTwoRequestsRunBetweenTheSamePair()
    {
        // The chips of A to B and B to A each push; only the larger (B to A) touches D. The line push runs once per pair.
        var p = new[] { P(100, 300), P(170, 300), P(240, 270) };
        var boxes = Enumerable.Repeat(SimBox(), 3).ToList();
        var small = new GraphSize(100, 30); var large = new GraphSize(200, 30);
        Assert.NotNull(BlockedChip(p, boxes, 0, 1, small));
        Assert.NotNull(BlockedChip(p, boxes, 1, 0, large));
        AssertForces(Clearance(p, boxes, [(0, 1, (GraphSize?)small), (1, 0, (GraphSize?)large)]),
            [(-0.007499847, 0.000021426), (0.004500153, 0.000021426), (0.002999694, -0.000042853)], "chips in both directions act");
    }

    [Fact]
    public void BestSwapCountsAnEdgeThroughAMemberAsOneCrossing()
    {
        var boxes = Enumerable.Repeat(SimBox(), 4).ToList();
        var q = Points((0, 0), (400, 0), (200, 10), (200, 200));
        Assert.Null(BestSwap(q, [(0, 1)]));
        var swap = BestSwap(q, [(0, 1)], boxes);
        Assert.Equal((0, 2), swap!.Value.Pair);
        Assert.Equal(1, swap.Value.Gain);
        var r = Points((0, 0), (400, 0), (200, -60), (200, 200));
        Assert.Null(BestSwap(r, [(0, 1)], boxes));
        var tall = BestSwap(r, [(0, 1)], Enumerable.Repeat(SimBox(50), 4).ToList());
        Assert.Equal((0, 2), tall!.Value.Pair);
        Assert.Equal(1, tall.Value.Gain);
    }

    // a = top left, b = top right, c = bottom left, d = bottom right. a>d and b>c cross.
    private static WorkGraphModel CrossedModel()
    {
        var model = NewModel();
        model.Apply(Snapshot("e", 1, [], new[] { "a", "b", "c", "d" }.Select(id => Node(id)).ToArray(), [Edge("a", "d"), Edge("b", "c")]), -10);
        foreach (var (id, spot) in new Dictionary<string, GraphPoint> { ["a"] = P(100, 100), ["b"] = P(300, 100), ["c"] = P(100, 300), ["d"] = P(300, 300) })
        {
            model.Bodies[id].Position = spot;
            model.Bodies[id].Velocity = new(spot.X / 1000, spot.Y / 1000);
            model.Bodies[id].EnteredAt = -10;
        }
        return model;
    }

    [Fact]
    public void UncrossSwapsPositionAndVelocityOfTheBestPair()
    {
        var model = CrossedModel();
        model.Uncross(0);
        Assert.Equal(P(300, 100), model.Bodies["a"].Position);
        Assert.Equal(P(100, 100), model.Bodies["b"].Position);
        Assert.Equal(new GraphVector(0.3, 0.1), model.Bodies["a"].Velocity);
        Assert.Equal(new GraphVector(0.1, 0.1), model.Bodies["b"].Velocity);
        Assert.Equal(P(100, 300), model.Bodies["c"].Position);
        Assert.Null(model.Bodies["c"].GlideFrom);
        Assert.NotNull(model.Bodies["a"].GlideFrom);
        model.Uncross(1);
        Assert.Equal(P(300, 100), model.Bodies["a"].Position); // no crossing left, no swap
    }

    [Fact]
    public void LeavingMemberTakesNoPartInUncrossing()
    {
        var model = CrossedModel();
        model.Apply(Batch(2, new WorkGraphChange.MemberLeave("b")), 0);
        model.Uncross(0);
        Assert.Equal(P(100, 100), model.Bodies["a"].Position);
        Assert.Equal(P(100, 300), model.Bodies["c"].Position);
        Assert.Null(model.Bodies["a"].GlideFrom);
    }

    [Fact]
    public void StepChecksEvery30FramesAndKeepsHeat()
    {
        var size = new GraphSize(800, 800);
        var model = CrossedModel(); var twin = NewModel();
        twin.Apply(Snapshot("e", 1, [], new[] { "a", "b", "c", "d" }.Select(id => Node(id)).ToArray(), []), -10);
        Frame(model, 0, size); Frame(twin, 0, size);
        for (var k = 1; k <= 14; k++) { Frame(model, k / 30.0, size); Frame(twin, k / 30.0, size); }
        Assert.All(model.Bodies.Values, body => Assert.Null(body.GlideFrom)); // 28 frames: no check yet
        Frame(model, 15.0 / 30, size); Frame(twin, 15.0 / 30, size);
        Assert.Equal(2, model.Bodies.Values.Count(body => body.GlideFrom is not null)); // 30 frames: exactly one pair swaps
        Assert.Equal(twin.Heat, model.Heat, 1e-12); // alpha is not changed
    }

    [Fact]
    public void SwappedMemberGlidesOver700msAndEnteringMemberDoesNot()
    {
        var model = CrossedModel();
        model.Bodies["b"].EnteredAt = 0; // an entering node does not glide: it keeps its enter interpolation toward the new place
        model.Uncross(0);
        var a = model.Bodies["a"];
        Assert.Equal(100, model.DrawPosition(a, 0).X, 1e-9); // the instant of the swap: the old drawn place
        var k = Bezier(0.5, 0.2, 0.8, 0.2, 1);
        Assert.Equal(100 + 200 * k, model.DrawPosition(a, 0.35).X, 1e-9);
        Assert.Equal(300, model.DrawPosition(a, 0.7).X, 1e-9);
        Assert.Equal(1, model.Appearance(a, 0.35).Opacity);
        Assert.Null(model.Bodies["b"].GlideFrom);
    }

    [Fact]
    public void ReduceMotionFadesOutAndInInsteadOfGliding()
    {
        var model = CrossedModel();
        model.ReduceMotion = true;
        model.Uncross(0);
        var a = model.Bodies["a"];
        Assert.Equal(P(100, 100), model.Appearance(a, 0.05).Point);
        Assert.Equal(0.5, model.Appearance(a, 0.05).Opacity, 1e-9);
        Assert.Equal(0, model.Appearance(a, 0.1).Opacity, 1e-9);
        Assert.Equal(P(300, 100), model.Appearance(a, 0.15).Point);
        Assert.Equal(0.5, model.Appearance(a, 0.15).Opacity, 1e-9);
        Assert.Equal(1, model.Appearance(a, 0.2).Opacity);
    }

    // The reference simulation (layout-sim.mjs): 8 to 30 members fill both axes to about 90 %.
    [Fact]
    public void LayoutFillsBothAxesLikeTheReferenceSimulation()
    {
        foreach (var (size, count) in new[] { (new GraphSize(1000, 668), 16), (new GraphSize(393, 688), 8), (new GraphSize(818, 1048), 30) })
        {
            var model = NewModel();
            Frame(model, 0, size);
            var ids = Enumerable.Range(0, count).Select(i => $"n{i}").ToArray();
            model.Apply(Snapshot("e", 1, [], ids.Select(id => Node(id)).ToArray(), Enumerable.Range(1, count - 1).Where(i => i % 2 == 0).Select(i => Edge(ids[i / 2], ids[i])).ToArray()), 0);
            foreach (var t in Stride(0, 15, 1.0 / 60)) Frame(model, t, size);
            var d = model.Drawable; var s = model.Side(count); var name = NameFontSize * NameHeightFactor;
            var xs = ids.Select(id => model.Bodies[id].Position.X).ToArray(); var ys = ids.Select(id => model.Bodies[id].Position.Y).ToArray();
            var fillX = (xs.Max() - xs.Min() + s) / d.Width; var fillY = (ys.Max() - ys.Min() + s + name) / d.Height;
            Assert.True(fillX is >= 0.84 and <= 0.98, $"{size} n={count} fillX={fillX}");
            Assert.True(fillY is >= 0.84 and <= 0.98, $"{size} n={count} fillY={fillY}");
        }
    }

    // MARK: Stream: epoch/version rules and connection state

    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement.Clone();
    private const string EmptySnapshot = """{"epoch":"e","version":1,"degraded":[],"nodes":[],"edges":[]}""";

    [Fact]
    public void ChangeAppliesOnlyForTheSameEpochAndTheNextVersion()
    {
        var model = NewModel();
        model.Receive("snapshot", Json(EmptySnapshot), 0);
        Assert.Equal(WorkGraphConnection.Live, model.Connection);
        model.Receive("change", Json("""{"epoch":"e","version":2,"degraded":["queue"],"changes":[{"type":"member-enter","node":{"botId":"a","name":"A","color":"rose","avatarVersion":"","state":"working","activeSince":"2026-11-08T11:00:00.000Z"}}]}"""), 1);
        Assert.True(model.Bodies.ContainsKey("a"));
        Assert.True(model.Degraded);
        foreach (var bad in new[] { """{"epoch":"e","version":4,"changes":[]}""", """{"epoch":"e","version":2,"changes":[]}""", """{"epoch":"other","version":3,"changes":[]}""" })
            Assert.Equal(StreamErrorKind.Resync, Assert.Throws<StreamException>(() => model.Receive("change", Json(bad), 2)).Kind);
        Assert.Throws<JsonException>(() => model.Receive("change", Json("""{"epoch":"e","version":"3","changes":[]}"""), 2)); // unreadable, not a gap
        model.Receive("heartbeat", Json("{}"), 2); // an unknown event is ignored
        model.Receive("snapshot", Json("""{"epoch":"e2","version":1,"degraded":[],"nodes":[],"edges":[]}"""), 3); // a new epoch starts with a snapshot
        model.Receive("change", Json("""{"epoch":"e2","version":2,"changes":[]}"""), 4);
    }

    private static WorkGraphStreamOpener Calls(params Func<CancellationToken, IAsyncEnumerable<WorkGraphEvent>>[] streams)
    {
        var index = 0;
        return (_, token) => streams[Math.Min(Interlocked.Increment(ref index) - 1, streams.Length - 1)](token);
    }

    private static async IAsyncEnumerable<WorkGraphEvent> Throw(Exception error) { await Task.Yield(); Raise(error); yield break; }
    private static void Raise(Exception error) => throw error;
    private static async IAsyncEnumerable<WorkGraphEvent> QuietAfterSnapshot([System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken token)
    {
        yield return new("snapshot", Json(EmptySnapshot));
        await Task.Delay(Timeout.Infinite, token); // then the stream stays quiet
    }

    // An old body answers 404: show "unsupported", check again after the slow interval (no fast retry), and start drawing on the swapped body's snapshot.
    [Fact]
    public async Task UnsupportedServerKeepsCheckingAndGoesLiveAfterSwap()
    {
        var delays = new List<(TimeSpan, WorkGraphConnection)>();
        WorkGraphModel? model = null;
        model = new WorkGraphModel(name => name.Length * 8.0)
        {
            Delay = async (span, token) =>
            {
                if (span == TimeSpan.FromSeconds(5)) { await Task.Delay(Timeout.Infinite, token); return; } // the silence watch never fires here
                lock (delays) delays.Add((span, model!.Connection));
            }
        };
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var run = model.RunAsync(Calls(_ => Throw(new BellApiException("HTTP 404", HttpStatusCode.NotFound)), QuietAfterSnapshot), cancel.Token);
        for (var turn = 0; turn < 500 && model.Connection != WorkGraphConnection.Live; turn++) await Task.Delay(10);
        Assert.Equal(WorkGraphConnection.Live, model.Connection);
        cancel.Cancel();
        await run;
        Assert.Equal([(TimeSpan.FromSeconds(60), WorkGraphConnection.Unsupported)], delays);
    }

    // 35 s without a byte is a drop: keep the graph, show "reconnecting" and open the stream again. A lost sign-in stops with a message.
    [Fact]
    public async Task SilenceReconnectsAndALostSignInStops()
    {
        double clock = 0; var gate = new object();
        var model = new WorkGraphModel(name => name.Length * 8.0)
        {
            Clock = () => { lock (gate) return clock; },
            Delay = async (span, token) =>
            {
                token.ThrowIfCancellationRequested();
                if (span == TimeSpan.FromSeconds(5)) { lock (gate) clock += 5; await Task.Yield(); }
            }
        };
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var opened = 0; var sawReconnecting = false;
        var run = model.RunAsync((_, token) =>
        {
            if (Interlocked.Increment(ref opened) >= 2) { sawReconnecting = model.Connection == WorkGraphConnection.Reconnecting; cancel.Cancel(); }
            return QuietAfterSnapshot(token);
        }, cancel.Token);
        await run;
        Assert.True(sawReconnecting);
        Assert.Equal(2, opened);

        var signedOut = NewModel();
        await signedOut.RunAsync((_, _) => Throw(new BellApiException("login", HttpStatusCode.Unauthorized)), CancellationToken.None);
        Assert.Equal(WorkGraphConnection.Failed, signedOut.Connection);
        Assert.Equal("ログインが必要です。", signedOut.FailedMessage);
    }

    // MARK: Taps

    private static WorkGraphModel Settled(WorkGraphNode[] nodes, WorkGraphEdge[]? edges = null, GraphSize? size = null)
    {
        var model = NewModel(); var s = size ?? new GraphSize(900, 600);
        Frame(model, 0, s);
        model.Apply(Snapshot("e", 1, [], nodes, edges ?? []), 0);
        foreach (var t in Stride(0, 10, 1.0 / 60)) Frame(model, t, s);
        return model;
    }

    // The avatar and the name tap areas are at least 44 pt square even when the drawn size is smaller.
    [Fact]
    public void TapTargetIsAtLeast44PointsAroundAvatarAndName()
    {
        Assert.Equal(new GraphRect(96, 96, 44, 44), TapTarget(new GraphRect(100, 100, 36, 36)));
        Assert.Equal(new GraphRect(0, -11.5, 123, 44), TapTarget(new GraphRect(0, 0, 123, 21)));
        Assert.Equal(new GraphRect(0, 0, 60, 60), TapTarget(new GraphRect(0, 0, 60, 60)));
        var ids = Enumerable.Range(0, 24).Select(i => $"m{i}").ToArray();
        var model = Settled(ids.Select(id => Node(id)).ToArray(), size: new GraphSize(390, 760));
        var side = model.Side(24);
        Assert.True(side < 56);
        var checkedCount = 0;
        foreach (var id in ids)
        {
            var frames = model.Frames(model.Bodies[id], 10);
            Assert.Equal(id, model.Member(Center(frames.Avatar), 10));
            Assert.Equal(id, model.Member(Center(frames.Name), 10));
            var reach = Math.Max(side, 44) / 2;
            var up = P(frames.Avatar.MidX, frames.Avatar.MidY - reach + 0.5);
            // Places where a neighbor's avatar or name overlaps are skipped (the node drawn on top wins).
            if (ids.All(other => other == id || !TapTarget(model.Frames(model.Bodies[other], 10).Avatar).InsetBy(-2, -2).Contains(up) && !TapTarget(model.Frames(model.Bodies[other], 10).Name).InsetBy(-2, -2).Contains(up)))
            {
                Assert.Equal(id, model.Member(up, 10));
                checkedCount++;
            }
        }
        Assert.True(checkedCount > 0);
    }

    // Only a release under 10 pt of movement and under 500 ms is a tap. Moving and coming back is not a tap.
    [Fact]
    public void PressCountsAsTapOnlyUnderTenPointsAndFiveHundredMilliseconds()
    {
        var press = new WorkGraphPress("a", P(50, 50), 100);
        Assert.Equal("a", press.Release(P(59.9, 50), 100.499));
        Assert.Null(press.Release(P(60, 50), 100.1)); // 10 pt counts as moved
        Assert.Null(press.Release(P(50, 50), 100.5)); // 500 ms is a long press
        var wandered = press;
        wandered.Move(P(50, 62));
        Assert.Null(wandered.Release(P(50, 50), 100.2));
        Assert.Null(new WorkGraphPress(null, default, 0).Release(default, 0.1)); // empty space opens nothing
        Assert.True(press.IsTap(P(59.9, 50), 100.499)); // line taps use the same rule
        Assert.False(press.IsTap(P(60, 50), 100.1));
        Assert.False(press.IsTap(P(50, 50), 100.5));
    }

    // After a canceled press (the record goes back to null) a new press at the same point opens the new member; a first sample that already moved 10 pt counts as moved.
    [Fact]
    public void FreshPressAtTheSamePointOpensTheNewMemberAndFirstSampleCountsMove()
    {
        var before = Settled([Node("a"), Node("b")]); var after = Settled([Node("c"), Node("d")]);
        GraphPoint? point = null;
        for (double x = 100; x < 800; x += 10)
            for (double y = 100; y < 500; y += 10)
                if (before.Member(P(x, y), 10) == "a" && after.Member(P(x, y), 10) == "c") point = P(x, y);
        var p = point!.Value;
        WorkGraphPress? press = null;
        before.UpdatePress(ref press, p, p, 10);
        Assert.Equal("a", press!.Value.BotId);
        press = null; // canceled: no release arrives, the record resets
        after.UpdatePress(ref press, p, p, 11);
        Assert.Equal("c", press!.Value.BotId);
        Assert.Equal("c", press.Value.Release(p, 11.1));
        WorkGraphPress? wide = null;
        after.UpdatePress(ref wide, p, P(p.X + 10, p.Y), 11);
        Assert.Null(wide!.Value.Release(p, 11.1)); // the first sample already moved 10 pt
    }

    // Lines, chips and empty space open nothing.
    [Fact]
    public void EdgesLabelsAndEmptySpaceDoNotOpen()
    {
        var model = Settled([Node("a"), Node("b")], [Edge("a", "b")]);
        var a = model.Frames(model.Bodies["a"], 10); var b = model.Frames(model.Bodies["b"], 10);
        Assert.True(Math.Sqrt(Math.Pow(a.Avatar.MidX - b.Avatar.MidX, 2) + Math.Pow(a.Avatar.MidY - b.Avatar.MidY, 2)) > 160, "the line's midpoint is outside both tap areas");
        Assert.Null(model.Member(P((a.Avatar.MidX + b.Avatar.MidX) / 2, (a.Avatar.MidY + b.Avatar.MidY) / 2), 10));
        Assert.Null(model.Member(P(2, 2), 10));
        Assert.Equal("a", model.Member(Center(a.Avatar), 10));
    }

    // The botId is fixed at press time. A leaving node is still tappable and the chat still opens when the member left before release.
    [Fact]
    public void PressKeepsBotIdWhileTheMemberLeaves()
    {
        var model = Settled([Node("a"), Node("b")]);
        var start = Center(model.Frames(model.Bodies["a"], 10).Avatar);
        var press = model.Press(start, 10);
        Assert.Equal("a", press.BotId);
        model.Apply(Batch(2, new WorkGraphChange.MemberLeave("a")), 10.1);
        var leaving = model.Bodies["a"];
        Assert.NotNull(leaving.LeavingAt);
        Assert.Equal("a", model.Member(Center(model.Frames(leaving, 10.15).Avatar), 10.15)); // tappable while leaving
        foreach (var t in Stride(10.1, 11.0, 1.0 / 60)) Frame(model, t, new GraphSize(900, 600));
        Assert.False(model.Bodies.ContainsKey("a"));
        Assert.Null(model.Member(start, 11));
        Assert.Equal("a", press.Release(start, 10.3));
    }

    // An icon on a line it is not part of is pushed off it.
    [Fact]
    public void NodeMovesOffALineItIsNotPartOf()
    {
        var model = NewModel(); var size = new GraphSize(900, 600);
        Frame(model, 0, size);
        model.Apply(Snapshot("e", 1, [], [Node("a"), Node("b"), Node("c")], [Edge("a", "b")]), 0);
        foreach (var t in Stride(0, 15, 1.0 / 60)) Frame(model, t, size);
        GraphPoint a = model.Bodies["a"].Position, b = model.Bodies["b"].Position, c = model.Bodies["c"].Position;
        double ex = b.X - a.X, ey = b.Y - a.Y;
        var t0 = Math.Min(1, Math.Max(0, ((c.X - a.X) * ex + (c.Y - a.Y) * ey) / (ex * ex + ey * ey)));
        var gap = Math.Sqrt(Math.Pow(c.X - (a.X + ex * t0), 2) + Math.Pow(c.Y - (a.Y + ey * t0), 2));
        Assert.True(gap > model.Side(3) / 2, "the icon does not overlap the line");
    }

    // Chips are placed in request start order: the server's startedAt, then the line id.
    [Fact]
    public void LabelOrderFollowsServerStartThenId()
    {
        var edges = Json("""[{"id":"a","from":"x","to":"y","label":"新","state":"running","startedAt":"2026-11-09T10:02:00.000Z"},{"id":"b","from":"x","to":"z","label":null,"state":"running","startedAt":"2026-11-09T10:00:00.000Z"},{"id":"c","from":"y","to":"z","label":"同時","state":"running","startedAt":"2026-11-09T10:02:00.000Z"}]""")
            .EnumerateArray().Select(WorkGraphEdge.FromJson).ToArray();
        Assert.Null(edges[1].Label);
        var lines = edges.Reverse().Select(edge => new Line(edge, 0)).ToList();
        Assert.Equal(["b", "a", "c"], LabelOrder(lines).Select(line => line.Edge.Id));
    }

    // MARK: Fork edges (README "Projection rules > Fork edge" / behavior-spec.md "Fork edges")

    private static string EdgeJson(string id, string? seat = null) =>
        "{\"id\":\"" + id + "\",\"from\":\"x\",\"to\":\"y\",\"label\":\"L\",\"state\":\"running\"" + (seat is null ? "" : ",\"seat\":" + seat) + "}";

    private static WorkGraphEdge[] DecodeEdges(string json) => Json(json).EnumerateArray().Select(WorkGraphEdge.FromJson).ToArray();

    // seat is optional. Only an object with kind "fork" and a forkId that is a string or null is a fork; any other shape is the main seat and never breaks decoding.
    [Fact]
    public void ForkSeatDecodesLeniently()
    {
        var edges = DecodeEdges("[" + string.Join(",", new[]
        {
            EdgeJson("a", """{"kind":"fork","forkId":"f-1"}"""),
            EdgeJson("b", """{"kind":"fork","forkId":null}"""),
            EdgeJson("c"),
            EdgeJson("d", "\"fork\""),
            EdgeJson("e", """{"kind":"other","forkId":"f-1"}"""),
            EdgeJson("f", """{"kind":"fork","forkId":7}"""),
            EdgeJson("g", "null"),
            EdgeJson("h", """{"forkId":"f-1"}""")
        }) + "]");
        Assert.Equal([true, true, false, false, false, false, false, false], edges.Select(edge => edge.IsFork));
        Assert.Equal("f-1", edges[0].Fork!.ForkId);
        Assert.Null(edges[1].Fork!.ForkId); // a fork with a null forkId is still a fork
        Assert.All(edges, edge => Assert.Equal("L", edge.Label));
        // The edge of edge-start / edge-update is read the same way; unknown keys are ignored.
        var change = WorkGraphChange.From(Json("{\"type\":\"edge-start\",\"extra\":1,\"edge\":" + EdgeJson("a", """{"kind":"fork","forkId":"f-1"}""") + "}"));
        Assert.True(Assert.IsType<WorkGraphChange.EdgeStart>(change).Edge.IsFork);
    }

    // A required key of the wrong type fails the read (so the stream shows "unreadable"), like the Mac Decodable.
    [Fact]
    public void RequiredKeysOfTheWrongTypeThrow()
    {
        Assert.Throws<JsonException>(() => DecodeEdges("""[{"id":1,"from":"x","to":"y","state":"running"}]"""));
        Assert.Throws<JsonException>(() => DecodeEdges("""[{"id":"a","from":"x","to":"y","state":"running","label":3}]"""));
        Assert.Single(DecodeEdges("""[{"id":"a","from":"x","to":"y","state":"running"}]"""));
    }

    // The chip text is 「分身：」 + label as one text for a fork; the main seat shows the label; a null or empty label has no chip, fork or not.
    [Fact]
    public void ForkChipTextIsOneTextAndNullLabelHasNoChip()
    {
        var fork = new WorkGraphEdge("f", "r", "a", "b", "設計を見て", "running", Fork: new WorkGraphForkSeat(null));
        var main = Edge("a", "b", label: "設計を見て");
        Assert.Equal("分身：設計を見て", fork.ChipText);
        Assert.Equal("設計を見て", main.ChipText);
        Assert.Null(new WorkGraphEdge("f", "r", "a", "b", null, "running", Fork: new WorkGraphForkSeat("x")).ChipText);
        Assert.Null(new WorkGraphEdge("f", "r", "a", "b", "", "running", Fork: new WorkGraphForkSeat("x")).ChipText);
        // The text LayoutChips places and measures is the same text. A fork edge with a null label makes no chip.
        var nullFork = new WorkGraphEdge("n", "r", "a", "c", null, "running", Fork: new WorkGraphForkSeat(null));
        var model = Entering([Node("a"), Node("b"), Node("c")], [fork, nullFork]);
        var measured = new List<string>();
        model.LayoutChips([Straight("f"), Straight("n", y: 3000)], (text, _) => { measured.Add(text); return new GraphSize(100, 26); }, null, 1);
        Assert.Equal(["分身：設計を見て"], Drawn(model).Select(chip => chip.Text));
        Assert.Equal(["分身：設計を見て"], measured);
        Assert.Null(model.Lines["n"].Chip);
    }

    // Working comes only from the server's node.state; a fork edge does not make its receiver working.
    [Fact]
    public void ForkEdgeDoesNotMakeAMemberWorking()
    {
        var model = NewModel();
        Frame(model, 0, new GraphSize(800, 600));
        var fork = new WorkGraphEdge("f", "r", "a", "b", "L", "running", Fork: new WorkGraphForkSeat("x"));
        model.Apply(Snapshot("e", 1, [], [Node("a"), Node("b", "linked")], [fork]), 0);
        Assert.True(model.Lines["f"].Edge.IsFork);
        Assert.False(model.Bodies["b"].Node.Working);
        model.Apply(Batch(2, new WorkGraphChange.EdgeUpdate(fork)), 1);
        Assert.False(model.Bodies["b"].Node.Working);
        Assert.True(model.Bodies["a"].Node.Working);
    }

    // The dash (6 pt line, 4 pt gap) is only for fork edges; the main seat is solid.
    [Fact]
    public void OnlyForkEdgesAreDashed()
    {
        Assert.Equal([6.0, 4.0], new WorkGraphEdge("f", null, "a", "b", null, "steered", Fork: new WorkGraphForkSeat(null)).BaseDash); // a steered fork has the same dash
        Assert.Empty(Edge("a", "b").BaseDash);
    }

    // MARK: Chips (behavior-spec.md "Edges": decided once per edge at the latch frame)

    private static readonly ChipMeasurer SmallChip = (_, _) => new GraphSize(100, 26);

    // A straight line outside the graph (y >= 2000): it hits no member box, so only chips constrain each other.
    private static EdgePath Straight(string id, double x = 0, double y = 2000, double span = 1000) => new(id, t => new GraphPoint(x + span * t, y));

    // Five short chips (centers x = 100, 300, 500, 700, 900; only "a" has a long line). Placed first, they block all 85 slots of a long line at the same height
    // (the gaps are narrower than a chip). Line points in the gaps (x = 200, 400) are not covered by a chip, so they can be pressed.
    private static readonly string[] BlockerIds = ["a0", "a1", "a", "a2", "a3"];
    private static EdgePath[] BlockerPaths(double y) =>
        [Straight("a0", 80, y, 40), Straight("a1", 280, y, 40), Straight("a", 300, y, 400), Straight("a2", 680, y, 40), Straight("a3", 880, y, 40)];

    // Drawable rect D of the chip tests: large enough to hold every line outside the graph (x <= 1000, y <= 4000) without sliding.
    private static readonly GraphSize BigArea = new(2100, 5100);

    private static WorkGraphModel Entering(WorkGraphNode[] nodes, WorkGraphEdge[] edges, bool reduceMotion = false, GraphSize? size = null)
    {
        var model = NewModel();
        model.ReduceMotion = reduceMotion;
        Frame(model, 0, size ?? BigArea);
        model.Apply(Snapshot("e", 1, [], nodes, edges), 0);
        return model;
    }

    private static void Lay(WorkGraphModel model, IReadOnlyList<EdgePath> paths, double now, ChipMeasurer? size = null, string? hover = null, string? peek = null, string? reveal = null) =>
        model.LayoutChips(paths, size ?? SmallChip, hover, now, peek, reveal);

    private static bool IsCentered(WorkGraphModel model, string id) => model.Lines[id].Chip?.T == 0.5 && model.Lines[id].Chip?.Side == new GraphVector(0, 0);
    private static List<PlacedChip> Drawn(WorkGraphModel model) => [.. model.Chips.Blocked, .. model.Chips.Unblocked, .. model.Chips.Above];

    // Decided at the first frame where the label is set and both ends finished entering (700 ms; Reduce Motion 200 ms). A leaving end counts as landed.
    [Fact]
    public void ChipLatchWaitsForLabelAndBothEndpointsLanding()
    {
        var model = Entering([Node("a"), Node("b")], [Edge("a", "b")]);
        Lay(model, [Straight("a>b")], 0.69);
        Assert.Null(model.Lines["a>b"].Chip); // not decided on a flying-in position
        Lay(model, [Straight("a>b")], 0.7);
        Assert.Equal(0.7, model.Lines["a>b"].Chip!.AppearAt);

        var reduced = Entering([Node("a"), Node("b")], [Edge("a", "b")], reduceMotion: true);
        Lay(reduced, [Straight("a>b")], 0.19);
        Assert.Null(reduced.Lines["a>b"].Chip);
        Lay(reduced, [Straight("a>b")], 0.2);
        Assert.Equal(0.2, reduced.Lines["a>b"].Chip!.AppearAt); // Reduce Motion: 200 ms

        // b enters at 0.6 and starts leaving at 0.65: a landed at 0.7, so the chip is decided without waiting for b's enter (until 1.3).
        var leaving = Entering([Node("a")], []);
        leaving.Apply(Batch(2, new WorkGraphChange.MemberEnter(Node("b")), new WorkGraphChange.EdgeStart(Edge("a", "b"))), 0.6);
        leaving.Apply(Batch(3, new WorkGraphChange.MemberLeave("b")), 0.65);
        Lay(leaving, [Straight("a>b")], 0.7);
        Assert.Equal(0.7, leaving.Lines["a>b"].Chip!.AppearAt);

        // While the label is null nothing is decided; the frame where edge-update brings the summary decides it.
        var pending = Entering([Node("a"), Node("b")], [Edge("a", "b", label: null)]);
        Lay(pending, [Straight("a>b")], 5);
        Assert.Null(pending.Lines["a>b"].Chip);
        Assert.Empty(Drawn(pending));
        pending.Apply(Batch(2, new WorkGraphChange.EdgeUpdate(Edge("a", "b"))), 6);
        Lay(pending, [Straight("a>b")], 6);
        Assert.Equal(6, pending.Lines["a>b"].Chip!.AppearAt);
    }

    // Chips stay for the whole life of the edge, in crowded graphs (more than 10 open edges) and on short paths (under 120 pt). Not 3 s.
    [Fact]
    public void CrowdedAndShortPathChipsStayVisibleForTheWholeEdge()
    {
        var ids = Enumerable.Range(0, 11).Select(i => $"e{i}").ToArray();
        var crowded = Entering([], ids.Select(id => Edge("x", "y", id)).ToArray());
        var paths = ids.Select((id, i) => Straight(id, y: 2000 + i * 100)).ToArray();
        foreach (var now in new[] { 1.0, 1.3, 4.5, 4.9, 12, 60 })
        {
            Lay(crowded, paths, now);
            Assert.Equal(11, crowded.Chips.Unblocked.Count);
            if (now >= 1.3) Assert.All(crowded.Chips.Unblocked, chip => Assert.Equal(1, chip.Opacity));
        }

        var shortLine = Entering([], [Edge("x", "y", "short")]);
        var path = Straight("short", span: 80);
        foreach (var now in new[] { 1.0, 1.3, 4.5, 12, 60 })
        {
            Lay(shortLine, [path], now);
            Assert.Equal(["short"], shortLine.Chips.Unblocked.Select(chip => chip.Id));
        }
        Assert.Equal(1, shortLine.Chips.Unblocked[0].Opacity);
        // Until the edge ends; then it fades out with the line over 300 ms.
        shortLine.Apply(Batch(2, new WorkGraphChange.EdgeEnd("short")), 61);
        Lay(shortLine, [path], 61.31);
        Assert.Empty(Drawn(shortLine));
    }

    // A chip with no slot waits undrawn without a time limit and appears once, over 200 ms, on the frame a slot frees.
    [Fact]
    public void ChipWithoutASlotWaitsUndrawnWithoutExpiring()
    {
        var model = Entering([], BlockerIds.Append("b").Select(id => Edge("x", "y", id)).ToArray());
        var a = BlockerPaths(2000); var b = Straight("b");
        for (var now = 1.0; now <= 60.0; now += 1) { Lay(model, [.. a, b], now); Assert.DoesNotContain(Drawn(model), chip => chip.Id == "b"); }
        Lay(model, [b], 61);
        Assert.Equal(61, model.Lines["b"].Chip!.AppearAt);
        Assert.Equal(0, model.Chips.Unblocked[0].Opacity); // fades in over 200 ms from the freeing frame
        Lay(model, [b], 61.1);
        Assert.Equal(0.5, model.Chips.Unblocked[0].Opacity, 1e-6);
    }

    // A chip stays until the edge ends. A new text only re-wraps; label back to null fades the chip over 300 ms.
    [Fact]
    public void ChipStaysRewrapsAndFadesWhenTheLabelGoesNull()
    {
        var model = Entering([], [Edge("x", "y", "s")]);
        var path = Straight("s");
        var sizes = new List<string>();
        ChipMeasurer measure = (text, _) => { sizes.Add(text); return new GraphSize(100, 26); };
        Lay(model, [path], 1, measure);
        Assert.Equal(0, model.Chips.Unblocked[0].Opacity); // first appearance fades in over 200 ms
        Lay(model, [path], 1.1, measure);
        Assert.Equal(0.5, model.Chips.Unblocked[0].Opacity, 1e-6);
        Lay(model, [Straight("s", span: 40)], 100, measure);
        Assert.Equal(1, model.Chips.Unblocked[0].Opacity); // shorter later, still there after 100 s
        model.Apply(Batch(2, new WorkGraphChange.EdgeUpdate(Edge("x", "y", "s", "新しい要約"))), 101);
        Lay(model, [path], 101, measure);
        Assert.Equal("新しい要約", model.Chips.Unblocked[0].Text);
        Assert.Equal("新しい要約", sizes[^1]); // measured again with the new text
        Assert.Equal(1, model.Chips.Unblocked[0].Opacity); // a new text does not hide it
        model.Apply(Batch(3, new WorkGraphChange.EdgeUpdate(Edge("x", "y", "s", null))), 102);
        Lay(model, [path], 102, measure);
        Lay(model, [path], 102.15, measure);
        Assert.Equal("新しい要約", model.Chips.Unblocked[0].Text); // the fade keeps the last text
        Assert.Equal(0.5, model.Chips.Unblocked[0].Opacity, 1e-6);
        Lay(model, [path], 102.31, measure);
        Assert.Empty(Drawn(model));
        // The edge end fades with the line over 300 ms.
        var ending = Entering([], [Edge("x", "y", "s")]);
        Lay(ending, [path], 1);
        ending.Apply(Batch(2, new WorkGraphChange.EdgeEnd("s")), 5);
        Lay(ending, [path], 5.15);
        Assert.Equal(0.5, ending.Chips.Unblocked[0].Opacity, 1e-6);
    }

    // A free current slot is kept; a taken one moves to the first free slot; a freed one is not returned to.
    [Fact]
    public void ChipKeepsItsSlotWhileFreeAndMovesWhenTaken()
    {
        var model = Entering([], [Edge("x", "y", "a"), Edge("x", "y", "b")]);
        var b = Straight("b");
        Lay(model, [Straight("a", y: 3000), b], 1);
        Assert.Equal(0.5, model.Lines["b"].Chip!.T);
        // "a" (placed first) arrives at b's 0.5. Above, below, right of 0.5 and 0.45 overlap a chip width (100 + 4 x 2), so the first free slot is left of 0.4.
        Lay(model, [Straight("a"), b], 2);
        Assert.Equal(0.5, model.Lines["a"].Chip!.T);
        Assert.Equal(0.4, model.Lines["b"].Chip!.T!.Value, 1e-9);
        Assert.Equal(new GraphVector(-1, 0), model.Lines["b"].Chip!.Side);
        Assert.Equal(2, model.Chips.Unblocked.Count);
        Lay(model, [Straight("a", y: 3000), b], 3);
        Assert.Equal(0.4, model.Lines["b"].Chip!.T!.Value, 1e-9); // does not move while free
        Assert.Equal(new GraphVector(-1, 0), model.Lines["b"].Chip!.Side);
    }

    // MARK: On screen (the layout-sim.mjs self-checks chipAt / intoArea / placeChips; chip boxes use the Mac chipFrame with the tail)

    // D = (24, 24, 300, 500): the size with 24 pt inside on every side.
    private static readonly GraphSize ScreenSize = new(348, 548);
    private static readonly GraphRect ScreenD = new(24, 24, 300, 500);

    private static EdgePath Seg(string id, GraphPoint a, GraphPoint b) => new(id, t => new GraphPoint(a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t));

    // A line along the left edge: the chip at t = 0.5 slides right until its box touches D's left edge; its y does not change.
    [Fact]
    public void EdgeHuggingTheLeftEdgeSlidesTheCenteredChipRightAndKeepsY()
    {
        var d = new GraphRect(0, 0, 300, 500); var point = P(10, 250);
        var frame = ChipFrame(point, new GraphSize(100, 26), within: d);
        Assert.Equal(0, frame.Area.InsetBy(-4, -4).MinX);
        Assert.Equal(250 - 26 - 7, frame.Tag.MinY);
        var model = Entering([], [Edge("x", "y", "e")], size: ScreenSize);
        Lay(model, [Seg("e", P(34, 124), P(34, 424))], 1);
        var chip = model.Chips.Unblocked[0];
        Assert.True(IsCentered(model, "e")); // the first free slot is still the centered one
        Assert.Equal(ScreenD.MinX, chip.Area.InsetBy(-4, -4).MinX, 1e-9);
        Assert.Equal(274 - 26 - 7, chip.Tag.MinY, 1e-9);
    }

    // A chip slides only when its grown box leaves D: a fitting one does not move; 1 pt out slides 1 pt back.
    [Fact]
    public void ChipSlidesOnlyWhenItsGrownBoxLeavesTheArea()
    {
        var d = new GraphRect(0, 0, 300, 500); var size = new GraphSize(100, 26);
        foreach (var side in ChipSides)
            Assert.Equal(ChipFrame(P(150, 250), size, side).Area, ChipFrame(P(150, 250), size, side, d).Area);
        // A centered chip's left edge is point.x - 50, grown 4 pt: point.x - 54. With point.x = 53 it is 1 pt out.
        var slid = ChipFrame(P(53, 250), size, within: d); var raw = ChipFrame(P(53, 250), size);
        Assert.Equal(1, slid.Tag.MinX - raw.Tag.MinX, 1e-9);
        Assert.Equal(raw.Tag.MinY, slid.Tag.MinY);
        var corner = ChipFrame(P(298, 495), size, new GraphVector(1, 1), d).Area.InsetBy(-4, -4);
        Assert.Equal(300, corner.MaxX, 1e-9);
        Assert.Equal(500, corner.MaxY, 1e-9);
        Assert.True(OnScreen(corner, d));
    }

    // The max chip width is 180 pt, or D's width minus 8 pt when that is smaller.
    [Fact]
    public void ChipMaxWidthFollowsTheDrawableRect()
    {
        Assert.Equal(180, ChipMaxWidth(new GraphRect(0, 0, 327, 600)));
        Assert.Equal(142, ChipMaxWidth(new GraphRect(0, 0, 150, 600)));
        var asked = new List<double>();
        var model = Entering([], [Edge("x", "y", "e")], size: ScreenSize);
        Lay(model, [Seg("e", P(100, 100), P(200, 400))], 1, (_, width) => { asked.Add(width); return new GraphSize(100, 26); });
        Assert.Equal([180.0], asked); // D is 300 wide
    }

    // A centered chip's tail keeps pointing at the path point after a slide, with its base kept inside the rounded corner.
    [Fact]
    public void TailStillPointsAtThePathPointAfterASlide()
    {
        var d = new GraphRect(0, 0, 300, 500); var size = new GraphSize(100, 26);
        foreach (var x in new double[] { 10, 150, 290 })
        {
            var point = P(x, 250); var f = ChipFrame(point, size, within: d);
            var tail = TailBase(point, f.Tag);
            Assert.True(tail >= f.Tag.MinX + 14);
            Assert.True(tail <= f.Tag.MaxX - 14);
            Assert.True(point.Y > f.Tag.MaxY); // the chip is above the point and has a tail
            Assert.True(f.Area.Contains(P(point.X, point.Y - 0.5))); // the tail tip (the path point) is inside the box
            Assert.True(f.Area.Contains(P(tail, f.Tag.MaxY + 0.5))); // the base is on the chip's bottom edge
            Assert.True(OnScreen(f.Area.InsetBy(-4, -4), d));
        }
        var left = ChipFrame(P(10, 250), size, within: d);
        Assert.Equal(left.Tag.MinX + 14, TailBase(P(10, 250), left.Tag)); // the point is outside the chip: the base stops inside the edge
        Assert.Equal(150, TailBase(P(150, 250), ChipFrame(P(150, 250), size).Tag)); // an unslid chip: right above the point
    }

    private static readonly ChipMeasurer TallChip = (_, _) => new GraphSize(120, 600);

    // Oversize chip: no free slot. A waiting one is not drawn; one that grew taller stays blocked in the same column with its grown top on D's top.
    [Fact]
    public void OversizeChipHasNoFreeSlotAndStaysBlockedAtTheTopOfTheArea()
    {
        var path = Seg("o", P(100, 100), P(200, 400));
        var waiting = Entering([], [Edge("x", "y", "o")], size: ScreenSize);
        Lay(waiting, [path], 1, TallChip);
        Assert.Null(waiting.Lines["o"].Chip!.T); // takes no place, waits
        Assert.Empty(Drawn(waiting));

        var model = Entering([], [Edge("x", "y", "o")], size: ScreenSize);
        Lay(model, [path], 1);
        Assert.Equal(["o"], model.Chips.Unblocked.Select(chip => chip.Id));
        Lay(model, [path], 2, TallChip);
        Assert.Equal(["o"], model.Chips.Blocked.Select(chip => chip.Id)); // a drawn chip is not hidden
        var chip = model.Chips.Blocked[0];
        Assert.Equal(ScreenD.MinY, chip.Area.InsetBy(-4, -4).MinY, 1e-9);
        Assert.Equal(150 - 60, chip.Tag.MinX, 1e-9);
        Assert.Equal(600, chip.Tag.Height);
        Assert.Equal(0, chip.Content); // a blocked chip draws its whole text
        Assert.Single(Drawn(model));
    }

    // The Oversize peek is D tall, opens at the first line and scrolls to the last; letting go starts at line 1 again.
    [Fact]
    public void OversizePeekIsAreaTallOpensAtTheFirstLineAndScrollsToTheLast()
    {
        var path = Seg("o", P(100, 100), P(200, 400));
        var model = Entering([], [Edge("x", "y", "o")], size: ScreenSize);
        Lay(model, [path], 1, TallChip);
        Lay(model, [path], 1.1, TallChip, peek: "o");
        var peek = model.Chips.Above[0];
        Assert.Equal(ScreenD.Height - 8, peek.Tag.Height);
        Assert.Equal(ScreenD.MinY, peek.Area.InsetBy(-4, -4).MinY, 1e-9);
        Assert.Equal(ScreenD.Height, peek.Area.InsetBy(-4, -4).Height, 1e-9); // exactly D tall
        Assert.Equal(150 - 60, peek.Tag.MinX, 1e-9);
        Assert.Equal(600, peek.Content);
        Assert.Equal(0, peek.Scroll); // opens at line 1
        var inside = Center(peek.Area);
        Assert.Equal(new Hit(HitKind.Chip, "o"), model.HitTest(inside, 1.1));
        Assert.True(model.ScrollPeek(100, inside));
        Assert.Equal(100, model.Chips.Above[0].Scroll);
        Assert.True(model.ScrollPeek(100_000, inside));
        Assert.Equal(600 - peek.Tag.Height, model.Chips.Above[0].Scroll); // the last line shows, no further
        Assert.True(model.ScrollPeek(-100_000, inside));
        Assert.Equal(0, model.Chips.Above[0].Scroll);
        Assert.False(model.ScrollPeek(10, P(5, 5))); // outside the box nothing scrolls
        model.ScrollPeek(40, inside);
        Lay(model, [path], 1.2, TallChip, peek: "o");
        Assert.Equal(40, model.Chips.Above[0].Scroll); // the scroll is kept while open
        Lay(model, [path], 1.3, TallChip);
        Assert.Empty(model.Chips.Above);
        Assert.Empty(model.PeekScroll);
        Lay(model, [path], 1.4, TallChip, peek: "o");
        Assert.Equal(0, model.Chips.Above[0].Scroll); // reopened at line 1
        // A chip that is not Oversize does not scroll.
        var small = Entering([], [Edge("x", "y", "s")], size: ScreenSize);
        Lay(small, [Seg("s", P(100, 100), P(200, 400))], 1, hover: "s");
        Assert.Equal(0, small.Chips.Above[0].Content);
        Assert.False(small.ScrollPeek(10, Center(small.Chips.Above[0].Area)));
    }

    // Drag inside the open Oversize box scrolls it (a press that started on a member goes to the member and does not scroll).
    [Fact]
    public void DragInsideTheOversizePeekScrollsButAPressOnAMemberDoesNot()
    {
        var taller = new ChipMeasurer((_, _) => new GraphSize(120, 900)); // taller than D (652)
        var size = new GraphSize(900, 700);
        var model = Entering([Node("a")], [Edge("x", "y", "o")], size: size);
        foreach (var t in Stride(0, 20, 1.0 / 30)) Frame(model, t, size);
        var avatar = model.Frames(model.Bodies["a"], 20).Avatar; var d = model.Drawable;
        var path = Seg("o", P(avatar.MidX + 5, d.MinY + 100), P(avatar.MidX + 5, d.MinY + 300));
        Lay(model, [path], 20, taller, peek: "o");
        var peek = model.Chips.Above[0];
        Assert.True(peek.Area.Contains(Center(avatar)));
        var free = P(peek.Area.MinX + 3, d.MaxY - 40);
        Assert.Null(model.Member(free, 20));
        WorkGraphPress? drag = null;
        model.UpdatePress(ref drag, free, free, 20, scrollsPeek: true);
        model.UpdatePress(ref drag, free, P(free.X, free.Y - 30), 20.1, scrollsPeek: true);
        Assert.Equal(30, model.Chips.Above[0].Scroll); // the text follows the finger up
        model.UpdatePress(ref drag, free, P(free.X, free.Y - 10), 20.2, scrollsPeek: true);
        Assert.Equal(10, model.Chips.Above[0].Scroll); // moving back moves the text back
        Assert.True(drag!.Value.Moved); // 10 pt or more is not a tap (the open box does not close)
        var onMember = Center(avatar);
        WorkGraphPress? press = null;
        model.UpdatePress(ref press, onMember, onMember, 21, scrollsPeek: true);
        model.UpdatePress(ref press, onMember, P(onMember.X, onMember.Y - 50), 21.1, scrollsPeek: true);
        Assert.Equal("a", press!.Value.BotId);
        Assert.Equal(10, model.Chips.Above[0].Scroll); // a press that goes to a member does not scroll
        Assert.Equal(new Hit(HitKind.Member, "a"), model.HitTest(onMember, 21));
    }

    // MARK: Chip spots (expected values from layout-sim.mjs chipSpots with the Mac chipFrame, a centered chip including its tail)

    // 85 slots: 17 positions nearest the middle first, five sides each (centered, above, below, left, right).
    [Fact]
    public void ChipSpotsAreSeventeenPositionsTimesFiveSidesLikeTheReferenceSimulation()
    {
        var spots = ChipSpots;
        Assert.Equal(85, spots.Length);
        Assert.Equal([0.5, 0.5, 0.45, 0.55, 0.9], new[] { spots[0].T, spots[1].T, spots[5].T, spots[10].T, spots[^1].T });
        Assert.Equal(new GraphVector(0, -1), spots[1].Side); // the second is above
        Assert.Equal([new GraphVector(0, 0), new GraphVector(0, -1), new GraphVector(0, 1), new GraphVector(-1, 0), new GraphVector(1, 0)], spots.Take(5).Select(spot => spot.Side));
        Assert.Equal([0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75, 0.2, 0.8, 0.15, 0.85, 0.1, 0.9], Enumerable.Range(0, 17).Select(i => spots[i * 5].T));
    }

    // The side offsets are chipBox's: half the chip size toward the screen direction from the point (above: the chip's bottom edge is the point).
    [Fact]
    public void ChipFrameSideOffsetMatchesTheReferenceSimulation()
    {
        var point = P(50, 0); var size = new GraphSize(120, 22);
        GraphRect Area(double dx, double dy) => ChipFrame(point, size, new GraphVector(dx, dy)).Area;
        Assert.Equal(4, Area(0, -1).InsetBy(-4, -4).MaxY);
        Assert.Equal(50 - 120 / 2 - 4, Area(0, -1).InsetBy(-4, -4).MinX);
        Assert.Equal(0, Area(0, 1).MinY); // below: top edge on the point
        Assert.Equal(50, Area(-1, 0).MaxX); // left: right edge on the point
        Assert.Equal(50, Area(1, 0).MinX); // right: left edge on the point
        Assert.Equal(0, Area(-1, 0).MidY); // left/right: centered on the point's height
        Assert.Equal(new GraphRect(-10, -29, 120, 29), ChipFrame(point, size).Area); // centered: floats above the line with a tail
    }

    // Where a chip goes when an earlier chip takes the center: the layout-sim procedure with a 100x26 chip grown by 4 pt.
    [Fact]
    public void ChipGoesToTheSideTheReferenceSimulationPicksWhenTheCenterIsTaken()
    {
        (double T, GraphVector Side) Place(double dy)
        {
            var model = Entering([], [Edge("x", "y", "a"), Edge("x", "y", "b")]);
            Lay(model, [Straight("a", 0, 2000), Straight("b", 0, 2000 + dy)], 1);
            var chip = model.Lines["b"].Chip!;
            return (chip.T!.Value, chip.Side);
        }
        // a's center is at (500, 2000); b is a line of the same width shifted by dy.
        foreach (var (dy, t, side) in new[] { (-60.0, 0.5, new GraphVector(0, 0)), (-20, 0.4, new GraphVector(-1, 0)), (0, 0.4, new GraphVector(-1, 0)), (20, 0.5, new GraphVector(0, 1)), (32, 0.5, new GraphVector(0, -1)), (50, 0.5, new GraphVector(0, 0)) })
        {
            var got = Place(dy);
            Assert.Equal(t, got.T, 1e-9);
            Assert.Equal(side, got.Side);
        }
    }

    // Five chips on one line spread: center, left 0.4, right 0.6, left 0.25, right 0.75 (the simulation's order).
    [Fact]
    public void ChipsOnOneLineSpreadAlongItLikeTheReferenceSimulation()
    {
        string[] ids = ["a", "b", "c", "d", "e"];
        var model = Entering([], ids.Select(id => Edge("x", "y", id)).ToArray());
        Lay(model, ids.Select(id => Straight(id)).ToArray(), 1);
        var got = ids.Select(id => { var chip = model.Lines[id].Chip!; return new[] { chip.T!.Value, chip.Side.Dx, chip.Side.Dy }; }).ToArray();
        Assert.Equal([[0.5, 0, 0], [0.4, -1, 0], [0.6, 1, 0], [0.25, -1, 0], [0.75, 1, 0]], got);
        Assert.Empty(model.Chips.Blocked);
    }

    // A chip never covers a drawn name or a member box (each grown by 4 pt).
    [Fact]
    public void ChipNeverCoversADrawnNameOrAnAvatar()
    {
        var model = Settled([Node("a")]);
        var body = model.Bodies["a"];
        var frames = model.Frames(body, 10); var name = model.NameText(body, 10)!.Value;
        model.Apply(Batch(2, new WorkGraphChange.EdgeStart(Edge("x", "y", "n"))), 10);
        // A tail tip 42 pt below the avatar puts the 0.5 chip (26 high, 7 float) onto the name while staying outside the avatar's 4 pt.
        Lay(model, [Straight("n", name.MidX - 500, frames.Avatar.MaxY + 42)], 10);
        var chip = model.Chips.Unblocked[0];
        Assert.False(IsCentered(model, "n")); // 0.5 is blocked by the name
        Assert.False(chip.Area.InsetBy(-4, -4).Intersects(name));
        Assert.False(chip.Area.InsetBy(-4, -4).Intersects(frames.Avatar));
        // A line over the avatar still gets a place that avoids it.
        var model2 = Settled([Node("a")]);
        var avatar = model2.Frames(model2.Bodies["a"], 10).Avatar;
        model2.Apply(Batch(2, new WorkGraphChange.EdgeStart(Edge("x", "y", "n"))), 10);
        Lay(model2, [Straight("n", avatar.MidX - 500, avatar.MaxY)], 10);
        Assert.False(IsCentered(model2, "n"));
        Assert.False(model2.Chips.Unblocked[0].Area.InsetBy(-4, -4).Intersects(avatar));
    }

    // A name that is not visible (opacity 0) is not an obstacle; once visible it blocks and the chip moves to the first free slot.
    [Fact]
    public void AHiddenNameIsNotAnObstacle()
    {
        var model = Entering([Node("a")], [Edge("x", "y", "n")], reduceMotion: true);
        var body = model.Bodies["a"];
        Assert.Null(model.NameText(body, 0)); // a Reduce Motion enter starts at opacity 0
        var frames = model.Frames(body, 0); var name = model.Frames(body, 0.2).Name;
        var path = Straight("n", name.MidX - 500, frames.Avatar.MaxY + 42);
        Lay(model, [path], 0);
        Assert.Equal(0.5, model.Lines["n"].Chip!.T); // placed even over the hidden name
        Lay(model, [path], 0.2);
        Assert.NotNull(model.NameText(body, 0.2));
        Assert.False(IsCentered(model, "n")); // the name shows: blocked, so it moves
    }

    // 'a' has a long name; b sits at its lower right (and c at its upper right) so the 4 pt grown box meets the name's text.
    private static WorkGraphModel NameCrowd(bool above)
    {
        var longName = new WorkGraphNode("a", new string('あ', 16), "violet", "", "working", null);
        var model = Settled(above ? [longName, Node("b"), Node("c")] : [longName, Node("b")]);
        var s = model.Side(model.LiveCount); const double x = 450;
        model.Bodies["a"].Position = P(x, 300);
        model.Bodies["b"].Position = P(x + 90, 308 + s);
        if (above) model.Bodies["c"].Position = P(x + 90, 292 - s);
        return model;
    }

    // A name whose text below meets another avatar moves above its own avatar; if above is free it is not hidden.
    [Fact]
    public void ANameMovesAboveItsAvatarWhenItOverlapsAnotherDiscBelow()
    {
        var model = NameCrowd(false);
        var a = model.Bodies["a"]; var frames = model.Frames(a, 10);
        Assert.True(frames.Name.MaxY <= frames.Avatar.MinY, "the name is above the face");
        Assert.False(model.NameHidden(a, 10));
        Assert.NotNull(model.NameText(a, 10));
        var b = model.Bodies["b"]; var bf = model.Frames(b, 10);
        Assert.True(bf.Name.MinY >= bf.Avatar.MaxY); // b's name stays below (nothing under it)
        Assert.Equal("a", model.Member(Center(frames.Name), 10)); // the name above is also a tap area
    }

    // Both places overlapping hides the name: not an obstacle, its slot (below) goes to the member, and it shows only while revealed.
    [Fact]
    public void ANameWithBothPlacesOverlappingIsHiddenUntilRevealed()
    {
        var model = NameCrowd(true);
        var a = model.Bodies["a"]; var frames = model.Frames(a, 10);
        Assert.True(model.NameHidden(a, 10));
        Assert.Null(model.NameText(a, 10)); // a hidden name is not an obstacle
        Assert.True(frames.Name.MinY >= frames.Avatar.MaxY, "the slot stays below");
        var spot = P(frames.Avatar.MidX, frames.Avatar.MaxY + 8);
        Assert.Equal(new Hit(HitKind.Member, "a"), model.HitTest(spot, 10));
        Assert.Equal("a", model.Press(spot, 10).BotId);
        model.Apply(Batch(2, new WorkGraphChange.EdgeStart(Edge("x", "y", "n"))), 10);
        var path = Straight("n", frames.Avatar.MidX - 45 - 500, frames.Avatar.MaxY + 42);
        Lay(model, [path], 10);
        Assert.Equal(0.5, model.Lines["n"].Chip!.T); // placed over the hidden name too
        // While pointed at (or touched) the name shows and the chip steps aside; letting go hides it again.
        Lay(model, [path], 10.1, reveal: "a");
        Assert.False(model.NameHidden(a, 10.1));
        Assert.NotNull(model.NameText(a, 10.1));
        Assert.False(IsCentered(model, "n"));
        Lay(model, [path], 10.2, reveal: "b");
        Assert.True(model.NameHidden(a, 10.2)); // pointing at another member does not show it
        Lay(model, [path], 10.3);
        Assert.True(model.NameHidden(a, 10.3));
    }

    // A leaving member's disc and name are not chip obstacles.
    [Fact]
    public void ALeavingMembersDiscAndNameAreNotChipObstacles()
    {
        foreach (var (leaving, expected) in new[] { (false, false), (true, true) })
        {
            var model = Settled([Node("b")]);
            var frames = model.Frames(model.Bodies["b"], 10);
            if (leaving) model.Apply(Batch(2, new WorkGraphChange.MemberLeave("b")), 10);
            model.Apply(Batch(leaving ? 3 : 2, new WorkGraphChange.EdgeStart(Edge("x", "y", "disc")), new WorkGraphChange.EdgeStart(Edge("x", "y", "name"))), 10);
            var disc = Straight("disc", frames.Avatar.MidX - 500, frames.Avatar.MidY);
            var name = Straight("name", frames.Name.MidX - 500, frames.Avatar.MaxY + 42);
            Lay(model, [disc, name], 10);
            Assert.Equal(expected, IsCentered(model, "disc"));
            Assert.Equal(expected, IsCentered(model, "name"));
        }
    }

    // No free slot: blocked at the current spot, in the layer just above lines and below members, and unblocked again when a slot frees.
    // Hit order: member (44 pt) > unblocked chip > blocked chip > line.
    [Fact]
    public void NoFreeSlotMarksTheChipBlockedAndHitOrderFollowsTheLayers()
    {
        var model = Entering([], BlockerIds.Append("b").Select(id => Edge("x", "y", id)).ToArray());
        var b = Straight("b", y: 2003);
        Lay(model, [.. BlockerPaths(3000), b], 1);
        Assert.Equal(0.5, model.Lines["b"].Chip!.T);
        Lay(model, [.. BlockerPaths(2000), b], 2);
        Assert.Equal(BlockerIds.Order(), model.Chips.Unblocked.Select(chip => chip.Id).Order());
        Assert.Equal(["b"], model.Chips.Blocked.Select(chip => chip.Id));
        Assert.Equal(0.5, model.Lines["b"].Chip!.T); // the current spot stays
        Assert.Equal(default, model.Lines["b"].Chip!.Side);
        Assert.Equal(1, model.Chips.Blocked[0].Opacity); // blocked is not hidden
        var chipA = model.Chips.Unblocked.First(chip => chip.Id == "a"); var chipB = model.Chips.Blocked[0];
        Assert.Equal(new Hit(HitKind.Chip, "a"), model.HitTest(Center(chipA.Area), 2)); // an unblocked chip is above a blocked one
        Assert.Equal(new Hit(HitKind.Chip, "b"), model.HitTest(P(chipB.Area.MidX, chipA.Area.MaxY + 2), 2));
        Assert.Equal(new Hit(HitKind.Edge, "a"), model.HitTest(P(400, 2000), 2));
        Assert.Null(model.HitTest(P(100, 1500), 2));
        Lay(model, [.. BlockerPaths(3000), b], 3);
        Assert.Equal(BlockerIds.Append("b").Order(), model.Chips.Unblocked.Select(chip => chip.Id).Order()); // a free slot unblocks it
        Assert.Empty(model.Chips.Blocked);
    }

    // An earlier chip is an obstacle for later chips even when blocked. c's center meets only b, not a, so c would not move if b were not an obstacle.
    [Fact]
    public void ANewerChipDoesNotTakeASlotOverlappingAnEarlierBlockedChip()
    {
        var model = Entering([], BlockerIds.Concat(["b", "c"]).Select(id => Edge("x", "y", id)).ToArray());
        var b = Straight("b", y: 2003);
        Lay(model, [.. BlockerPaths(3000), b, Straight("c", y: 4000)], 1);
        Lay(model, [.. BlockerPaths(2000), b, Straight("c", y: 2038)], 2);
        Assert.Equal(["b"], model.Chips.Blocked.Select(chip => chip.Id));
        Assert.False(IsCentered(model, "c")); // c's center overlaps the blocked b, so it moves
        var bArea = model.Chips.Blocked[0].Area; var cArea = model.Chips.Unblocked.First(chip => chip.Id == "c").Area;
        Assert.False(cArea.InsetBy(-4, -4).Intersects(bArea));
    }

    // A press that starts inside a member goes to the member even with a chip drawn above it.
    [Fact]
    public void AMemberWinsOverAChipDrawnAboveIt()
    {
        var model = Settled([Node("a")]);
        var avatar = model.Frames(model.Bodies["a"], 10).Avatar;
        model.Apply(Batch(2, new WorkGraphChange.EdgeStart(Edge("x", "y", "c"))), 10);
        // Placed far away first, then the line passes through the avatar and no slot is free (blocked); pointing at it brings it to the top. The line is short (20 pt), so every side meets the face.
        var path = Straight("c", avatar.MidX - 10, avatar.MidY + 20, 20);
        Lay(model, [Straight("c", avatar.MidX - 10, 3000, 20)], 10);
        Lay(model, [path], 14);
        Assert.Equal(["c"], model.Chips.Blocked.Select(chip => chip.Id));
        Lay(model, [path], 14.1, hover: "c");
        var chip = model.Chips.Above[0];
        Assert.True(chip.Area.Contains(Center(avatar)));
        Assert.Equal(new Hit(HitKind.Member, "a"), model.HitTest(Center(avatar), 14.1));
        Assert.Equal(new Hit(HitKind.Chip, "c"), model.HitTest(P(chip.Area.MinX + 2, chip.Area.MinY + 2), 14.1));
    }

    // The five blockers (BlockerPaths) block every slot of "b", so "b" waits undrawn. Points not covered by a chip (b's line at x = 200, a's at x = 400) can be pressed.
    private static (WorkGraphModel Model, EdgePath[] All, EdgePath B, GraphPoint OnB, GraphPoint OnA) WaitingChipModel()
    {
        var model = Entering([], BlockerIds.Append("b").Select(id => Edge("x", "y", id)).ToArray());
        var b = Straight("b"); var all = BlockerPaths(2000).Append(b).ToArray();
        Lay(model, all, 1);
        return (model, all, b, P(200, 2000), P(400, 2000));
    }

    // A waiting chip shows at t = 0.5 on top when its line is tapped (iPhone-style), until the next tap elsewhere.
    [Fact]
    public void TappingTheLineOfAWaitingChipRevealsItAtHalfOnTopUntilTheNextTap()
    {
        var (model, all, b, onB, _) = WaitingChipModel();
        Assert.Null(model.Lines["b"].Chip!.T); // waiting
        Assert.Equal(new Hit(HitKind.Edge, "b"), model.HitTest(onB, 1));
        model.Tap(onB, 1);
        Assert.Equal("b", model.TappedEdge);
        Lay(model, all, 1.1, peek: model.TappedEdge);
        var shown = model.Chips.Above[0];
        Assert.Equal("b", shown.Id);
        Assert.Equal(1, shown.Opacity);
        Assert.Equal(b.Point(0.5), shown.Anchor); // t = 0.5
        Assert.Null(model.Lines["b"].Chip!.T); // it takes no place
        Lay(model, all, 5, peek: model.TappedEdge); // still shown on the next frames
        Assert.Equal(["b"], model.Chips.Above.Select(chip => chip.Id));
        model.Tap(P(100, 1500), 5); // a tap on empty space goes back to waiting
        Assert.Null(model.TappedEdge);
        Lay(model, all, 5.1, peek: model.TappedEdge);
        Assert.DoesNotContain(Drawn(model), chip => chip.Id == "b");
        Assert.Null(model.Lines["b"].Chip!.T);
    }

    // Tapping another line moves the reveal there; tapping the shown chip itself does not change it.
    [Fact]
    public void TappingAnotherLineMovesTheReveal()
    {
        var (model, all, _, onB, onA) = WaitingChipModel();
        model.Tap(onB, 1);
        Lay(model, all, 1.1, peek: model.TappedEdge);
        var chip = model.Chips.Above[0];
        model.Tap(Center(chip.Area), 1.2);
        Assert.Equal("b", model.TappedEdge); // pressing the shown chip does not clear it
        model.Tap(onA, 1.3);
        Assert.Equal("a", model.TappedEdge);
        Lay(model, all, 1.4, peek: model.TappedEdge);
        Assert.DoesNotContain(Drawn(model), chip => chip.Id == "b"); // b waits again
    }

    // A member tap is not stolen by a line and clears the reveal.
    [Fact]
    public void ANodeTapIsNotStolenByTheLineAndClearsTheReveal()
    {
        var model = Settled([Node("a")]);
        var avatar = model.Frames(model.Bodies["a"], 10).Avatar;
        model.Apply(Batch(2, new WorkGraphChange.EdgeStart(Edge("x", "y", "c"))), 10);
        var through = Straight("c", avatar.MidX - 50, avatar.MidY, 100);
        Lay(model, [through], 10);
        var center = Center(avatar);
        Assert.Equal(new Hit(HitKind.Member, "a"), model.HitTest(center, 10)); // the member is above the line
        model.Tap(through.Point(1), 10); // the chip sits left of the face, so the right end is not covered
        Assert.Equal("c", model.TappedEdge);
        model.Tap(center, 10);
        Assert.Null(model.TappedEdge);
    }

    // A closed edge's line cannot be pressed and shows no chip.
    [Fact]
    public void AClosedEdgeIsNotRevealed()
    {
        var (model, all, _, onB, _) = WaitingChipModel();
        model.Apply(Batch(2, new WorkGraphChange.EdgeEnd("b")), 2);
        Lay(model, all, 2.1);
        Assert.Null(model.HitTest(onB, 2.1));
        model.Tap(onB, 2.1);
        Assert.Null(model.TappedEdge);
        Lay(model, all, 2.2, peek: "b");
        Assert.DoesNotContain(Drawn(model), chip => chip.Id == "b");
    }

    // Pointer over a waiting chip's line (hit = edge) shows it; moving away puts it back.
    [Fact]
    public void HoveringTheLineOfAWaitingChipRevealsIt()
    {
        var (model, all, _, onB, _) = WaitingChipModel();
        var hit = model.HitTest(onB, 1);
        Assert.Equal(HitKind.Edge, hit!.Value.Kind);
        var id = hit.Value.Id;
        Lay(model, all, 1.1, hover: id, peek: id);
        var chip = model.Chips.Above[0];
        Assert.Equal("b", chip.Id);
        Assert.Equal(new Hit(HitKind.Chip, "b"), model.HitTest(Center(chip.Area), 1.1)); // hover continues over the chip
        Lay(model, all, 1.2);
        Assert.DoesNotContain(Drawn(model), chip => chip.Id == "b");
    }

    // A long press (500 ms or more) never opens; a press on a member shows no chip.
    [Fact]
    public void LongPressOnAMemberNeverOpensAndRevealsNoChip()
    {
        var model = Settled([Node("a"), Node("b")], [Edge("a", "b")]);
        var point = Center(model.Frames(model.Bodies["a"], 10).Avatar);
        var press = model.Press(point, 10);
        Assert.Equal(new Hit(HitKind.Member, "a"), model.HitTest(point, 10.45));
        Assert.Equal("a", press.Release(point, 10.45)); // 400 to 500 ms is still a tap
        Assert.Null(press.Release(point, 10.5)); // from 500 ms it is a long press
        Assert.Null(press.Release(point, 12));
    }

    [Fact]
    public void DecodesContractChangesAndHelpers()
    {
        var batch = WorkGraphBatch.From(Json("""{"epoch":"e","version":2,"degraded":[],"changes":[{"type":"member-enter","node":{"botId":"a","name":"A","color":"rose","avatarVersion":"","state":"working","activeSince":"2026-11-08T11:00:00.000Z"}},{"type":"edge-end","edgeId":"x"},{"type":"member-leave","botId":"b"},{"type":"future-kind"}]}"""));
        Assert.Equal(4, batch.Changes.Length);
        Assert.True(Assert.IsType<WorkGraphChange.MemberEnter>(batch.Changes[0]).Node.Working);
        Assert.IsType<WorkGraphChange.Unknown>(batch.Changes[3]); // an unknown kind is ignored
        Assert.Equal(0xe40c292cu, Fnv1a("a"));
        Assert.Equal(0, Bezier(0, 0.2, 0.8, 0.2, 1), 0.001);
        Assert.Equal(1, Bezier(1, 0.2, 0.8, 0.2, 1), 0.001);
        Assert.Equal(0.25 + 0.65, Blink(0.4, 0), 0.001); // maximum at a quarter of the 1.6 s period
        Assert.Equal(10.5, WorkGraphModel.ParseTime("1970-01-01T00:00:10.500Z")!.Value, 1e-9);
        Assert.Null(WorkGraphModel.ParseTime("not a time"));
    }
}
