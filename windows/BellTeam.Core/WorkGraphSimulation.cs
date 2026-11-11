using System.Text;

namespace BellTeam.Core;

// 相関図 (work graph) geometry and pure functions. Port of the statics in Mac Core/WorkGraphModel.swift; the numbers come from
// docs/architecture/modules/work-graph/behavior-spec.md and layout-sim.mjs. Plain doubles: no WPF types in Core.
public readonly record struct GraphPoint(double X, double Y);
public readonly record struct GraphVector(double Dx, double Dy);
public readonly record struct GraphSize(double Width, double Height);
public readonly record struct GraphInsets(double Left, double Top, double Right, double Bottom);

// CGRect semantics the model relies on: edges that only touch do not intersect; Contains is half-open (min inclusive, max exclusive).
public readonly record struct GraphRect(double X, double Y, double Width, double Height)
{
    public double MinX => X;
    public double MaxX => X + Width;
    public double MidX => X + Width / 2;
    public double MinY => Y;
    public double MaxY => Y + Height;
    public double MidY => Y + Height / 2;
    public GraphRect InsetBy(double dx, double dy) => new(X + dx, Y + dy, Width - 2 * dx, Height - 2 * dy);
    public GraphRect OffsetBy(double dx, double dy) => new(X + dx, Y + dy, Width, Height);
    public GraphRect Union(GraphRect other)
    {
        var minX = Math.Min(MinX, other.MinX); var minY = Math.Min(MinY, other.MinY);
        return new(minX, minY, Math.Max(MaxX, other.MaxX) - minX, Math.Max(MaxY, other.MaxY) - minY);
    }
    public bool Intersects(GraphRect other) => MinX < other.MaxX && other.MinX < MaxX && MinY < other.MaxY && other.MinY < MaxY;
    public bool Contains(GraphPoint point) => point.X >= MinX && point.X < MaxX && point.Y >= MinY && point.Y < MaxY;
}

public static class WorkGraphSimulation
{
    // Layout (behavior-spec.md "Layout: force-directed"; layout-sim.mjs LAYOUT).
    public const double RepulsionNumerator = 0.005;     // kr = 0.005 / n
    public const double SpringStrength = 0.02;          // ks
    public const double SpringLengthMax = 0.7;          // L = min(0.7, 1.4 / sqrt(n))
    public const double SpringLengthScale = 1.4;
    public const double GravityBase = 0.02;             // gu = 0.02 * clamp((span / 0.88)^16, 0.001, 50)
    public const double GravityTargetFill = 0.88;
    public const double GravityExponent = 16;
    public const double GravityMin = 0.001, GravityMax = 50;
    public const double Damping = 0.82;                 // v = (v + F * alpha) * 0.82
    public const double SpeedCap = 14;                  // points per frame-equivalent
    public const double HeatFloor = 0.04, HeatDecay = 0.985;
    public const double CollisionFactor = 2.2;          // collision distance S * 2.2
    public const double MinSide = 36;                   // S = max(36, ...)
    public const double SideAreaFactor = 0.3;           // S <= sqrt(W * H / n) * 0.3
    public const int CrowdedCount = 12;                 // above 12 nodes S12 = S0 * sqrt(12 / n)
    public const double DrawablePadding = 24;           // D = content area inset by 24 pt
    public const double MaxFrameSeconds = 1.0 / 30;     // dt clamp
    public const double NameHeightFactor = 1.4;         // name line height = font size * 1.4
    public const double NameFontSize = 16;              // Mac listNameFontSize (Windows follows the Mac)
    public const double FramesPerSecond = 60;

    // Uncrossing swaps (behavior-spec.md "Uncrossing swaps").
    public const double UncrossEveryFrames = 30;
    public const double GlideSeconds = 0.7;             // enter curve, 700 ms

    // Clearance (behavior-spec.md "Clearance").
    public const double ClearanceForce = 0.003;         // kc
    public const double ClearGap = 6;                   // node box grown by 6 pt for lines
    public const double ChipGap = 4;                    // chip / name / disc obstacles grown by 4 pt
    public const double NameHaloWidth = 3;              // name halo stroke (drawing only; the view reads it)

    // Enter / leave (behavior-spec.md "Enter", "Leave").
    public const double EnterSeconds = 0.7, ReduceMotionSeconds = 0.2, LeaveSeconds = 0.6;
    public const double EdgeEndSeconds = 0.3;           // line and chip fade out
    public const double ChipFadeInSeconds = 0.2;

    // Chips (behavior-spec.md "Edges and the flow effect").
    public const double ChipMaxWidthLimit = 180;        // max width 180 pt, never wider than D - 8 pt
    public const double ChipMinMargin = 8;
    public const double ChipLineHeight = 16;
    public const double ChipFloat = 7;                  // centered chip floats above the path point
    public const double TailInset = 14;                 // corner radius 9 + tail half width 5
    public const int ChipPositionCount = 17;            // t = 0.5, 0.45, 0.55 ... 0.1, 0.9 (x 5 sides = 85 slots)

    // Taps (behavior-spec.md "Tap or click on a member").
    public const double TapTargetSide = 44;
    public const double TapMaxMove = 10;
    public const double TapMaxSeconds = 0.5;
    public const double EdgeHitDistance = 10;           // pointer distance that counts as on the line

    // Stream (behavior-spec.md "Stream drop and recovery").
    public const double SilenceSeconds = 35;

    /// <summary>Chip max width: 180 pt, and never wider than D minus 8 pt (behavior-spec.md "Label").</summary>
    public static double ChipMaxWidth(GraphRect drawable) => Math.Min(ChipMaxWidthLimit, drawable.Width - ChipMinMargin);

    // MARK: Chip geometry

    public readonly record struct Spot(double T, GraphVector Side);

    /// <summary>Sides tried at one position: centered, above (bottom edge on the point), below, left (right edge on the point), right.</summary>
    public static readonly GraphVector[] ChipSides = [new(0, 0), new(0, -1), new(0, 1), new(-1, 0), new(1, 0)];

    /// <summary>The 85 chip slots (layout-sim.mjs chipSpots): 17 positions nearest the middle first, five sides each.</summary>
    public static readonly Spot[] ChipSpots = BuildChipSpots();

    private static Spot[] BuildChipSpots()
    {
        var positions = new List<double> { 0.5 };
        for (var k = 1; k <= 8; k++) { var step = k * 0.05; positions.Add(0.5 - step); positions.Add(0.5 + step); }
        return positions.SelectMany(position => { var t = Math.Round(position * 100, MidpointRounding.AwayFromZero) / 100; return ChipSides.Select(side => new Spot(t, side)); }).ToArray();
    }

    /// <summary>
    /// A centered chip floats above the path and a tail points at the path point; other sides put the chip's edge on the point (no tail).
    /// With <paramref name="within"/> (the drawable rect D) the box grown by 4 pt is slid just enough to lie inside D (layout-sim.mjs intoArea).
    /// </summary>
    public static (GraphRect Tag, GraphRect Area) ChipFrame(GraphPoint point, GraphSize size, GraphVector side = default, GraphRect? within = null)
    {
        var sided = side != default;
        var tag = sided
            ? new GraphRect(point.X + side.Dx * size.Width / 2 - size.Width / 2, point.Y + side.Dy * size.Height / 2 - size.Height / 2, size.Width, size.Height)
            : new GraphRect(point.X - size.Width / 2, point.Y - size.Height - ChipFloat, size.Width, size.Height);
        var box = sided ? tag : tag.Union(TailBox(point, tag));
        if (within is { } area)
        {
            var grown = box.InsetBy(-ChipGap, -ChipGap); var slid = IntoArea(grown, area);
            var dx = slid.MinX - grown.MinX; var dy = slid.MinY - grown.MinY;
            if (dx != 0 || dy != 0) { tag = tag.OffsetBy(dx, dy); box = sided ? tag : tag.Union(TailBox(point, tag)); }
        }
        return (tag, box);
    }

    /// <summary>Tail base center x: right above the path point, kept inside the chip's rounded edge.</summary>
    public static double TailBase(GraphPoint point, GraphRect tag)
    {
        var low = tag.MinX + TailInset;
        return Math.Min(Math.Max(point.X, low), Math.Max(low, tag.MaxX - TailInset));
    }

    private static GraphRect TailBox(GraphPoint point, GraphRect tag)
    {
        if (!(point.Y > tag.MaxY)) return tag;
        var tail = TailBase(point, tag);
        return new(Math.Min(tail, point.X) - 4, tag.MaxY, Math.Abs(tail - point.X) + 8, point.Y - tag.MaxY);
    }

    /// <summary>Slides a box into <paramref name="area"/> one axis at a time (layout-sim.mjs intoArea/slide); a box longer than the area aligns its start.</summary>
    public static GraphRect IntoArea(GraphRect box, GraphRect area)
    {
        static double Slide(double lo, double hi, double start, double end) => hi - lo > end - start ? start - lo : Math.Max(0, start - lo) - Math.Max(0, hi - end);
        return box.OffsetBy(Slide(box.MinX, box.MaxX, area.MinX, area.MaxX), Slide(box.MinY, box.MaxY, area.MinY, area.MaxY));
    }

    /// <summary>layout-sim.mjs onScreen.</summary>
    public static bool OnScreen(GraphRect box, GraphRect area) =>
        box.MinX >= area.MinX - 1e-6 && box.MinY >= area.MinY - 1e-6 && box.MaxX <= area.MaxX + 1e-6 && box.MaxY <= area.MaxY + 1e-6;

    /// <summary>The chip grown by 4 pt is taller than D (Oversize chip): no slide fits it, so it has no free slot.</summary>
    public static bool IsOversize(GraphSize size, GraphRect within) => size.Height + 2 * ChipGap > within.Height;

    /// <summary>Oversize peek: a box exactly D tall (grown by 4 pt) at D's top, same column.</summary>
    public static (GraphRect Tag, GraphRect Area) PeekFrame((GraphRect Tag, GraphRect Area) frame, GraphRect within)
    {
        var tag = new GraphRect(frame.Tag.MinX, within.MinY + ChipGap, frame.Tag.Width, within.Height - 2 * ChipGap);
        return (tag, tag);
    }

    /// <summary>The tap area: parts smaller than 44 pt grow from their center.</summary>
    public static GraphRect TapTarget(GraphRect rect) => rect.InsetBy(Math.Min(0, (rect.Width - TapTargetSide) / 2), Math.Min(0, (rect.Height - TapTargetSide) / 2));

    // MARK: Names

    /// <summary>The name's text box inside its slot; <paramref name="measureName"/> gives the text width at the name font.</summary>
    public static GraphRect TextBox(GraphRect box, string name, Func<string, double> measureName)
    {
        var width = Math.Min(box.Width, Math.Ceiling(measureName(name)));
        return new(box.MidX - width / 2, box.MinY, width, box.Height);
    }

    /// <summary>Name slot below, else above the avatar when the text below meets another avatar grown by 4 pt, else below and hidden.</summary>
    public static (GraphRect Frame, bool Hidden) PlaceName(GraphRect avatar, string name, double width, double height, IReadOnlyList<GraphRect> others, Func<string, double> measureName)
    {
        bool Covered(GraphRect box) { var text = TextBox(box, name, measureName); return others.Any(other => other.InsetBy(-ChipGap, -ChipGap).Intersects(text)); }
        var below = new GraphRect(avatar.MidX - width / 2, avatar.MaxY + 6, width, height);
        if (!Covered(below)) return (below, false);
        var above = below.OffsetBy(0, -(avatar.Height + 12 + height));
        return Covered(above) ? (below, true) : (above, false);
    }

    // MARK: Uncrossing (layout-sim.mjs crossings / bestSwap)

    private static bool Crosses(GraphPoint a, GraphPoint b, GraphPoint c, GraphPoint d)
    {
        static int Side(GraphPoint p, GraphPoint q, GraphPoint r)
        {
            var cross = (q.X - p.X) * (r.Y - p.Y) - (q.Y - p.Y) * (r.X - p.X);
            return cross > 0 ? 1 : cross < 0 ? -1 : 0;
        }
        return Side(a, b, c) * Side(a, b, d) < 0 && Side(c, d, a) * Side(c, d, b) < 0;
    }

    private static int CrossCount(IReadOnlyList<GraphPoint> p, IEnumerable<(int, int)> list, IReadOnlyList<(int, int)> all)
    {
        var count = 0;
        foreach (var (a, b) in list)
            foreach (var (e, f) in all)
                if (a != e && a != f && b != e && b != f && Crosses(p[a], p[b], p[e], p[f])) count++;
        return count;
    }

    private static List<(int, int)> UniquePairs(IEnumerable<(int, int)> edges)
    {
        var seen = new HashSet<(int, int)>(); var result = new List<(int, int)>();
        foreach (var (a, b) in edges) { var pair = (Math.Min(a, b), Math.Max(a, b)); if (seen.Add(pair)) result.Add(pair); }
        return result;
    }

    /// <summary>Crossings of the edges as straight segments (A to B and B to A are one segment; segments that share a node never cross).</summary>
    public static int Crossings(IReadOnlyList<GraphPoint> p, IEnumerable<(int, int)> edges)
    {
        var pairs = UniquePairs(edges);
        return CrossCount(p, pairs, pairs) / 2;
    }

    /// <summary>
    /// The pair whose swap removes the most crossings (ties: the first pair in index order); null when nothing improves.
    /// With <paramref name="clear"/> (each node's box relative to its center), an edge running through an unrelated node box counts as one crossing.
    /// </summary>
    public static ((int, int) Pair, int Gain)? BestSwap(IReadOnlyList<GraphPoint> p, IEnumerable<(int, int)> edges, IReadOnlyList<GraphRect>? clear = null)
    {
        var pairs = UniquePairs(edges);
        var adjacent = Enumerable.Range(0, p.Count).Select(i => pairs.Where(pair => pair.Item1 == i || pair.Item2 == i).ToList()).ToList();
        int Passes(GraphPoint[] q, int i, int j)
        {
            if (clear is null) return 0;
            bool Hit(int a, int b, int k) => k != a && k != b && SegmentHitsBox(q[a], q[b], clear[k].OffsetBy(q[k].X, q[k].Y));
            var count = 0;
            foreach (var (a, b) in pairs)
            {
                if (a == i || a == j || b == i || b == j) { for (var k = 0; k < q.Length; k++) if (Hit(a, b, k)) count++; }
                else { if (Hit(a, b, i)) count++; if (Hit(a, b, j)) count++; }
            }
            return count;
        }
        int Local(GraphPoint[] q, int i, int j)
        {
            var seen = new HashSet<(int, int)>(); var mine = new List<(int, int)>();
            foreach (var edge in adjacent[i].Concat(adjacent[j])) if (seen.Add(edge)) mine.Add(edge);
            return CrossCount(q, mine, pairs) - CrossCount(q, mine, mine) / 2 + Passes(q, i, j);
        }
        var points = p.ToArray();
        ((int, int) Pair, int Gain)? best = null;
        for (var i = 0; i < points.Length; i++)
            for (var j = i + 1; j < points.Length; j++)
            {
                if (adjacent[i].Count == 0 && adjacent[j].Count == 0) continue;
                var q = (GraphPoint[])points.Clone();
                (q[i], q[j]) = (q[j], q[i]);
                var gain = Local(points, i, j) - Local(q, i, j);
                if (gain > 0 && (best is null || gain > best.Value.Gain)) best = ((i, j), gain);
            }
        return best;
    }

    // MARK: Clearance (layout-sim.mjs segmentHitsBox / chipAt / clearance)

    /// <summary>Whether segment ab enters rect r (Liang-Barsky).</summary>
    public static bool SegmentHitsBox(GraphPoint a, GraphPoint b, GraphRect r)
    {
        double t0 = 0, t1 = 1;
        var dx = b.X - a.X; var dy = b.Y - a.Y;
        foreach (var (p, q) in new[] { (-dx, a.X - r.MinX), (dx, r.MaxX - a.X), (-dy, a.Y - r.MinY), (dy, r.MaxY - a.Y) })
        {
            if (p == 0) { if (q < 0) return false; continue; }
            var t = q / p;
            if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
            else { if (t < t0) return false; if (t < t1) t1 = t; }
        }
        return true;
    }

    // Boxes that only share an edge do not meet (layout-sim.mjs boxesMeet).
    private static bool BoxesMeet(GraphRect r, GraphRect q) => r.MinX < q.MaxX && q.MinX < r.MaxX && r.MinY < q.MaxY && q.MinY < r.MaxY;

    /// <summary>
    /// When every slot is blocked by some node box (own ends included, not grown), the blocked chip's box at t = 0.5 grown by 4 pt; else null.
    /// </summary>
    public static GraphRect? BlockedChip(IReadOnlyList<GraphPoint> p, IReadOnlyList<GraphRect> boxes, int a, int b, GraphSize size)
    {
        GraphRect Area(double t, GraphVector side = default) =>
            ChipFrame(new(p[a].X + (p[b].X - p[a].X) * t, p[a].Y + (p[b].Y - p[a].Y) * t), size, side).Area.InsetBy(-ChipGap, -ChipGap);
        var members = Enumerable.Range(0, p.Count).Select(i => boxes[i].OffsetBy(p[i].X, p[i].Y)).ToList();
        foreach (var spot in ChipSpots)
        {
            var area = Area(spot.T, spot.Side);
            if (!members.Any(member => BoxesMeet(area, member))) return null;
        }
        return Area(0.5);
    }

    /// <summary>
    /// Forces pushing unrelated nodes off lines and blocked chips (behavior-spec.md "Clearance"). <paramref name="p"/> are points,
    /// <paramref name="boxes"/> node boxes relative to their centers, <paramref name="edges"/> the open requests (Chip: its size, or null).
    /// Line pushes run once per pair of members; chip pushes and the line stretch run per request that has a chip.
    /// </summary>
    public static GraphVector[] Clearance(IReadOnlyList<GraphPoint> p, IReadOnlyList<GraphRect> boxes, IEnumerable<(int A, int B, GraphSize? Chip)> edges)
    {
        const double kc = ClearanceForce;
        var force = new GraphVector[p.Count];
        void Add(int i, double dx, double dy) => force[i] = new(force[i].Dx + dx, force[i].Dy + dy);
        void Push(int c, int a, int b, double ta, double nx, double ny)
        {
            var d = Math.Sqrt(nx * nx + ny * ny) == 0 ? 1 : Math.Sqrt(nx * nx + ny * ny);
            var fu = kc * nx / d; var fv = kc * ny / d;
            Add(c, fu, fv); Add(a, -fu * (1 - ta), -fv * (1 - ta)); Add(b, -fu * ta, -fv * ta);
        }
        var drawn = new HashSet<(int, int)>();
        foreach (var (a, b, size) in edges)
        {
            var ex = p[b].X - p[a].X; var ey = p[b].Y - p[a].Y; var el = ex * ex + ey * ey == 0 ? 1 : ex * ex + ey * ey;
            var chip = size is { } s ? BlockedChip(p, boxes, a, b, s) : null;
            if (chip is { } blocked && new[] { a, b }.Any(i => BoxesMeet(blocked, boxes[i].OffsetBy(p[i].X, p[i].Y))))
            {
                // The chip does not fit between its own ends: stretch the line.
                var d = Math.Sqrt(el);
                Add(a, -kc * ex / d, -kc * ey / d); Add(b, kc * ex / d, kc * ey / d);
            }
            var newLine = drawn.Add((Math.Min(a, b), Math.Max(a, b)));
            for (var c = 0; c < p.Count; c++)
            {
                if (c == a || c == b) continue;
                var plain = boxes[c].OffsetBy(p[c].X, p[c].Y); var grown = plain.InsetBy(-ClearGap, -ClearGap);
                var cx = grown.MidX; var cy = grown.MidY;
                if (newLine && SegmentHitsBox(p[a], p[b], grown))
                {
                    var t = Math.Min(1, Math.Max(0, ((cx - p[a].X) * ex + (cy - p[a].Y) * ey) / el));
                    double nx = cx - (p[a].X + t * ex), ny = cy - (p[a].Y + t * ey);
                    if (Math.Sqrt(nx * nx + ny * ny) < 1e-6) { nx = -ey; ny = ex; }
                    Push(c, a, b, t, nx, ny);
                }
                if (chip is { } shut && BoxesMeet(shut, plain)) Push(c, a, b, 0.5, cx - shut.MidX, cy - shut.MidY);
            }
        }
        return force;
    }

    // MARK: Motion

    /// <summary>Blink opacity; measured from activeSince so every app shows the same phase for the same member.</summary>
    public static double Blink(double now, double activeSince) => 0.25 + 0.65 * (0.5 + 0.5 * Math.Sin(2 * Math.PI * (now - activeSince) / 1.6));

    public static uint Fnv1a(string text)
    {
        uint hash = 0x811c9dc5;
        foreach (var value in Encoding.UTF8.GetBytes(text)) hash = unchecked((hash ^ value) * 0x01000193);
        return hash;
    }

    /// <summary>cubic-bezier(x1, y1, x2, y2) progress at time t; x is solved by bisection.</summary>
    public static double Bezier(double t, double x1, double y1, double x2, double y2)
    {
        static double Curve(double s, double a, double b) => 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s;
        double low = 0, high = 1, s = t;
        for (var i = 0; i < 24; i++)
        {
            if (Curve(s, x1, x2) < t) low = s; else high = s;
            s = (low + high) / 2;
        }
        return Curve(s, y1, y2);
    }
}
