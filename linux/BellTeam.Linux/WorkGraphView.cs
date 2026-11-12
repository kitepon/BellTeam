using System.Globalization;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Automation.Peers;
using Avalonia.Automation.Provider;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;
using static BellTeam.Core.WorkGraphSimulation;

namespace BellTeam.Linux;

internal readonly record struct WorkGraphItem(bool IsMember, string Id);

/// <summary>
/// 相関図: one element drawn every frame while it runs (docs/architecture/modules/work-graph/behavior-spec.md). Port of the Mac WorkGraphView:
/// edges, blocked chips, nodes, unblocked chips, then the chip being pointed at. State lives in <see cref="Model"/>, never here.
/// </summary>
public sealed class WorkGraphCanvas : Control
{
    private const double BaseSide = 64;      // Mac window drawing
    private const double FramePeriod = 1.0 / 30;

    public WorkGraphModel Model { get; }
    internal Action<string>? OpenMember { get; set; }
    /// <summary>Raised when the notice or the pill text changes; the window shows them as text elements.</summary>
    internal event Action? StatusChanged;
    public bool Running => cancel is not null;

    private readonly Func<string, string, Task<Bitmap>>? loadAvatar;
    private readonly Dictionary<string, AvatarSlot> avatars = [];
    private readonly Dictionary<(string, bool, double), (FormattedText Text, Geometry? Halo)> names = [];
    private readonly DispatcherTimer ticker = new() { Interval = TimeSpan.FromSeconds(FramePeriod) };
    private Dictionary<string, Shape> shapes = [];
    private CancellationTokenSource? cancel;
    private GraphPoint? hover;
    private WorkGraphPress? press;
    private double frameNow, lastFrame, emptyAlpha;
    private string? fault;
    private (string? Notice, string? Pill) status;

    public WorkGraphCanvas(Func<string, string, Task<Bitmap>>? loadAvatar = null, Func<double>? clock = null)
    {
        this.loadAvatar = loadAvatar;
        Model = clock is null ? new WorkGraphModel(Measure) { BaseSide = BaseSide } : new WorkGraphModel(Measure) { BaseSide = BaseSide, Clock = clock };
        double Measure(string name) => WorkGraphText.NameWidth(name);
        ClipToBounds = true; Focusable = true; KeyboardNavigation.SetTabNavigation(this, KeyboardNavigationMode.Contained);
        AutomationProperties.SetAutomationId(this, "work-graph");
        // 30 frames a second are smooth enough; every display frame cost the Mac 94 % of a core.
        ticker.Tick += (_, _) => { var now = Model.Clock(); if (now - lastFrame >= FramePeriod - 0.002) Frame(now); };
        DetachedFromVisualTree += (_, _) => Stop();
    }

    // MARK: Running

    /// <summary>Opens the stream and starts drawing frames. <paramref name="connection"/> ends the run when the connection it belongs to is replaced.</summary>
    public void Run(WorkGraphStreamOpener opener, CancellationToken connection = default)
    {
        if (cancel is not null) return;
        var source = cancel = CancellationTokenSource.CreateLinkedTokenSource(connection);
        fault = null; lastFrame = 0;
        ticker.Start();
        _ = RunAsync(opener, source);
    }

    private async Task RunAsync(WorkGraphStreamOpener opener, CancellationTokenSource source)
    {
        try { await Model.RunAsync(opener, source.Token); }
        catch (OperationCanceledException) when (source.IsCancellationRequested) { }
        // A bug in the model is shown, not swallowed: the stream is not retried.
        catch (Exception error) { fault = "相関図でエラーが起きました: " + error.Message; }
        finally
        {
            if (ReferenceEquals(cancel, source)) { cancel = null; ticker.Stop(); }
            source.Dispose();
            // The last state (a sign-in is needed, the server is old) is drawn once; no more frames follow.
            UpdateStatus(); InvalidateVisual();
        }
    }

    /// <summary>Closes the stream and stops drawing (window closed or minimized). Run starts again with a new snapshot that is diffed against the drawn graph.</summary>
    public void Stop()
    {
        hover = null; press = null;
        if (cancel is not { } source) return;
        cancel = null;
        ticker.Stop();
        source.Cancel();
    }

    // MARK: Frame

    /// <summary>One frame: step the simulation, place the chips, and draw. Time is passed in so a seam can run the graph without waiting.</summary>
    internal void Frame(double now)
    {
        if (Bounds.Width < 1 || Bounds.Height < 1) return;
        lastFrame = frameNow = now;
        Model.Step(now, new GraphSize(Bounds.Width, Bounds.Height), default);
        var side = Model.Side(Math.Max(1, Model.LiveCount));
        shapes = [];
        foreach (var line in Model.Lines.Values.OrderBy(line => line.Edge.Id, StringComparer.Ordinal))
            if (ShapeOf(line, now, side) is { } shape) shapes[line.Edge.Id] = shape;
        var pointed = hover is { } at ? Model.HitTest(at, now) : null;
        var edge = pointed is { Kind: WorkGraphModel.HitKind.Chip or WorkGraphModel.HitKind.Edge } hit ? hit.Id : null;
        // Mouse: a line pointed at shows its waiting chip; a member pointed at shows its hidden name.
        Model.LayoutChips(shapes.Select(pair => new WorkGraphModel.EdgePath(pair.Key, pair.Value.Point)).ToList(),
            WorkGraphText.ChipSize, edge, now, edge, pointed is { Kind: WorkGraphModel.HitKind.Member } member ? member.Id : null);
        emptyAlpha = Math.Min(1, Math.Max(0, emptyAlpha + (Model.IsEmpty && Model.Connection == WorkGraphConnection.Live ? 1 : -1) * FramePeriod / 0.3));
        InvalidateVisual();
        UpdateStatus();
    }

    private void UpdateStatus()
    {
        var next = Model.Connection switch
        {
            WorkGraphConnection.Unsupported => ("このサーバーでは相関図をまだ使えません", (string?)null),
            WorkGraphConnection.Failed => (Model.FailedMessage, null),
            WorkGraphConnection.Reconnecting => (null, "再接続中…"),
            WorkGraphConnection.Unreadable => (null, "相関図の応答を読めませんでした。再接続しています…"),
            WorkGraphConnection.Live when Model.Degraded => (null, "一部の情報を取得できていません"),
            _ => (null, null)
        };
        if (fault is not null) next = (fault, null);
        if (next == status) return;
        status = next; StatusChanged?.Invoke();
    }

    internal (string? Notice, string? Pill) Status => status;

    // MARK: Edge geometry

    private sealed record Shape(Func<double, GraphPoint> Point, double Length, bool Curved);

    /// <summary>The line between two members' borders; curved to the left of travel when the opposite request is also open (18 % of the length).</summary>
    private Shape? ShapeOf(WorkGraphModel.Line line, double now, double side)
    {
        if (!Model.Bodies.TryGetValue(line.Edge.From, out var a) || !Model.Bodies.TryGetValue(line.Edge.To, out var b)) return null;
        GraphPoint pa = Model.Appearance(a, now).Point, pb = Model.Appearance(b, now).Point;
        double dx = pb.X - pa.X, dy = pb.Y - pa.Y, distance = Math.Sqrt(dx * dx + dy * dy);
        if (!(distance > side)) return null;
        double ux = dx / distance, uy = dy / distance;
        var start = new GraphPoint(pa.X + ux * side / 2, pa.Y + uy * side / 2);
        var end = new GraphPoint(pb.X - ux * side / 2, pb.Y - uy * side / 2);
        var length = Math.Sqrt((end.X - start.X) * (end.X - start.X) + (end.Y - start.Y) * (end.Y - start.Y));
        var reverse = Model.Lines.Values.Any(other => other.Edge.From == line.Edge.To && other.Edge.To == line.Edge.From && other.EndedAt is null);
        if (!reverse) return new(t => new(start.X + (end.X - start.X) * t, start.Y + (end.Y - start.Y) * t), length, false);
        var control = new GraphPoint((start.X + end.X) / 2 + uy * length * 0.18, (start.Y + end.Y) / 2 - ux * length * 0.18);
        return new(t => new((1 - t) * (1 - t) * start.X + 2 * (1 - t) * t * control.X + t * t * end.X, (1 - t) * (1 - t) * start.Y + 2 * (1 - t) * t * control.Y + t * t * end.Y), length, true);
    }

    private static Geometry Trimmed(Shape shape, double grow)
    {
        var geometry = new StreamGeometry();
        using (var context = geometry.Open())
        {
            var steps = shape.Curved ? 24 : 1;
            var first = shape.Point(0);
            context.BeginFigure(new Point(first.X, first.Y), false);
            for (var i = 1; i <= steps; i++) { var p = shape.Point(grow * i / steps); context.LineTo(new Point(p.X, p.Y)); }
            context.EndFigure(false);
        }
        return geometry;
    }

    // MARK: Colours and avatars

    private sealed class AvatarSlot { public ImageBrush? Image; public Color? Tone; public bool Failed; }

    private AvatarSlot Slot(WorkGraphNode node)
    {
        var key = node.BotId + "|" + node.AvatarVersion;
        if (avatars.TryGetValue(key, out var slot)) return slot;
        slot = avatars[key] = new();
        if (!string.IsNullOrEmpty(node.AvatarVersion) && loadAvatar is not null) _ = LoadAvatarAsync(key, slot, node);
        return slot;
    }

    private async Task LoadAvatarAsync(string key, AvatarSlot slot, WorkGraphNode node)
    {
        try
        {
            var bitmap = await loadAvatar!(node.BotId, node.AvatarVersion!);
            slot.Image = new ImageBrush(bitmap) { Stretch = Stretch.UniformToFill }; slot.Tone = WorkGraphColors.Representative(bitmap);
        }
        // The connection ended: the next frame asks again.
        catch (OperationCanceledException) { avatars.Remove(key); }
        // Shown as "!" on the tile, as the conversation list does.
        catch (Exception) { slot.Failed = true; }
    }

    /// <summary>The requester's colour: the avatar picture's representative colour, else the node's colour (Mac AvatarTone).</summary>
    private Color Tone(string botId) =>
        Model.Bodies.TryGetValue(botId, out var body) ? Slot(body.Node).Tone ?? BellColors.Accent(body.Node.Color) : BellColors.Accent("violet");

    // MARK: Drawing

    private static Rect R(GraphRect rect) => new(rect.X, rect.Y, Math.Max(0, rect.Width), Math.Max(0, rect.Height));
    private static Point P(GraphPoint point) => new(point.X, point.Y);
    private static readonly Dictionary<(Color, byte), IBrush> SolidCache = [];
    private static IBrush Solid(Color color, double alpha = 1)
    {
        var key = (color, (byte)Math.Round(alpha * 255));
        if (SolidCache.TryGetValue(key, out var known)) return known;
        if (SolidCache.Count > 256) SolidCache.Clear();
        return SolidCache[key] = new Avalonia.Media.Immutable.ImmutableSolidColorBrush(WorkGraphColors.Alpha(color, alpha));
    }

    private static Pen Stroke(Color color, double alpha, double width, double[] dash, bool round, double phase = 0)
    {
        // A dash is counted in pen widths; the spec counts points.
        var dashes = dash.Length == 0 ? null : new DashStyle(dash.Select(length => length / width), phase / width);
        return new Pen(Solid(color, alpha), width, dashes, round ? PenLineCap.Round : PenLineCap.Flat, PenLineJoin.Round);
    }

    public override void Render(DrawingContext context)
    {
        base.Render(context);
        // Transparent, so the whole area takes the pointer.
        context.DrawRectangle(Brushes.Transparent, null, new Rect(Bounds.Size));
        if (Model.Connection is WorkGraphConnection.Unsupported or WorkGraphConnection.Failed) return;
        var live = Model.Connection == WorkGraphConnection.Live;
        var now = frameNow;
        foreach (var line in Model.Lines.Values.OrderBy(line => line.Edge.Id, StringComparer.Ordinal))
            if (shapes.TryGetValue(line.Edge.Id, out var shape)) DrawEdge(context, line, shape, now, live);
        // A chip with no free place stays just above the lines and below members, names and the other chips (behavior-spec.md "Edges").
        DrawChips(context, Model.Chips.Blocked);
        foreach (var id in Model.Order) if (Model.Bodies.TryGetValue(id, out var body)) DrawNode(context, body, now, live);
        DrawChips(context, Model.Chips.Unblocked.Concat(Model.Chips.Above));
        if (emptyAlpha > 0) DrawEmpty(context);
    }

    /// <summary>A request's line: the requester's colour, a bright streak running from requester to receiver, an arrowhead at the receiver.</summary>
    private void DrawEdge(DrawingContext context, WorkGraphModel.Line line, Shape shape, double now, bool live)
    {
        var tone = Tone(line.Edge.From);
        Color wire = WorkGraphColors.Wire(tone), spark = WorkGraphColors.Spark(tone);
        var grow = 1 - Math.Pow(1 - Math.Min(Math.Max((now - line.StartedAt) / 0.35, 0), 1), 3);
        var fade = line.EndedAt is { } ended ? Math.Max(0, 1 - (now - ended) / EdgeEndSeconds) : 1;
        using var opacity = context.PushOpacity(fade * (line.Edge.Steered ? 0.75 : 1));
        // A fork edge is dashed (6 pt line, 4 pt gap); a round cap would fill the gaps of the wide cover, so a dashed line has flat ends.
        var dash = line.Edge.BaseDash; var round = dash.Length == 0;
        var drawn = Trimmed(shape, grow);
        context.DrawGeometry(null, Stroke(wire, 0.18, 7, dash, round), drawn);
        context.DrawGeometry(null, Stroke(wire, 0.9, 2.5, dash, round), drawn);
        if (grow < 1) return;
        var tip = shape.Point(1); var back = shape.Point(Math.Max(0, 1 - 11 / Math.Max(shape.Length, 1)));
        double ax = tip.X - back.X, ay = tip.Y - back.Y, al = Math.Max(Math.Sqrt(ax * ax + ay * ay), 0.001), ux = ax / al, uy = ay / al;
        var arrow = new StreamGeometry();
        using (var arrowContext = arrow.Open())
        {
            arrowContext.BeginFigure(P(tip), true);
            arrowContext.LineTo(new Point(tip.X - ux * 11 + uy * 5.5, tip.Y - uy * 11 - ux * 5.5));
            arrowContext.LineTo(new Point(tip.X - ux * 11 - uy * 5.5, tip.Y - uy * 11 + ux * 5.5));
            arrowContext.EndFigure(true);
        }
        context.DrawGeometry(Solid(wire), null, arrow);
        // The flow: two strokes of different widths run at 90 pt/s, no blur (it is too heavy every frame). Reduce Motion keeps only the arrow.
        if (live && !Model.ReduceMotion && line.EndedAt is null)
        {
            var phase = (((-(now - line.StartedAt - 0.35) * 90) % 46) + 46) % 46;
            var whole = Trimmed(shape, 1);
            context.DrawGeometry(null, Stroke(spark, 0.35, 5, [16, 30], true, phase), whole);
            context.DrawGeometry(null, Stroke(spark, 1, 1.8, [16, 30], true, phase), whole);
        }
    }

    private void DrawNode(DrawingContext context, WorkGraphModel.Body body, double now, bool live)
    {
        var look = Model.Appearance(body, now);
        var (avatar, nameFrame) = Model.Frames(body, now);
        var node = body.Node; var slot = Slot(node);
        Color Tint(Color color) => live ? color : WorkGraphColors.Dim(color);
        var accent = Tint(BellColors.Accent(node.Color));
        using var all = context.PushOpacity(look.Opacity);
        if (node.Working)
        {
            var radius = avatar.Width / 2 + 5;
            var ring = new Rect(look.Point.X - radius, look.Point.Y - radius, radius * 2, radius * 2);
            var strength = Model.ReduceMotion || !live ? 0.8 : Blink(now, body.ActiveSince);
            // The glow is a wide faint stroke under the ring.
            context.DrawRectangle(null, Stroke(accent, strength * 0.22, 9, [], false), ring, radius * 0.62, radius * 0.62);
            context.DrawRectangle(null, Stroke(accent, strength, 3, [], false), ring, radius * 0.62, radius * 0.62);
        }
        // A linked member (it only receives requests) is drawn fainter.
        var tile = R(avatar); var corner = tile.Width * 0.31;
        using (context.PushOpacity(node.Working ? 1 : 0.55))
        {
            using (context.PushClip(new RoundedRect(tile, corner)))
            {
                var gradient = new LinearGradientBrush { StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative), EndPoint = new RelativePoint(1, 1, RelativeUnit.Relative), GradientStops = [new GradientStop(WorkGraphColors.Alpha(accent, 0.73), 0), new GradientStop(accent, 1)] };
                context.DrawRectangle(gradient, null, tile, corner, corner);
                if (slot.Image is { } picture)
                {
                    context.DrawRectangle(picture, null, tile, corner, corner);
                    if (!live) context.DrawRectangle(Solid(Color.FromRgb(0x80, 0x80, 0x80), 0.35), null, tile);
                }
                else
                {
                    var letter = new FormattedText(slot.Failed ? "!" : StringInfo.GetNextTextElement(node.Name), CultureInfo.GetCultureInfo("ja-JP"), FlowDirection.LeftToRight, WorkGraphText.Letter, tile.Width * 0.42, Brushes.White);
                    context.DrawText(letter, new Point(tile.X + (tile.Width - letter.Width) / 2, tile.Y + (tile.Height - letter.Height) / 2));
                }
            }
            context.DrawRectangle(null, new Pen(Solid(Colors.White, 0.7), 1), new Rect(tile.X + 0.5, tile.Y + 0.5, Math.Max(0, tile.Width - 1), Math.Max(0, tile.Height - 1)), corner, corner);
        }
        if (IsFocused && FocusedMember == node.BotId)
        {
            var focus = new Rect(tile.X - 6, tile.Y - 6, tile.Width + 12, tile.Height + 12);
            context.DrawRectangle(null, new Pen(BellTheme.Violet, 2), focus, corner + 6, corner + 6);
        }
        if (!Model.NameHidden(body, now)) DrawName(context, node, nameFrame);
    }

    /// <summary>A name with a 3 pt halo in the canvas colour, so a line or chip below it cannot cut through the letters (behavior-spec.md "Clearance").</summary>
    private void DrawName(DrawingContext context, WorkGraphNode node, GraphRect frame)
    {
        var key = (node.Name, node.Working, Math.Round(frame.Width, 1));
        if (!names.TryGetValue(key, out var cached))
        {
            if (names.Count > 256) names.Clear();
            var text = WorkGraphText.Line(node.Name, WorkGraphText.Name, NameFontSize, node.Working ? WorkGraphText.Ink : WorkGraphText.Muted, frame.Width);
            names[key] = cached = (text, text.BuildGeometry(new Point(0, 0)));
        }
        var origin = new Point(frame.X, frame.Y + (frame.Height - cached.Text.Height) / 2);
        using var move = context.PushTransform(Matrix.CreateTranslation(origin.X, origin.Y));
        if (cached.Halo is { } halo) context.DrawGeometry(null, new Pen(WorkGraphText.Canvas, NameHaloWidth, null, PenLineCap.Flat, PenLineJoin.Round), halo);
        context.DrawText(cached.Text, new Point(0, 0));
    }

    private void DrawChips(DrawingContext context, IEnumerable<WorkGraphModel.PlacedChip> chips)
    {
        foreach (var chip in chips)
        {
            if (chip.Opacity <= 0) continue;
            var from = Model.Lines.TryGetValue(chip.Id, out var line) ? line.Edge.From : "";
            using var opacity = context.PushOpacity(chip.Opacity);
            DrawTag(context, chip, WorkGraphColors.Wire(Tone(from)));
        }
    }

    /// <summary>A request's chip: white with the requester's colour as border and left bar, an envelope, and a tail towards the line. The shadow is one offset copy, not blurred.</summary>
    private static void DrawTag(DrawingContext context, WorkGraphModel.PlacedChip chip, Color wire)
    {
        GraphRect tag = chip.Tag; var point = chip.Anchor;
        var rect = R(tag);
        // Only a chip floating above the line (centered) has a tail; one with an edge on the point touches it.
        // A chip slid into D slides its tail base along its edge and still points at the line.
        if (point.Y > tag.MaxY)
        {
            var baseX = TailBase(point, tag);
            var tail = new StreamGeometry();
            using (var tailContext = tail.Open())
            {
                tailContext.BeginFigure(new Point(baseX - 5, tag.MaxY - 0.5), true);
                tailContext.LineTo(new Point(point.X, point.Y - 1));
                tailContext.LineTo(new Point(baseX + 5, tag.MaxY - 0.5));
                tailContext.EndFigure(true);
            }
            context.DrawGeometry(Solid(wire), null, tail);
        }
        context.DrawRectangle(Solid(Color.FromRgb(0x21, 0x29, 0x3D), 0.08), null, new Rect(rect.X, rect.Y + 1.5, rect.Width, rect.Height), 9, 9);
        context.DrawRectangle(Brushes.White, new Pen(Solid(wire, 0.55), 1), rect, 9, 9);
        using (context.PushClip(new RoundedRect(rect, 9)))
            context.DrawRectangle(Solid(wire), null, new Rect(rect.X, rect.Y, 4, rect.Height));
        // An Oversize chip (taller than D) shows its text scrolled up inside the box, cut 3 pt from its edge.
        using IDisposable? clip = chip.Content > 0 ? context.PushClip(new Rect(rect.X, rect.Y + 3, rect.Width, Math.Max(0, rect.Height - 6))) : null;
        var top = rect.Y + 5 - chip.Scroll;
        // The envelope sits at the first line's height, not the middle of a tall chip.
        // Mac envelope.fill: a filled body with the flap as a white V.
        var envelope = new Rect(rect.X + 9, top + (ChipLineHeight - 10) / 2, WorkGraphText.DetailSize, 10);
        context.DrawRectangle(Solid(wire), null, envelope, 1.5, 1.5);
        var flap = new StreamGeometry();
        using (var flapContext = flap.Open()) { flapContext.BeginFigure(new Point(envelope.X + 1.3, envelope.Y + 2.2), false); flapContext.LineTo(new Point(envelope.X + 7, envelope.Y + 6.2)); flapContext.LineTo(new Point(envelope.X + 12.7, envelope.Y + 2.2)); flapContext.EndFigure(false); }
        context.DrawGeometry(null, new Pen(Brushes.White, 1.1, null, PenLineCap.Round, PenLineJoin.Round), flap);
        context.DrawText(WorkGraphText.Label(chip.Text, WorkGraphText.TextColumn(tag.Width)), new Point(rect.X + 13 + WorkGraphText.DetailSize, top));
    }

    private void DrawEmpty(DrawingContext context)
    {
        var center = new Point(Model.Area.MidX, Model.Area.MidY);
        using var opacity = context.PushOpacity(emptyAlpha);
        // A soft violet circle (220 pt, 8 %) stands in for the Mac's blurred one.
        var glow = new RadialGradientBrush { GradientStops = [new GradientStop(Color.FromArgb(20, 0x61, 0x47, 0xD4), .55), new GradientStop(Color.FromArgb(0, 0x61, 0x47, 0xD4), 1)] };
        context.DrawEllipse(glow, null, center, 160, 160);
        var text = WorkGraphText.Caption("いま動いているメンバーはいません", NameFontSize, WorkGraphText.Muted);
        context.DrawText(text, new Point(center.X - text.Width / 2, center.Y - text.Height / 2));
    }

    // MARK: Input

    private GraphPoint At(PointerEventArgs e) { var p = e.GetPosition(this); return new(p.X, p.Y); }

    protected override void OnPointerMoved(PointerEventArgs e) { base.OnPointerMoved(e); MoveTo(At(e)); }
    protected override void OnPointerExited(PointerEventArgs e) { base.OnPointerExited(e); hover = null; }
    protected override void OnPointerPressed(PointerPressedEventArgs e)
    {
        base.OnPointerPressed(e);
        if (!e.GetCurrentPoint(this).Properties.IsLeftButtonPressed) return;
        Focus(); PressAt(At(e)); e.Pointer.Capture(this);
    }

    protected override void OnPointerReleased(PointerReleasedEventArgs e)
    {
        base.OnPointerReleased(e);
        if (e.InitialPressMouseButton != MouseButton.Left) return;
        // Released before the capture is dropped: losing the capture clears the press.
        ReleaseAt(At(e));
        e.Pointer.Capture(null);
    }

    protected override void OnPointerCaptureLost(PointerCaptureLostEventArgs e) { base.OnPointerCaptureLost(e); press = null; }

    internal void MoveTo(GraphPoint point)
    {
        hover = point;
        if (press is { } held) { var current = press; Model.UpdatePress(ref current, held.Start, point, Model.Clock()); press = current; }
    }

    /// <summary>The member is decided at press time (behavior-spec.md "Tap or click on a member").</summary>
    internal void PressAt(GraphPoint start)
    {
        var created = (WorkGraphPress?)null;
        Model.UpdatePress(ref created, start, start, Model.Clock());
        press = created;
    }

    /// <summary>Under 10 pt of movement and 500 ms is a click and opens the member pressed; hover alone never opens anything.</summary>
    internal void ReleaseAt(GraphPoint point)
    {
        if (press is not { } held) return;
        press = null;
        if (held.Release(point, Model.Clock()) is { } id) OpenMember?.Invoke(id);
    }

    /// <summary>The wheel scrolls the text of an Oversize chip while the pointer is on its box.</summary>
    protected override void OnPointerWheelChanged(PointerWheelEventArgs e)
    {
        base.OnPointerWheelChanged(e);
        // One notch moves three 16 pt lines; a wheel up moves the text down.
        if (Model.ScrollPeek(-e.Delta.Y * 3 * ChipLineHeight, At(e))) e.Handled = true;
    }

    // MARK: Keyboard (behavior-spec.md: activating a member with Enter/Space on Windows does the same as a tap)

    /// <summary>The member that has the keyboard focus; null until the canvas is focused.</summary>
    internal string? FocusedMember { get; private set; }

    protected override void OnGotFocus(FocusChangedEventArgs e)
    {
        base.OnGotFocus(e);
        if (FocusedMember is null || !Members().Contains(FocusedMember)) FocusedMember = Members().FirstOrDefault();
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (KeyPressed(e.Key, e.KeyModifiers.HasFlag(KeyModifiers.Shift))) e.Handled = true;
    }

    /// <summary>Tab, Shift+Tab and the arrow keys move between members in drawing order (wrapping); Enter and Space open the focused one.</summary>
    internal bool KeyPressed(Key key, bool shift)
    {
        var members = Members();
        if (members.Count == 0) return false;
        var index = FocusedMember is { } current ? members.IndexOf(current) : -1;
        switch (key)
        {
            case Key.Enter or Key.Space when index >= 0: OpenMember?.Invoke(members[index]); return true;
            case Key.Tab: FocusedMember = members[Wrap(index + (shift ? -1 : 1))]; return true;
            case Key.Right or Key.Down: FocusedMember = members[Wrap(index + 1)]; return true;
            case Key.Left or Key.Up: FocusedMember = members[Wrap(index - 1)]; return true;
            default: return false;
        }
        int Wrap(int value) => ((value % members.Count) + members.Count) % members.Count;
    }

    private List<string> Members() => Items().Where(item => item.IsMember).Select(item => item.Id).ToList();

    internal void FocusMember(string id) { FocusedMember = id; Focus(); }

    // MARK: Accessibility

    protected override AutomationPeer OnCreateAutomationPeer() => new WorkGraphPeer(this);

    /// <summary>The members, then the open requests ordered by id (behavior-spec.md "Accessibility and motion").</summary>
    internal IReadOnlyList<WorkGraphItem> Items() =>
    [
        .. Model.Order.Where(id => Model.Bodies.TryGetValue(id, out var body) && body.LeavingAt is null).Select(id => new WorkGraphItem(true, id)),
        .. Model.Lines.Values.Where(line => line.EndedAt is null).OrderBy(line => line.Edge.Id, StringComparer.Ordinal).Select(line => new WorkGraphItem(false, line.Edge.Id))
    ];

    internal string? Describe(WorkGraphItem item)
    {
        if (item.IsMember)
        {
            if (!Model.Bodies.TryGetValue(item.Id, out var body)) return null;
            var minutes = Math.Max(0, (int)((Model.Clock() - body.ActiveSince) / 60));
            return body.Node.Working ? $"{body.Node.Name}、作業中、{minutes}分前から" : $"{body.Node.Name}、依頼の相手";
        }
        if (!Model.Lines.TryGetValue(item.Id, out var line)) return null;
        string Name(string id) => Model.Bodies.TryGetValue(id, out var body) ? body.Node.Name : id;
        var sentence = $"{Name(line.Edge.From)}から{Name(line.Edge.To)}へ依頼";
        return line.Edge.ChipText is { } label ? $"{sentence}: {label}" : sentence;
    }

    /// <summary>The item's box in canvas coordinates; null when it is not drawn.</summary>
    internal Rect? ItemBounds(WorkGraphItem item)
    {
        GraphRect? rect = item.IsMember
            ? Model.Bodies.TryGetValue(item.Id, out var body) ? Model.Frames(body, Model.Clock()).Avatar : null
            : Model.Chips.Blocked.Concat(Model.Chips.Unblocked).Concat(Model.Chips.Above).FirstOrDefault(chip => chip.Id == item.Id)?.Tag;
        return rect is { } r ? new Rect(r.MinX, r.MinY, r.Width, r.Height) : null;
    }

    internal void Open(WorkGraphItem item) { if (item.IsMember) OpenMember?.Invoke(item.Id); }
}

/// <summary>The canvas as a group of members and requests, so a screen reader can read the graph and activate a member like a tap.</summary>
internal sealed class WorkGraphPeer(WorkGraphCanvas owner) : ControlAutomationPeer(owner)
{
    protected override AutomationControlType GetAutomationControlTypeCore() => AutomationControlType.Group;
    protected override string GetClassNameCore() => nameof(WorkGraphCanvas);
    protected override string GetNameCore() => "相関図";
    protected override IReadOnlyList<AutomationPeer> GetChildrenCore() => owner.Items().Select(item => (AutomationPeer)new WorkGraphItemPeer(this, owner, item)).ToList();
}

internal sealed class WorkGraphItemPeer(WorkGraphPeer parent, WorkGraphCanvas owner, WorkGraphItem item) : AutomationPeer, IInvokeProvider
{
    protected override string GetNameCore() => owner.Describe(item) ?? "";
    protected override AutomationControlType GetAutomationControlTypeCore() => item.IsMember ? AutomationControlType.Button : AutomationControlType.Text;
    protected override string GetClassNameCore() => item.IsMember ? "WorkGraphMember" : "WorkGraphRequest";
    protected override string GetAutomationIdCore() => (item.IsMember ? "work-graph-member-" : "work-graph-edge-") + item.Id;
    // Relative to the window, like ControlAutomationPeer's own rectangle.
    protected override Rect GetBoundingRectangleCore() => owner.ItemBounds(item) is { } bounds && TopLevel.GetTopLevel(owner) is { } root && owner.TranslatePoint(bounds.TopLeft, root) is { } at ? new Rect(at, bounds.Size) : default;
    protected override bool IsControlElementCore() => true;
    protected override bool IsContentElementCore() => true;
    protected override bool IsEnabledCore() => true;
    protected override bool IsKeyboardFocusableCore() => item.IsMember;
    protected override bool HasKeyboardFocusCore() => item.IsMember && owner.IsFocused && owner.FocusedMember == item.Id;
    protected override void SetFocusCore() { if (item.IsMember) owner.FocusMember(item.Id); }
    protected override string? GetAcceleratorKeyCore() => null;
    protected override string? GetAccessKeyCore() => null;
    protected override AutomationPeer? GetLabeledByCore() => null;
    protected override IReadOnlyList<AutomationPeer> GetOrCreateChildrenCore() => [];
    protected override AutomationPeer? GetParentCore() => parent;
    protected override bool ShowContextMenuCore() => false;
    protected override void BringIntoViewCore() { }
    protected override bool TrySetParent(AutomationPeer? newParent) => true;
    public void Invoke() => Dispatcher.UIThread.Post(() => owner.Open(item));
}

/// <summary>The sidebar glyph: three members joined by lines (the Mac uses the SF Symbol point.3.connected.trianglepath.dotted).</summary>
public static class GraphIcon
{
    public static Control Draw(double size, IBrush stroke) => new GraphGlyph(size, stroke);
    private sealed class GraphGlyph : Control
    {
        private readonly IBrush stroke;
        public GraphGlyph(double size, IBrush stroke) { this.stroke = stroke; Width = Height = size; IsHitTestVisible = false; VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center; }
        public override void Render(DrawingContext context)
        {
            var size = Math.Min(Bounds.Width, Bounds.Height); var thickness = size / 12;
            Point top = new(size * .5, size * .17), left = new(size * .15, size * .8), right = new(size * .85, size * .8);
            var pen = new Pen(stroke, thickness, new DashStyle([2, 2], 0));
            context.DrawLine(pen, top, left); context.DrawLine(pen, top, right); context.DrawLine(pen, left, right);
            foreach (var node in new[] { top, left, right }) context.DrawEllipse(stroke, null, node, size * .12, size * .12);
        }
    }
}
