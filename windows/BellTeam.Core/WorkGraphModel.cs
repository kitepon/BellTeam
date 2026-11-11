using System.Globalization;
using System.Net;
using System.Text.Json;
using static BellTeam.Core.WorkGraphSimulation;

namespace BellTeam.Core;

// 相関図 (work graph) data contract (docs/architecture/modules/work-graph/README.md) and motion (behavior-spec.md).
// Port of Mac Core/WorkGraphModel.swift. Unknown keys are ignored. Only `seat` is read leniently (a wrong type means no seat); any other key of the wrong type throws JsonException.

public sealed record WorkGraphNode(string BotId, string Name, string Color, string? AvatarVersion, string State, string? ActiveSince)
{
    public bool Working => State == "working";

    public static WorkGraphNode From(JsonElement json) => new(WorkGraphJson.Required(json, "botId"), WorkGraphJson.Required(json, "name"), WorkGraphJson.Required(json, "color"),
        WorkGraphJson.Optional(json, "avatarVersion"), WorkGraphJson.Required(json, "state"), WorkGraphJson.Optional(json, "activeSince"));
}

/// <summary><c>seat: {kind: "fork", forkId}</c>: a read-only inquiry answered by the receiver's fork. Null on an edge means the main seat.</summary>
public sealed record WorkGraphForkSeat(string? ForkId)
{
    /// <summary>Null unless <paramref name="json"/> is an object with kind "fork" and a forkId that is a string or null.</summary>
    public static WorkGraphForkSeat? From(JsonElement json)
    {
        if (json.ValueKind != JsonValueKind.Object || !json.TryGetProperty("kind", out var kind) || kind.ValueKind != JsonValueKind.String || kind.GetString() != "fork") return null;
        if (!json.TryGetProperty("forkId", out var id) || id.ValueKind == JsonValueKind.Null) return new WorkGraphForkSeat((string?)null);
        return id.ValueKind == JsonValueKind.String ? new(id.GetString()) : null;
    }
}

public sealed record WorkGraphEdge(string Id, string? RequestId, string From, string To, string? Label, string State, string? StartedAt = null, WorkGraphForkSeat? Fork = null)
{
    public bool Steered => State == "steered";
    public bool IsFork => Fork is not null;
    /// <summary>Dash of the base line (6 pt line, 4 pt gap); the main seat is solid (empty).</summary>
    public double[] BaseDash => IsFork ? [6, 4] : [];
    /// <summary>The chip text: fork edges read 「分身：」 + label as one text; null or empty label means no chip.</summary>
    public string? ChipText => string.IsNullOrEmpty(Label) ? null : (IsFork ? "分身：" : "") + Label;

    public static WorkGraphEdge FromJson(JsonElement json) => new(WorkGraphJson.Required(json, "id"), WorkGraphJson.Optional(json, "requestId"), WorkGraphJson.Required(json, "from"),
        WorkGraphJson.Required(json, "to"), WorkGraphJson.Optional(json, "label"), WorkGraphJson.Required(json, "state"), WorkGraphJson.Optional(json, "startedAt"),
        json.TryGetProperty("seat", out var seat) ? WorkGraphForkSeat.From(seat) : null);
}

public sealed record WorkGraphSnapshot(string Epoch, int Version, string[]? Degraded, WorkGraphNode[] Nodes, WorkGraphEdge[] Edges)
{
    public static WorkGraphSnapshot From(JsonElement json) => new(WorkGraphJson.Required(json, "epoch"), WorkGraphJson.RequiredInt(json, "version"), WorkGraphJson.Strings(json, "degraded"),
        WorkGraphJson.Array(json, "nodes").Select(WorkGraphNode.From).ToArray(), WorkGraphJson.Array(json, "edges").Select(WorkGraphEdge.FromJson).ToArray());
}

public abstract record WorkGraphChange
{
    public sealed record MemberEnter(WorkGraphNode Node) : WorkGraphChange;
    public sealed record MemberUpdate(WorkGraphNode Node) : WorkGraphChange;
    public sealed record MemberLeave(string BotId) : WorkGraphChange;
    public sealed record EdgeStart(WorkGraphEdge Edge) : WorkGraphChange;
    public sealed record EdgeUpdate(WorkGraphEdge Edge) : WorkGraphChange;
    public sealed record EdgeEnd(string EdgeId) : WorkGraphChange;
    public sealed record Unknown : WorkGraphChange;

    public static WorkGraphChange From(JsonElement json) => WorkGraphJson.Required(json, "type") switch
    {
        "member-enter" => new MemberEnter(WorkGraphNode.From(WorkGraphJson.Object(json, "node"))),
        "member-update" => new MemberUpdate(WorkGraphNode.From(WorkGraphJson.Object(json, "node"))),
        "member-leave" => new MemberLeave(WorkGraphJson.Required(json, "botId")),
        "edge-start" => new EdgeStart(WorkGraphEdge.FromJson(WorkGraphJson.Object(json, "edge"))),
        "edge-update" => new EdgeUpdate(WorkGraphEdge.FromJson(WorkGraphJson.Object(json, "edge"))),
        "edge-end" => new EdgeEnd(WorkGraphJson.Required(json, "edgeId")),
        _ => new Unknown()
    };
}

public sealed record WorkGraphBatch(string Epoch, int Version, string[]? Degraded, WorkGraphChange[] Changes)
{
    public static WorkGraphBatch From(JsonElement json) => new(WorkGraphJson.Required(json, "epoch"), WorkGraphJson.RequiredInt(json, "version"), WorkGraphJson.Strings(json, "degraded"),
        WorkGraphJson.Array(json, "changes").Select(WorkGraphChange.From).ToArray());
}

// Swift Codable strictness: a required key must exist with the right type; an optional key may be absent or null but not mistyped.
internal static class WorkGraphJson
{
    public static JsonElement Object(JsonElement json, string key) =>
        json.ValueKind == JsonValueKind.Object && json.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Object ? value : throw new JsonException($"{key} must be an object.");
    public static string Required(JsonElement json, string key) =>
        json.ValueKind == JsonValueKind.Object && json.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString()! : throw new JsonException($"{key} must be a string.");
    public static string? Optional(JsonElement json, string key)
    {
        if (!json.TryGetProperty(key, out var value) || value.ValueKind == JsonValueKind.Null) return null;
        return value.ValueKind == JsonValueKind.String ? value.GetString() : throw new JsonException($"{key} must be a string.");
    }
    public static int RequiredInt(JsonElement json, string key) =>
        json.ValueKind == JsonValueKind.Object && json.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) ? number : throw new JsonException($"{key} must be an integer.");
    public static string[]? Strings(JsonElement json, string key)
    {
        if (!json.TryGetProperty(key, out var value) || value.ValueKind == JsonValueKind.Null) return null;
        return value.ValueKind == JsonValueKind.Array && value.EnumerateArray().All(item => item.ValueKind == JsonValueKind.String) ? value.EnumerateArray().Select(item => item.GetString()!).ToArray() : throw new JsonException($"{key} must be strings.");
    }
    public static IEnumerable<JsonElement> Array(JsonElement json, string key) =>
        json.ValueKind == JsonValueKind.Object && json.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Array ? value.EnumerateArray() : throw new JsonException($"{key} must be an array.");
}

/// <summary>One press on the graph. The botId is fixed at press time; only a release under 10 pt of movement and under 500 ms is a tap.</summary>
public struct WorkGraphPress
{
    public string? BotId { get; }
    public GraphPoint Start { get; }
    public double Time { get; }
    public bool Moved { get; private set; }
    /// <summary>The finger/pointer position (where iPhone-style press shows the chip under it).</summary>
    public GraphPoint Location { get; private set; }

    public WorkGraphPress(string? botId, GraphPoint start, double time)
    {
        BotId = botId; Start = start; Time = time; Location = start; Moved = false;
    }

    public void Move(GraphPoint point)
    {
        Location = point;
        if (Math.Sqrt((point.X - Start.X) * (point.X - Start.X) + (point.Y - Start.Y) * (point.Y - Start.Y)) >= TapMaxMove) Moved = true;
    }

    /// <summary>Whether releasing at <paramref name="point"/> / <paramref name="end"/> is a tap (members and lines alike).</summary>
    public readonly bool IsTap(GraphPoint point, double end)
    {
        var press = this; press.Move(point);
        return !press.Moved && end - Time < TapMaxSeconds;
    }

    /// <summary>The member to open on release; null when it was not a tap.</summary>
    public readonly string? Release(GraphPoint point, double end) => IsTap(point, end) ? BotId : null;
}

public enum WorkGraphConnection { Connecting, Live, Reconnecting, Unreadable, Unsupported, Failed }

/// <summary>Measures a chip: the whole chip box (padding and icon included) for a text wrapped at most <paramref name="maxWidth"/> wide, never truncated.</summary>
public delegate GraphSize ChipMeasurer(string text, double maxWidth);

/// <summary>One server-sent event: its <c>event:</c> name (null if absent) and parsed data.</summary>
public readonly record struct WorkGraphEvent(string? Name, JsonElement Data);

/// <summary>Opens GET /api/work-graph/events. <paramref name="onActivity"/> must be called for every byte received (heartbeats included).</summary>
public delegate IAsyncEnumerable<WorkGraphEvent> WorkGraphStreamOpener(Action onActivity, CancellationToken token);

/// <summary>The drawn graph and its simulation. Positions are kept by botId, so a redraw never resets them. Time (seconds) is always passed in.</summary>
public sealed class WorkGraphModel(Func<string, double> measureName)
{
    public sealed class Body
    {
        public required WorkGraphNode Node { get; set; }
        public GraphPoint Position { get; set; }
        public GraphVector Velocity { get; set; }
        public GraphPoint Spawn { get; set; }
        public double EnteredAt { get; set; }
        public double? LeavingAt { get; set; }
        public GraphPoint LeaveFrom { get; set; }
        public double ActiveSince { get; set; }
        /// <summary>Where the node was drawn when an uncrossing swap moved it, with the swap time. Entering and leaving nodes have none.</summary>
        public GraphPoint? GlideFrom { get; set; }
        public double GlideAt { get; set; }
    }

    public sealed class Line
    {
        public WorkGraphEdge Edge { get; set; }
        public double StartedAt { get; }
        public double? EndedAt { get; set; }
        /// <summary>The server's startedAt: chips are placed in this order.</summary>
        public double? ServerStart { get; }
        /// <summary>Created once at the latch frame and kept until the edge ends.</summary>
        public Chip? Chip { get; set; }

        public Line(WorkGraphEdge edge, double startedAt)
        {
            Edge = edge; StartedAt = startedAt;
            ServerStart = edge.StartedAt is { } text ? ParseTime(text) : null;
        }
    }

    public sealed class Chip(string text)
    {
        /// <summary>Position on the line; null means not drawn (waiting for a slot, or faded out).</summary>
        public double? T { get; set; }
        /// <summary>Which side of the point (meaningful while <see cref="T"/> is set).</summary>
        public GraphVector Side { get; set; }
        public double? AppearAt { get; set; }
        /// <summary>When the label went back to null; the chip fades over 300 ms.</summary>
        public double? NullAt { get; set; }
        public string Text { get; set; } = text;
        /// <summary>The size measured by the last LayoutChips; clearance uses it.</summary>
        public GraphSize Size { get; set; }
    }

    /// <summary>A drawable line: Point(t) is the position at t in 0..1.</summary>
    public sealed record EdgePath(string Id, Func<double, GraphPoint> Point);

    public sealed record PlacedChip(string Id, string Text, GraphPoint Anchor, GraphRect Tag, GraphRect Area, double Opacity, bool Blocked)
    {
        /// <summary>Full text height for an Oversize chip (taller than its tag; read by scrolling); 0 for a chip that does not scroll.</summary>
        public double Content { get; init; }
        /// <summary>How far the text is scrolled up (0..Content - Tag.Height).</summary>
        public double Scroll { get; init; }
    }

    /// <summary>Drawing order: Blocked above the edges but below members, Unblocked above members, Above the hovered/tapped one on top.</summary>
    public sealed class ChipLayers
    {
        public List<PlacedChip> Blocked { get; } = [];
        public List<PlacedChip> Unblocked { get; } = [];
        public List<PlacedChip> Above { get; } = [];
    }

    public enum HitKind { Member, Chip, Edge }
    public readonly record struct Hit(HitKind Kind, string Id);

    public enum StreamErrorKind { Resync, Silent }
    public sealed class StreamException(StreamErrorKind kind) : Exception(kind.ToString()) { public StreamErrorKind Kind { get; } = kind; }

    // Chips and lines of the last frame (hit testing).
    public ChipLayers Chips { get; private set; } = new();
    /// <summary>Scroll of the topmost Oversize chip, by edge id; dropped when it leaves the top.</summary>
    public IReadOnlyDictionary<string, double> PeekScroll { get; private set; } = new Dictionary<string, double>();
    private IReadOnlyList<EdgePath> paths = [];

    public WorkGraphConnection Connection { get; private set; } = WorkGraphConnection.Connecting;
    /// <summary>The message while <see cref="Connection"/> is Failed.</summary>
    public string? FailedMessage { get; private set; }
    public bool Degraded { get; private set; }
    public bool IsEmpty { get; private set; } = true;
    public Dictionary<string, Body> Bodies { get; } = [];
    /// <summary>The edge whose waiting chip a tap shows (until the next tap elsewhere).</summary>
    public string? TappedEdge { get; private set; }
    /// <summary>The member whose hidden name is shown (pointer over it); LayoutChips takes it each frame.</summary>
    public string? Revealed { get; private set; }
    public Dictionary<string, Line> Lines { get; } = [];
    public List<string> Order { get; } = [];
    public double Heat { get; private set; } = 1;
    public double EmptySince { get; private set; }
    private string? epoch;
    private int version;
    private double? lastStep;
    private double uncrossFrames;
    public GraphSize Size { get; private set; }
    private GraphInsets insets;
    private double lastByte;
    public double BaseSide { get; set; } = 56;
    public bool ReduceMotion { get; set; }

    public const string StreamPath ="/api/work-graph/events";
    /// <summary>On a 404 (old body) check again this often, once. Settable for tests.</summary>
    public TimeSpan UnsupportedRetry { get; set; } = TimeSpan.FromSeconds(60);
    /// <summary>Seconds on the same clock as every <c>now</c> passed in.</summary>
    public Func<double> Clock { get; init; } = () => Now;
    public Func<TimeSpan, CancellationToken, Task> Delay { get; init; } = Task.Delay;

    public static double Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;

    /// <summary>ISO-8601 time as seconds on the <see cref="Now"/> clock; null when unreadable.</summary>
    public static double? ParseTime(string text) =>
        DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var at) ? (at - DateTimeOffset.UnixEpoch).TotalSeconds : null;

    /// <summary>D in the spec: the content area minus 24 pt on every side.</summary>
    public GraphRect Drawable
    {
        get { var inner = Area.InsetBy(DrawablePadding, DrawablePadding); return inner.Width > 1 && inner.Height > 1 ? inner : Area; }
    }

    public GraphRect Area => new(insets.Left, insets.Top, Math.Max(1, Size.Width - insets.Left - insets.Right), Math.Max(1, Size.Height - insets.Top - insets.Bottom));

    public int LiveCount => Bodies.Values.Count(body => body.LeavingAt is null);

    private double NameHeight => NameFontSize * NameHeightFactor;
    private double EnterTime => ReduceMotion ? ReduceMotionSeconds : EnterSeconds;

    // MARK: Stream

    /// <summary>
    /// Keeps the stream open while the page is open and reconnects with the shared backoff. Only a 404 (old body, checked again every
    /// <see cref="UnsupportedRetry"/>), a lost sign-in or an unreadable answer are shown; none of them stops the loop except sign-in and cancel.
    /// </summary>
    public async Task RunAsync(WorkGraphStreamOpener open, CancellationToken token)
    {
        var attempt = 0;
        while (!token.IsCancellationRequested)
        {
            using var silence = CancellationTokenSource.CreateLinkedTokenSource(token);
            var silent = false;
            Task watch = Task.CompletedTask;
            try
            {
                lastByte = Clock();
                watch = WatchSilenceAsync(silence, () => silent = true);
                await foreach (var item in open(() => lastByte = Clock(), silence.Token)) { lastByte = Clock(); Receive(item.Name, item.Data, Clock()); }
                if (Connection == WorkGraphConnection.Live) attempt = 0;
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (OperationCanceledException) when (silent) { if (Connection == WorkGraphConnection.Live) attempt = 0; }
            catch (BellApiException error) when (error.Status == HttpStatusCode.NotFound)
            {
                Connection = WorkGraphConnection.Unsupported;
                attempt = 0;
                try { await Delay(UnsupportedRetry, token); } catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
                continue;
            }
            catch (BellApiException error) when (error.RequiresLogin)
            {
                Connection = WorkGraphConnection.Failed; FailedMessage = "ログインが必要です。";
                return;
            }
            // An answer we cannot read still reconnects; the next readable snapshot clears it.
            catch (JsonException) { Connection = WorkGraphConnection.Unreadable; }
            catch (StreamException error) when (error.Kind == StreamErrorKind.Resync) { attempt = 0; continue; }
            // Transport failures (refused, reset, handshake timeout, other HTTP status, stream ended) reconnect; a bug in the model is not swallowed.
            catch (Exception error) when (error is HttpRequestException or IOException or BellApiException or OperationCanceledException) { if (Connection == WorkGraphConnection.Live) attempt = 0; }
            finally
            {
                silence.Cancel();
                try { await watch; } catch (OperationCanceledException) { }
            }
            if (token.IsCancellationRequested) return;
            if (Connection != WorkGraphConnection.Unreadable) Connection = WorkGraphConnection.Reconnecting;
            var wait = ReconnectBackoff.Ms(attempt++);
            if (wait > 0) { try { await Delay(TimeSpan.FromMilliseconds(wait), token); } catch (OperationCanceledException) when (token.IsCancellationRequested) { return; } }
        }
    }

    // 35 s without any byte is a drop (the server sends a heartbeat every 15 s).
    private async Task WatchSilenceAsync(CancellationTokenSource silence, Action markSilent)
    {
        try
        {
            while (true)
            {
                await Delay(TimeSpan.FromSeconds(5), silence.Token);
                if (Clock() - lastByte > SilenceSeconds) { markSilent(); silence.Cancel(); return; }
            }
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>Applies one event. A change batch applies only when its epoch matches and version is last + 1; otherwise <see cref="StreamException"/> (Resync) asks for a reconnect.</summary>
    public void Receive(string? name, JsonElement data, double now)
    {
        switch (name)
        {
            case "snapshot": Apply(WorkGraphSnapshot.From(data), now); break;
            case "change":
                var batch = WorkGraphBatch.From(data);
                if (batch.Epoch != epoch || batch.Version != version + 1) throw new StreamException(StreamErrorKind.Resync);
                Apply(batch, now);
                break;
        }
    }

    // MARK: Applying data

    public void Apply(WorkGraphSnapshot snapshot, double now)
    {
        epoch = snapshot.Epoch;
        version = snapshot.Version;
        var next = snapshot.Nodes.Select(node => node.BotId).ToHashSet();
        foreach (var id in Order.Where(id => !next.Contains(id)).ToList()) Leave(id, now);
        foreach (var node in snapshot.Nodes)
        {
            if (Bodies.TryGetValue(node.BotId, out var body) && body.LeavingAt is null) body.Node = node; else Enter(node, now);
        }
        var edgeIds = snapshot.Edges.Select(edge => edge.Id).ToHashSet();
        foreach (var (id, line) in Lines) if (!edgeIds.Contains(id) && line.EndedAt is null) line.EndedAt = now;
        foreach (var edge in snapshot.Edges)
        {
            if (Lines.TryGetValue(edge.Id, out var line) && line.EndedAt is null) line.Edge = edge; else Lines[edge.Id] = new Line(edge, now);
        }
        Finish(snapshot.Degraded, now);
    }

    public void Apply(WorkGraphBatch batch, double now)
    {
        version = batch.Version;
        foreach (var change in batch.Changes)
        {
            switch (change)
            {
                case WorkGraphChange.MemberEnter { Node: var node }:
                    if (Bodies.TryGetValue(node.BotId, out var body) && body.LeavingAt is null) body.Node = node; else Enter(node, now);
                    break;
                case WorkGraphChange.MemberUpdate { Node: var node }: if (Bodies.TryGetValue(node.BotId, out var updated)) updated.Node = node; break;
                case WorkGraphChange.MemberLeave { BotId: var id }: Leave(id, now); break;
                case WorkGraphChange.EdgeStart { Edge: var edge }: Lines[edge.Id] = new Line(edge, now); break;
                case WorkGraphChange.EdgeUpdate { Edge: var edge }: if (Lines.TryGetValue(edge.Id, out var line)) line.Edge = edge; break;
                case WorkGraphChange.EdgeEnd { EdgeId: var id }: if (Lines.TryGetValue(id, out var ended)) ended.EndedAt = now; break;
            }
        }
        Finish(batch.Degraded, now);
    }

    private void Finish(string[]? list, double now)
    {
        Heat = 1;
        if (Connection != WorkGraphConnection.Live) Connection = WorkGraphConnection.Live;
        Degraded = (list ?? []).Length > 0;
        var empty = !Bodies.Values.Any(body => body.LeavingAt is null);
        if (IsEmpty != empty)
        {
            IsEmpty = empty;
            if (empty) EmptySince = now;
        }
    }

    private void Enter(WorkGraphNode node, double now)
    {
        var center = new GraphPoint(Area.MidX, Area.MidY);
        var side = Side(Math.Max(1, LiveCount + 1));
        var angle = Fnv1a(node.BotId) % 360 * Math.PI / 180;
        GraphPoint spawn, target;
        if (ReduceMotion)
        {
            // No fly-in with Reduce Motion: appear in a free spot near the center.
            target = new(center.X + Math.Cos(angle) * side * 1.6, center.Y + Math.Sin(angle) * side * 1.6);
            spawn = target;
        }
        else
        {
            var distance = Math.Sqrt(Size.Width * Size.Width + Size.Height * Size.Height) / 2 + side;
            spawn = new(center.X + Math.Cos(angle) * distance, center.Y + Math.Sin(angle) * distance);
            target = new(center.X + Math.Cos(angle) * side, center.Y + Math.Sin(angle) * side);
        }
        Bodies[node.BotId] = new Body { Node = node, Position = target, Spawn = spawn, EnteredAt = now, ActiveSince = node.ActiveSince is { } text && ParseTime(text) is { } since ? since : now };
        Order.RemoveAll(id => id == node.BotId);
        Order.Add(node.BotId);
    }

    private void Leave(string id, double now)
    {
        if (!Bodies.TryGetValue(id, out var body) || body.LeavingAt is not null) return;
        body.LeavingAt = now;
        body.LeaveFrom = DrawPosition(body, now);
    }

    // MARK: Simulation

    /// <summary>S: shrinks with the member count (above 12, and to fit the area), at least 36 pt.</summary>
    public double Side(int count)
    {
        double n = Math.Max(count, 1);
        var byCount = count > CrowdedCount ? BaseSide * Math.Sqrt(CrowdedCount / n) : BaseSide;
        var byArea = Size.Width > 0 && Size.Height > 0 ? Math.Sqrt(Drawable.Width * Drawable.Height / n) * SideAreaFactor : BaseSide;
        return Math.Max(MinSide, Math.Min(byCount, byArea));
    }

    /// <summary>Advances one frame. dt is real time, clamped to 1/30 s.</summary>
    public void Step(double now, GraphSize newSize, GraphInsets newInsets)
    {
        if (newInsets != insets) { insets = newInsets; Heat = 1; }
        if (newSize != Size)
        {
            if (Size != default) Heat = 1;
            Size = newSize;
        }
        var dt = Math.Min(Math.Max(now - (lastStep ?? now), 0), MaxFrameSeconds);
        lastStep = now;
        foreach (var (id, body) in Bodies.ToList()) if (body.LeavingAt is { } leavingAt && now - leavingAt > LeaveSeconds) { Bodies.Remove(id); Order.Remove(id); }
        foreach (var (id, line) in Lines.ToList()) if (line.EndedAt is { } endedAt && now - endedAt > EdgeEndSeconds) Lines.Remove(id);
        if (!(dt > 0)) return;
        // behavior-spec.md "Layout: force-directed, normalized to the drawable rect" (same constants as layout-sim.mjs).
        var ids = Order.Where(id => Bodies[id].LeavingAt is null).ToList();
        if (ids.Count == 0) return;
        var d = Drawable; var w = d.Width; var h = d.Height;
        double n = ids.Count;
        var s = Side(ids.Count);
        var nameHeight = NameHeight;
        var kr = RepulsionNumerator / n;
        var length = Math.Min(SpringLengthMax, SpringLengthScale / Math.Sqrt(n));
        var u = ids.ToDictionary(id => id, id => new GraphPoint((Bodies[id].Position.X - d.MinX) / w, (Bodies[id].Position.Y - d.MinY) / h));
        var force = ids.ToDictionary(id => id, _ => new GraphVector());
        void Pull(string a, string b, Func<double, double> amount)
        {
            var pa = u[a]; var pb = u[b];
            double du = pb.X - pa.X, dv = pb.Y - pa.Y, dist = Math.Max(0.01, Math.Sqrt(du * du + dv * dv));
            var q = amount(dist);
            force[a] = new(force[a].Dx + q * du / dist, force[a].Dy + q * dv / dist);
            force[b] = new(force[b].Dx - q * du / dist, force[b].Dy - q * dv / dist);
        }
        for (var i = 0; i < ids.Count; i++) for (var j = i + 1; j < ids.Count; j++) Pull(ids[i], ids[j], dist => -kr / (dist * dist));
        var pairs = new HashSet<string>();
        foreach (var line in Lines.Values)
        {
            if (line.EndedAt is not null) continue;
            var key = string.Join('|', new[] { line.Edge.From, line.Edge.To }.Order(StringComparer.Ordinal));
            if (!u.ContainsKey(line.Edge.From) || !u.ContainsKey(line.Edge.To) || !pairs.Add(key)) continue;
            Pull(line.Edge.From, line.Edge.To, dist => SpringStrength * (dist - length));
        }
        // Push unrelated members off lines and blocked chips (behavior-spec.md "Clearance").
        var clearEdges = new List<(int A, int B, GraphSize? Chip)>();
        var slot = ids.Select((id, index) => (id, index)).ToDictionary(pair => pair.id, pair => pair.index);
        foreach (var line in LabelOrder(Lines.Values))
        {
            if (line.EndedAt is not null || !slot.TryGetValue(line.Edge.From, out var a) || !slot.TryGetValue(line.Edge.To, out var b) || a == b) continue;
            clearEdges.Add((a, b, line.Chip is { NullAt: null } chip && chip.Size != default ? (GraphSize?)chip.Size : null));
        }
        var relative = ids.Select(id => new GraphPoint(u[id].X * w, u[id].Y * h)).ToList();
        var pushes = Clearance(relative, Extents(ids, relative, s), clearEdges);
        for (var i = 0; i < ids.Count; i++) force[ids[i]] = new(force[ids[i]].Dx + pushes[i].Dx, force[ids[i]].Dy + pushes[i].Dy);
        // Each axis: weaker gravity under 88 % filled, stronger over it.
        static double Gravity(double fill) => GravityBase * Math.Min(GravityMax, Math.Max(GravityMin, Math.Pow(fill / GravityTargetFill, GravityExponent)));
        var us = ids.Select(id => u[id]).ToList();
        var gu = Gravity(us.Max(p => p.X) - us.Min(p => p.X) + s / w);
        var gv = Gravity(us.Max(p => p.Y) - us.Min(p => p.Y) + (s + nameHeight) / h);
        var frames = dt * FramesPerSecond;
        foreach (var id in ids)
        {
            var body = Bodies[id]; var p = u[id]; var f = force[id];
            var v = new GraphVector((body.Velocity.Dx + (f.Dx + gu * (0.5 - p.X)) * Heat) * Damping, (body.Velocity.Dy + (f.Dy + gv * (0.5 - p.Y)) * Heat) * Damping);
            var speed = Math.Sqrt(v.Dx * w * (v.Dx * w) + v.Dy * h * (v.Dy * h));
            if (speed > SpeedCap) v = new(v.Dx * SpeedCap / speed, v.Dy * SpeedCap / speed);
            body.Velocity = v;
            u[id] = new(Math.Min(1 - s / 2 / w, Math.Max(s / 2 / w, p.X + v.Dx * frames)), Math.Min(1 - (s / 2 + nameHeight) / h, Math.Max(s / 2 / h, p.Y + v.Dy * frames)));
        }
        // Collision in points (S x 2.2).
        var minDistance = s * CollisionFactor;
        for (var i = 0; i < ids.Count; i++)
        {
            for (var j = i + 1; j < ids.Count; j++)
            {
                var pa = u[ids[i]]; var pb = u[ids[j]];
                double dx = (pb.X - pa.X) * w, dy = (pb.Y - pa.Y) * h, dist = Math.Max(0.01, Math.Sqrt(dx * dx + dy * dy));
                if (!(dist < minDistance)) continue;
                var push = (minDistance - dist) / 2;
                u[ids[i]] = new(pa.X - push * dx / dist / w, pa.Y - push * dy / dist / h);
                u[ids[j]] = new(pb.X + push * dx / dist / w, pb.Y + push * dy / dist / h);
            }
        }
        foreach (var id in ids)
        {
            var p = u[id];
            p = new(Math.Min(1 - s / 2 / w, Math.Max(s / 2 / w, p.X)), Math.Min(1 - (s / 2 + nameHeight) / h, Math.Max(s / 2 / h, p.Y)));
            Bodies[id].Position = new(d.MinX + p.X * w, d.MinY + p.Y * h);
        }
        uncrossFrames += frames;
        if (uncrossFrames >= UncrossEveryFrames)
        {
            uncrossFrames -= UncrossEveryFrames;
            Uncross(now);
        }
        Heat = Math.Max(HeatFloor, Heat * Math.Pow(HeatDecay, frames));
    }

    /// <summary>Request order: server start, then edge id (behavior-spec.md "Edges"; oldest placed first).</summary>
    public static List<Line> LabelOrder(IEnumerable<Line> lines) =>
        lines.OrderBy(line => line.ServerStart ?? line.StartedAt).ThenBy(line => line.Edge.Id, StringComparer.Ordinal).ToList();

    // MARK: Uncrossing swaps

    /// <summary>Counts crossings of the open edges as straight lines and swaps position and velocity of the best pair. Heat is unchanged.</summary>
    public void Uncross(double now)
    {
        var ids = Order.Where(id => Bodies[id].LeavingAt is null).Order(StringComparer.Ordinal).ToList();
        var index = ids.Select((id, i) => (id, i)).ToDictionary(pair => pair.id, pair => pair.i);
        var edges = new SortedSet<(int, int)>();
        foreach (var line in Lines.Values)
            if (line.EndedAt is null && index.TryGetValue(line.Edge.From, out var a) && index.TryGetValue(line.Edge.To, out var b) && a != b) edges.Add((Math.Min(a, b), Math.Max(a, b)));
        var points = ids.Select(id => Bodies[id].Position).ToList();
        var boxes = Extents(ids, points, Side(ids.Count));
        if (BestSwap(points, edges, boxes) is not { Pair: var pair }) return;
        var first = Bodies[ids[pair.Item1]]; var second = Bodies[ids[pair.Item2]];
        var enter = EnterTime;
        var drawnA = DrawPosition(first, now); var drawnB = DrawPosition(second, now);
        (first.Position, second.Position) = (second.Position, first.Position);
        (first.Velocity, second.Velocity) = (second.Velocity, first.Velocity);
        first.GlideFrom = now - first.EnteredAt >= enter ? (GraphPoint?)drawnA : null;
        second.GlideFrom = now - second.EnteredAt >= enter ? (GraphPoint?)drawnB : null;
        first.GlideAt = now;
        second.GlideAt = now;
    }

    /// <summary>Each member's box relative to its center: the avatar square joined with the drawn name's text box (a hidden name does not count).</summary>
    private List<GraphRect> Extents(List<string> ids, IReadOnlyList<GraphPoint> points, double side)
    {
        var discs = points.Select(p => new GraphRect(p.X - side / 2, p.Y - side / 2, side, side)).ToList();
        return ids.Select((id, i) =>
        {
            var name = Bodies[id].Node.Name;
            var placed = PlaceName(discs[i], name, side * CollisionFactor, NameHeight, discs.Where((_, j) => j != i).ToList(), measureName);
            var box = placed.Hidden ? discs[i] : discs[i].Union(TextBox(placed.Frame, name, measureName));
            return box.OffsetBy(-points[i].X, -points[i].Y);
        }).ToList();
    }

    // MARK: Drawing helpers

    /// <summary>Enter flies from the spawn point to the simulated position; leave moves out from the center. Also scale and opacity.</summary>
    public (GraphPoint Point, double Scale, double Opacity) Appearance(Body body, double now)
    {
        if (body.LeavingAt is { } leavingAt)
        {
            var t = Math.Min(Math.Max((now - leavingAt) / LeaveSeconds, 0), 1);
            var k = Bezier(t, 0.4, 0, 1, 1);
            var center = new GraphPoint(Area.MidX, Area.MidY);
            double dx = body.LeaveFrom.X - center.X, dy = body.LeaveFrom.Y - center.Y;
            var dist = Math.Max(1, Math.Sqrt(dx * dx + dy * dy)); dx /= dist; dy /= dist;
            var travel = Math.Sqrt(Size.Width * Size.Width + Size.Height * Size.Height);
            var point = new GraphPoint(body.LeaveFrom.X + dx * travel * k, body.LeaveFrom.Y + dy * travel * k);
            var opacity = t < 0.6 ? 1 : Math.Max(0, 1 - (t - 0.6) / 0.4);
            return (point, 1, opacity);
        }
        if (ReduceMotion)
        {
            var t = Math.Min(Math.Max((now - body.EnteredAt) / ReduceMotionSeconds, 0), 1);
            // An uncrossing swap does not glide: it fades out at the old place over the first half of 200 ms and in at the new place over the second.
            if (body.GlideFrom is { } origin && now - body.GlideAt < ReduceMotionSeconds)
            {
                var swapT = (now - body.GlideAt) / ReduceMotionSeconds;
                return (swapT < 0.5 ? origin : body.Position, 1, t * Math.Abs(1 - 2 * swapT));
            }
            return (body.Position, 1, t);
        }
        if (body.GlideFrom is { } glide && now - body.GlideAt < GlideSeconds)
        {
            var k = Bezier(Math.Max(0, (now - body.GlideAt) / GlideSeconds), 0.2, 0.8, 0.2, 1);
            return (new(glide.X + (body.Position.X - glide.X) * k, glide.Y + (body.Position.Y - glide.Y) * k), 1, 1);
        }
        var enter = Math.Min(Math.Max((now - body.EnteredAt) / EnterSeconds, 0), 1);
        var e = Bezier(enter, 0.2, 0.8, 0.2, 1);
        return (new(body.Spawn.X + (body.Position.X - body.Spawn.X) * e, body.Spawn.Y + (body.Position.Y - body.Spawn.Y) * e), 0.6 + 0.4 * e, e);
    }

    public GraphPoint DrawPosition(Body body, double now) => Appearance(body, now).Point;

    private GraphRect AvatarFrame(Body body, double now)
    {
        var look = Appearance(body, now);
        var size = Side(Math.Max(1, LiveCount)) * look.Scale;
        return new(look.Point.X - size / 2, look.Point.Y - size / 2, size, size);
    }

    /// <summary>The drawn avatar square and name slot; drawing and hit testing use the same positions. A hidden name keeps its slot below.</summary>
    public (GraphRect Avatar, GraphRect Name) Frames(Body body, double now)
    {
        var avatar = AvatarFrame(body, now);
        return (avatar, Placement(body, avatar, now).Frame);
    }

    private (GraphRect Frame, bool Hidden) Placement(Body body, GraphRect avatar, double now)
    {
        var others = Bodies.Values.Where(other => other.Node.BotId != body.Node.BotId && other.LeavingAt is null).Select(other => AvatarFrame(other, now)).ToList();
        return PlaceName(avatar, body.Node.Name, Side(Math.Max(1, LiveCount)) * CollisionFactor, NameHeight, others, measureName);
    }

    /// <summary>A name that would overlap another avatar moves above its own; if that overlaps too it is hidden unless it is the revealed member's.</summary>
    public bool NameHidden(Body body, double now) => body.Node.BotId != Revealed && Placement(body, AvatarFrame(body, now), now).Hidden;

    /// <summary>The drawn name's text box; null for a name that is not visible (opacity 0 or hidden). Used as a chip obstacle.</summary>
    public GraphRect? NameText(Body body, double now) =>
        Appearance(body, now).Opacity > 0 && !NameHidden(body, now) ? TextBox(Frames(body, now).Name, body.Node.Name, measureName) : null;

    /// <summary>
    /// Places one frame of chips (behavior-spec.md "Edges"). A chip is created once at the latch frame (label set and both ends landed) and
    /// kept until its edge ends. Placement goes oldest first to the first slot free of node boxes, drawn names and earlier chips (each grown by 4 pt);
    /// a chip keeps its slot while free, moves to the first free slot when taken, and is blocked in place when none is free.
    /// <paramref name="peek"/> is the edge whose waiting chip shows at t = 0.5 on top (pointer over the line, or tapped line).
    /// </summary>
    public void LayoutChips(IReadOnlyList<EdgePath> edgePaths, ChipMeasurer size, string? hover, double now, string? peek = null, string? reveal = null)
    {
        paths = edgePaths;
        Revealed = reveal;
        var enter = EnterTime;
        // A leaving member's avatar and name are not obstacles (it is already moving off screen).
        var fixedBoxes = Bodies.Values.Where(body => body.LeavingAt is null)
            .SelectMany(body => { var boxes = new List<GraphRect> { Frames(body, now).Avatar }; if (NameText(body, now) is { } name) boxes.Add(name); return boxes; }).ToList();
        var placed = new List<GraphRect>();
        var d = Drawable;
        var maxWidth = ChipMaxWidth(d);
        // A free slot: still inside D when grown by 4 pt (an Oversize chip never is) and touching no obstacle.
        bool Free(GraphRect area)
        {
            var grown = area.InsetBy(-ChipGap, -ChipGap);
            return OnScreen(grown, d) && !fixedBoxes.Any(box => box.Intersects(grown)) && !placed.Any(box => box.Intersects(grown));
        }
        var layers = new ChipLayers();
        var byId = new Dictionary<string, EdgePath>();
        foreach (var path in edgePaths) byId.TryAdd(path.Id, path);
        foreach (var line in LabelOrder(Lines.Values.Where(line => byId.ContainsKey(line.Edge.Id))))
        {
            var path = byId[line.Edge.Id];
            var label = line.Edge.ChipText;
            // Not decided on a flying-in position. A leaving or absent end counts as landed.
            var landed = new[] { line.Edge.From, line.Edge.To }.All(id => !Bodies.TryGetValue(id, out var body) || body.LeavingAt is not null || now - body.EnteredAt >= enter);
            var chip = line.Chip;
            if (chip is null && label is not null && line.EndedAt is null && landed) chip = new Chip(label);
            if (chip is null) continue;
            if (label is not null) { chip.NullAt = null; chip.Text = label; } else if (chip.NullAt is null) chip.NullAt = now;
            var chipSize = size(chip.Text, maxWidth);
            chip.Size = chipSize;
            (GraphRect Tag, GraphRect Area) Frame(Spot spot) => ChipFrame(path.Point(spot.T), chipSize, spot.Side, d);
            var oversize = IsOversize(chipSize, d);
            // The shape of a chip shown on top: an Oversize chip is a box D tall whose text scrolls.
            PlacedChip Shown((GraphRect Tag, GraphRect Area) frame, GraphPoint anchor, double alpha, bool isBlocked)
            {
                if (!oversize) return new PlacedChip(line.Edge.Id, chip.Text, anchor, frame.Tag, frame.Area, alpha, isBlocked);
                var p = PeekFrame(frame, d);
                return new PlacedChip(line.Edge.Id, chip.Text, anchor, p.Tag, p.Area, alpha, isBlocked)
                {
                    Content = chipSize.Height,
                    Scroll = Math.Min(Math.Max(0, PeekScroll.GetValueOrDefault(line.Edge.Id)), chipSize.Height - p.Tag.Height)
                };
            }
            var opacity = 1.0;
            if (line.EndedAt is { } endedAt) opacity *= Math.Max(0, 1 - (now - endedAt) / EdgeEndSeconds);
            if (chip.NullAt is { } nullAt) opacity *= Math.Max(0, 1 - (now - nullAt) / EdgeEndSeconds);
            if (opacity <= 0 && (chip.NullAt is not null || line.EndedAt is not null))
            {
                chip.T = null; // a faded-out chip gives its place back
            }
            else if (line.EndedAt is null && chip.NullAt is null)
            {
                Spot? first = ChipSpots.Cast<Spot?>().FirstOrDefault(spot => Free(Frame(spot!.Value).Area));
                if (chip.T is { } current)
                {
                    if (!Free(Frame(new Spot(current, chip.Side)).Area) && first is { } moved) { chip.T = moved.T; chip.Side = moved.Side; }
                }
                else if (first is { } start)
                {
                    chip.T = start.T; chip.Side = start.Side;
                    chip.AppearAt = now;
                }
            }
            line.Chip = chip;
            var hovered = hover == line.Edge.Id && label is not null && line.EndedAt is null;
            if (chip.T is not { } t)
            {
                // A waiting chip shows at t = 0.5 on top only while its line is pointed at; it takes no place.
                if (peek == line.Edge.Id && label is not null && line.EndedAt is null)
                    layers.Above.Add(Shown(Frame(new Spot(0.5, default)), path.Point(0.5), 1, false));
                continue;
            }
            var f = Frame(new Spot(t, chip.Side));
            var blocked = !Free(f.Area);
            placed.Add(f.Area); // a blocked chip is still an obstacle for later chips
            if (chip.AppearAt is { } appearAt) opacity *= Math.Min(1, (now - appearAt) / ChipFadeInSeconds); // first appearance fades in over 200 ms
            // An Oversize chip also shows as the top box for a tapped line.
            var peeked = hovered || (oversize && peek == line.Edge.Id && label is not null && line.EndedAt is null);
            if (peeked) layers.Above.Add(Shown(f, path.Point(t), 1, blocked));
            else
            {
                var item = new PlacedChip(line.Edge.Id, chip.Text, path.Point(t), f.Tag, f.Area, opacity, blocked);
                (blocked ? layers.Blocked : layers.Unblocked).Add(item);
            }
        }
        // A chip that left the top loses its scroll (the next opening starts at line 1).
        PeekScroll = layers.Above.Where(chip => chip.Content > 0).GroupBy(chip => chip.Id).ToDictionary(group => group.Key, group => group.Last().Scroll);
        Chips = layers;
    }

    /// <summary>What a press or pointer is on, top first: member (44 pt square or more), unblocked chip, blocked chip, line.</summary>
    public Hit? HitTest(GraphPoint point, double now)
    {
        if (Member(point, now) is { } id) return new(HitKind.Member, id);
        var chip = Chips.Unblocked.Concat(Chips.Above).LastOrDefault(item => item.Area.Contains(point)) ?? Chips.Blocked.LastOrDefault(item => item.Area.Contains(point));
        if (chip is not null) return new(HitKind.Chip, chip.Id);
        foreach (var path in paths)
        {
            if (Lines.TryGetValue(path.Id, out var line) && line.EndedAt is not null) continue;
            if (Enumerable.Range(0, 21).Any(i => { var p = path.Point(i / 20.0); return Math.Sqrt((p.X - point.X) * (p.X - point.X) + (p.Y - point.Y) * (p.Y - point.Y)) < EdgeHitDistance; })) return new(HitKind.Edge, path.Id);
        }
        return null;
    }

    /// <summary>A released tap (<see cref="WorkGraphPress.IsTap"/>) decides which waiting chip shows: a line shows its chip, the shown chip stays, anything else clears.</summary>
    public void Tap(GraphPoint point, double now)
    {
        switch (HitTest(point, now))
        {
            case { Kind: HitKind.Edge, Id: var id }: TappedEdge = id; break;
            case { Kind: HitKind.Chip, Id: var id } when id == TappedEdge: break;
            default: TappedEdge = null; break;
        }
    }

    public void ClearTap() => TappedEdge = null;

    /// <summary>Scrolls the topmost Oversize chip under <paramref name="point"/> by <paramref name="delta"/> (positive moves the text up), stopping where the last line shows. True if it scrolled.</summary>
    public bool ScrollPeek(double delta, GraphPoint point)
    {
        var index = Chips.Above.FindLastIndex(chip => chip.Content > chip.Tag.Height && chip.Area.Contains(point));
        if (index < 0) return false;
        var chip = Chips.Above[index];
        var scroll = Math.Min(Math.Max(0, chip.Scroll + delta), chip.Content - chip.Tag.Height);
        Chips.Above[index] = chip with { Scroll = scroll };
        PeekScroll = new Dictionary<string, double>(PeekScroll) { [chip.Id] = scroll };
        return true;
    }

    /// <summary>The member under <paramref name="point"/> (avatar or name, both at least 44 pt square). A leaving node still counts while drawn.</summary>
    public string? Member(GraphPoint point, double now)
    {
        for (var i = Order.Count - 1; i >= 0; i--)
        {
            if (!Bodies.TryGetValue(Order[i], out var body)) continue;
            var frames = Frames(body, now);
            if (new[] { frames.Avatar, frames.Name }.Any(rect => TapTarget(rect).Contains(point))) return Order[i];
        }
        return null;
    }

    public WorkGraphPress Press(GraphPoint point, double time) => new(Member(point, time), point, time);

    /// <summary>
    /// One gesture update. A null <paramref name="press"/> is the first sample of a new press: the member is decided at <paramref name="start"/>.
    /// A first sample that already moved 10 pt counts as moved. With <paramref name="scrollsPeek"/> a press that did not start on a member scrolls
    /// the Oversize chip under its start.
    /// </summary>
    public void UpdatePress(ref WorkGraphPress? press, GraphPoint start, GraphPoint location, double time, bool scrollsPeek = false)
    {
        press ??= Press(start, time);
        var previous = press.Value.Location;
        var updated = press.Value; updated.Move(location); press = updated;
        if (scrollsPeek && updated.BotId is null) ScrollPeek(previous.Y - location.Y, start);
    }
}
