using Avalonia;
using Avalonia.Animation;
using Avalonia.Animation.Easings;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Shapes;
using Path = Avalonia.Controls.Shapes.Path;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Styling;
using Avalonia.Threading;
using BellTeam.Core;
using static BellTeam.Linux.LatticeLook;

namespace BellTeam.Linux;

/// <summary>
/// The swimlanes: one lane per owner (producer, else the authored lane text, else 担当なし), cards in columns by depth, edges as smooth curves under them. Waiting edges carry an accent gradient and particles flowing to the
/// waiter (one per 600 ms, 1.4 s travel) and a 「◯◯が待っています」 chip. The lane names stay at the left edge while the board scrolls sideways (cards pass under them).
/// Holds no state of its own beyond the drawing: the window gives it each snapshot.
/// </summary>
internal sealed class LatticeBoard : Canvas
{
    public event Action<string>? CardOpened;
    public LatticeLayout Layout { get; private set; } = new([], new Dictionary<string, LatticePlaced>(), [], 0, 0);
    public bool Flowing { get; set; } = true;
    internal Func<double> Clock { get; set; } = () => Environment.TickCount64;
    private LatticeSnapshot? snapshot;
    private (HashSet<string> Cards, HashSet<string> Waits)? highlight;
    private readonly EdgeLayer edges;
    private readonly Canvas labels = new();
    private readonly TranslateTransform labelShift = new();
    private readonly Dictionary<string, Control> cards = [];
    private readonly Func<string, string, Task<Bitmap>>? avatar;
    private readonly DispatcherTimer ticker = new() { Interval = TimeSpan.FromMilliseconds(33) };

    public LatticeBoard(Func<string, string, Task<Bitmap>>? avatar)
    {
        this.avatar = avatar; edges = new EdgeLayer(this) { IsHitTestVisible = false }; labels.RenderTransform = labelShift; ClipToBounds = false;
        ticker.Tick += (_, _) => { if (Flowing && snapshot?.Edges.Any(edge => edge.Waiting) == true) edges.InvalidateVisual(); };
        AttachedToVisualTree += (_, _) => { if (Motion) ticker.Start(); };
        DetachedFromVisualTree += (_, _) => ticker.Stop();
    }
    /// <summary>Keeps the lane names at the visible left edge.</summary>
    public void ScrolledTo(double horizontal) => labelShift.X = horizontal;
    public Rect? CardRect(string id) => Layout.Cards.TryGetValue(id, out var at) ? new Rect(at.X, at.Y, at.Width, at.Height) : null;
    public Control? CardElement(string id) => cards.GetValueOrDefault(id);

    public void Show(LatticeSnapshot next, LatticeDiff? diff, DateTimeOffset now)
    {
        snapshot = next; Layout = LatticeChart.Layout(next);
        Children.Clear(); cards.Clear(); labels.Children.Clear();
        // Trailing room so the last column ends clear of the right fade (the Mac board does the same).
        Width = Math.Max(Layout.Width + 40, 400); Height = Layout.Height;
        foreach (var (lane, index) in Layout.Lanes.Select((lane, index) => (lane, index)))
        {
            var band = new Border { Width = Width - 8, Height = lane.Height, CornerRadius = new CornerRadius(16), Background = Brush(Colors.White, index % 2 == 0 ? (byte)0x8C : (byte)0x55), BorderBrush = Brush(Colors.White, 0xB0), BorderThickness = new Thickness(1), IsHitTestVisible = false };
            SetLeft(band, 4); SetTop(band, lane.Y); Children.Add(band);
            var tag = new StackPanel { Width = LatticeChart.LabelWidth - 8, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            tag.Children.Add(new LatticeAvatar(lane.Member, 40, avatar) { HorizontalAlignment = HorizontalAlignment.Center });
            tag.Children.Add(new TextBlock { Text = LatticeChart.NameOf(lane.Member), FontSize = 13, FontWeight = FontWeight.SemiBold, Foreground = Brush(lane.Member is { Known: true } ? Ink : Muted), TextAlignment = TextAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis, Margin = new Thickness(0, 6, 0, 0) });
            var cell = new Border { Width = LatticeChart.LabelWidth, Height = lane.Height, CornerRadius = new CornerRadius(16, 0, 0, 16), Background = Brush(Color.FromRgb(0xF7, 0xF5, 0xFE), 0xF2), Child = tag, Padding = new Thickness(4, 0, 4, 0) };
            SetLeft(cell, 4); SetTop(cell, lane.Y); labels.Children.Add(cell);
        }
        edges.Width = Width; edges.Height = Height; Children.Add(edges);
        // Chips sit on their curve where they cover no card and no other chip (the middle first, then further along either way).
        var taken = Layout.Cards.Values.Select(at => new Rect(at.X - 4, at.Y - 4, at.Width + 8, at.Height + 8)).ToList();
        foreach (var edge in next.Edges.Where(edge => edge.Waiting && Layout.Cards.ContainsKey(edge.From) && Layout.Cards.ContainsKey(edge.To)))
        {
            var curve = LatticeChart.EdgeCurve(Layout.Cards[edge.From], Layout.Cards[edge.To]);
            var chip = Pill(Text(LatticeChart.EdgeChip(next, edge), 11, Violet, FontWeight.SemiBold), Violet, 0x1A, new Thickness(8, 2, 8, 3));
            chip.Background = Brush(Color.FromRgb(0xF2, 0xEE, 0xFF), 0xF2); chip.BorderBrush = Brush(Violet, 0x40); chip.BorderThickness = new Thickness(1); chip.IsHitTestVisible = false;
            chip.Measure(Size.Infinity);
            var size = chip.DesiredSize; Rect? spot = null;
            foreach (var t in new[] { .5, .4, .6, .3, .7, .2, .8 })
            {
                var (x, y) = LatticeChart.PointOnCurve(curve, t); var rect = new Rect(x - size.Width / 2, y - size.Height / 2, size.Width, size.Height);
                if (!taken.Any(other => other.Intersects(rect))) { spot = rect; break; }
            }
            if (spot is not { } place) continue;   // no free place: the curve and its particles still show the wait, and 待ちの流れ names it
            taken.Add(place); SetLeft(chip, place.X); SetTop(chip, place.Y); chip.Tag = edge; Children.Add(chip);
        }
        var ownerOf = LatticeChart.Owner(next);
        foreach (var card in next.Cards.Where(card => Layout.Cards.ContainsKey(card.Id)))
        {
            var at = Layout.Cards[card.Id]; var owner = ownerOf(card); var view = CardView(card, owner, now);
            var button = Plain(view, LatticeChart.CardLabel(card, owner)); button.Width = at.Width; button.Height = at.Height; button.Tag = card.Id;
            button.Click += (_, _) => CardOpened?.Invoke(card.Id);
            AutomationProperties.SetAutomationId(button, "lattice-card");
            SetLeft(button, at.X); SetTop(button, at.Y); Children.Add(button); cards[card.Id] = button;
            if (diff is { First: false } && Motion) Animate(button, card.Id, diff);
        }
        Children.Add(labels);
        ApplyHighlight();
    }

    private static Animation Settle(double from, int milliseconds, Easing ease, bool fadeIn) => new()
    {
        Duration = TimeSpan.FromMilliseconds(milliseconds), Easing = ease,
        Children =
        {
            new KeyFrame { Cue = new Cue(0), Setters = { new Setter(ScaleTransform.ScaleXProperty, from), new Setter(ScaleTransform.ScaleYProperty, from), new Setter(Visual.OpacityProperty, fadeIn ? 0d : 1d) } },
            new KeyFrame { Cue = new Cue(1), Setters = { new Setter(ScaleTransform.ScaleXProperty, 1d), new Setter(ScaleTransform.ScaleYProperty, 1d), new Setter(Visual.OpacityProperty, 1d) } }
        }
    };

    private static void Animate(Control card, string id, LatticeDiff diff)
    {
        card.RenderTransformOrigin = RelativePoint.Center;
        if (diff.AddedCards.Contains(id)) _ = Settle(.92, 300, Spring, fadeIn: true).RunAsync(card);
        else if (diff.ChangedCards.Contains(id)) _ = Settle(1.06, 450, new BackEaseOut(), fadeIn: false).RunAsync(card);
        if (diff.CompletedCards.Contains(id) && card is Button { Content: Grid grid }) grid.Children.Add(new LatticeBloom());
    }

    private readonly Rectangle selection = new() { RadiusX = 17, RadiusY = 17, Stroke = Brush(Violet), StrokeThickness = 2.4, IsHitTestVisible = false };
    /// <summary>Rings the card whose detail is open.</summary>
    public void Select(string? id)
    {
        Children.Remove(selection);
        if (id is null || !Layout.Cards.TryGetValue(id, out var at)) return;
        selection.Width = at.Width + 8; selection.Height = at.Height + 8; SetLeft(selection, at.X - 4); SetTop(selection, at.Y - 4); Children.Insert(Children.IndexOf(labels), selection);
    }

    public void Highlight(string? botId)
    {
        highlight = botId is null || snapshot is null ? null : LatticeChart.Highlight(snapshot, botId);
        ApplyHighlight();
    }
    private void ApplyHighlight()
    {
        foreach (var (id, card) in cards) card.Opacity = highlight is { } on && !on.Cards.Contains(id) ? .28 : 1;
        foreach (var chip in Children.OfType<Border>().Where(chip => chip.Tag is LatticeEdge))
            chip.Opacity = highlight is { } on && !on.Waits.Contains($"{((LatticeEdge)chip.Tag!).To}>{((LatticeEdge)chip.Tag!).From}") ? .25 : 1;
        edges.InvalidateVisual();
    }

    private Control CardView(LatticeCard card, LatticePerson? producer, DateTimeOffset now)
    {
        var accent = producer is { Known: true } ? Accent(producer.Color) : Violet; var info = LatticeChart.StateInfo(card.State);
        var shell = new Border { CornerRadius = new CornerRadius(14), BorderThickness = new Thickness(1.2), Padding = new Thickness(11, 9, 11, 9) };
        var finished = LatticeChart.Finished(card.State);
        switch (card.State)
        {
            case "ready":
                shell.Background = Brush(Colors.White, 0xF7); shell.BorderBrush = Brush(accent); shell.BorderThickness = new Thickness(1.6);
                shell.BoxShadow = new BoxShadows(new BoxShadow { Blur = 18, Color = Color.FromArgb(0x59, accent.R, accent.G, accent.B) }); break;
            case "in-progress":
                shell.Background = new LinearGradientBrush { StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative), EndPoint = new RelativePoint(0, 1, RelativeUnit.Relative), GradientStops = [new GradientStop(Color.FromArgb(0x2E, accent.R, accent.G, accent.B), 0), new GradientStop(Color.FromArgb(0x12, accent.R, accent.G, accent.B), 1)] };
                shell.BorderBrush = Brush(accent, 0x8C);
                shell.BoxShadow = new BoxShadows(new BoxShadow { OffsetY = 4, Blur = 14, Color = Color.FromArgb(20, Ink.R, Ink.G, Ink.B) }); break;
            case "blocked":
                shell.Background = Brush(Red, 0x1C); shell.BorderBrush = Brush(Red, 0xB3); shell.BorderThickness = new Thickness(1.4); break;
            case "done": shell.Background = Brush(Color.FromRgb(0xEE, 0xF1, 0xF0), 0xE6); shell.BorderBrush = Brush(Done, 0x40); shell.CornerRadius = new CornerRadius(25); shell.Padding = new Thickness(12, 6, 14, 6); break;
            case "retired": shell.Background = Brush(Color.FromRgb(0xF0, 0xF0, 0xF3), 0xCC); shell.BorderBrush = Brush(Muted, 0x30); shell.CornerRadius = new CornerRadius(25); shell.Padding = new Thickness(12, 6, 14, 6); break;
            default: shell.Background = Brush(Colors.White, 0xB8); shell.BorderBrush = Brush(Muted, 0x80); shell.BorderThickness = default; break;
        }
        var grid = new Grid();
        if (card.State == "pending")
            grid.Children.Add(new Rectangle { RadiusX = 14, RadiusY = 14, Stroke = Brush(Muted, 0x99), StrokeThickness = 1.3, StrokeDashArray = [4, 3], IsHitTestVisible = false });
        grid.Children.Add(shell);
        if (finished)
        {
            var title = Text(LatticeChart.Title(card), 12.5, card.State == "done" ? Color.FromRgb(0x4F, 0x5E, 0x59) : Muted);
            if (card.State == "retired") title.TextDecorations = TextDecorations.Strikethrough;
            shell.Child = Row(StateGlyph(card.State, 18, accent), Spaced(new StackPanel { Children = { title, Text(info.Badge, 10.5, Muted) } }, 8));
            return grid;
        }
        // Card body (screen-spec): badge row, title up to 2 lines, note line, stacked so the note never overlaps the title.
        var stack = new StackPanel();
        var top = new DockPanel { Margin = new Thickness(0, 0, 0, 5) };
        var badgeColor = card.State switch { "blocked" => Red, "in-progress" or "ready" => accent, _ => Muted };
        top.Children.Add(Row(StateGlyph(card.State, 14, accent), Spaced(Text(info.Badge, 11, badgeColor, FontWeight.SemiBold), 5)));
        if (card.State == "in-progress")
        {
            var face = new Grid { Width = 26, Height = 26, HorizontalAlignment = HorizontalAlignment.Right };
            face.Children.Add(new LatticeAvatar(producer, 20, avatar) { HorizontalAlignment = HorizontalAlignment.Center });
            face.Children.Add(Arc(26, accent, 1.8));
            var minutes = Text(LatticeChart.SinceText(card.StartedAt, now), 11, Muted); minutes.Margin = new Thickness(0, 0, 6, 0);
            var right = Row(minutes, face); right.HorizontalAlignment = HorizontalAlignment.Right; DockPanel.SetDock(right, Dock.Right); top.Children.Insert(0, right);
        }
        stack.Children.Add(top);
        stack.Children.Add(new TextBlock { Text = LatticeChart.Title(card), FontSize = 13.5, FontWeight = FontWeight.SemiBold, Foreground = Brush(Ink), TextWrapping = TextWrapping.Wrap, TextTrimming = TextTrimming.CharacterEllipsis, LineHeight = 18, MaxLines = 2, MaxHeight = 36 });
        var note = LatticeChart.CardNote(card, producer);
        if (note.Length > 0) { var line = Text(note, 11, card.State == "blocked" ? Red : Muted); line.Margin = new Thickness(0, 3, 0, 0); stack.Children.Add(line); }
        shell.Child = stack;
        return grid;
    }

    /// <summary>Edges under the cards: satisfied ones thin and faint, waiting ones a thicker accent gradient with particles flowing toward the waiter.</summary>
    private sealed class EdgeLayer(LatticeBoard board) : Control
    {
        public override void Render(DrawingContext context)
        {
            if (board.snapshot is not { } snapshot) return;
            var layout = board.Layout; var now = board.Clock();
            var producers = snapshot.Cards.GroupBy(card => card.Id).ToDictionary(group => group.Key, group => group.First()); var ownerOf = LatticeChart.Owner(snapshot);
            foreach (var edge in snapshot.Edges)
            {
                if (!layout.Cards.TryGetValue(edge.From, out var from) || !layout.Cards.TryGetValue(edge.To, out var to)) continue;
                var curve = LatticeChart.EdgeCurve(from, to);
                var geometry = new StreamGeometry();
                using (var open = geometry.Open())
                {
                    open.BeginFigure(new Point(curve.X0, curve.Y0), false);
                    open.CubicBezierTo(new Point(curve.X1, curve.Y1), new Point(curve.X2, curve.Y2), new Point(curve.X3, curve.Y3));
                    open.EndFigure(false);
                }
                var dim = board.highlight is { } on && !on.Waits.Contains($"{edge.To}>{edge.From}") && !(on.Cards.Contains(edge.From) && on.Cards.Contains(edge.To));
                if (!edge.Waiting) { context.DrawGeometry(null, new Pen(Brush(Muted, dim ? (byte)0x1A : (byte)0x40), 1.2), geometry); continue; }
                var color = ownerOf(producers.GetValueOrDefault(edge.From)) is { Known: true } person ? Accent(person.Color) : Violet;
                var opacity = dim ? .22 : 1;
                var gradient = new LinearGradientBrush
                {
                    StartPoint = new RelativePoint(curve.X0, 0, RelativeUnit.Absolute), EndPoint = new RelativePoint(curve.X3, 0, RelativeUnit.Absolute),
                    GradientStops = [new GradientStop(Color.FromArgb((byte)(0x66 * opacity), color.R, color.G, color.B), 0), new GradientStop(Color.FromArgb((byte)(0xF0 * opacity), Violet.R, Violet.G, Violet.B), 1)]
                };
                context.DrawGeometry(null, new Pen(gradient, 2.6, null, PenLineCap.Round), geometry);
                context.DrawEllipse(Brush(Violet, (byte)(0xFF * opacity)), null, new Point(curve.X3 - 1, curve.Y3), 3.2, 3.2);
                if (!Motion || dim) continue;
                var blocked = producers.GetValueOrDefault(edge.From)?.State == "blocked";
                foreach (var t in LatticeChart.FlowPositions(blocked ? now / 2 : now))
                {
                    var (x, y) = LatticeChart.PointOnCurve(curve, t); var alpha = LatticeChart.ParticleOpacity(t);
                    var spark = new RadialGradientBrush { GradientStops = [new GradientStop(Color.FromArgb((byte)(0xFF * alpha), 0xFF, 0xFF, 0xFF), 0), new GradientStop(Color.FromArgb((byte)(0xC0 * alpha), Violet.R, Violet.G, Violet.B), 1)] };
                    context.DrawEllipse(spark, null, new Point(x, y), 3.4, 3.4);
                }
            }
        }
    }

    // The spec's spring(response 0.45, damping 0.82) as a cubic ease.
    private static Easing Spring => new CubicEaseOut();
}

/// <summary>Completion: five petals that open around the card and fade in 700 ms.</summary>
internal sealed class LatticeBloom : Canvas
{
    public LatticeBloom()
    {
        IsHitTestVisible = false; HorizontalAlignment = HorizontalAlignment.Left; VerticalAlignment = VerticalAlignment.Center; Margin = new Thickness(21, 0, 0, 0);
        for (var index = 0; index < 5; index++)
        {
            // The petal grows from its foot; its own turn is on a wrapper at the bloom's centre so the animation owns only the scale.
            var petal = new Ellipse { Width = 9, Height = 16, Fill = Brush(Color.FromRgb(0xF5, 0xA6, 0xC3), 0xD0), RenderTransformOrigin = new RelativePoint(.5, 1, RelativeUnit.Relative), RenderTransform = new ScaleTransform(.2, .2) };
            SetLeft(petal, -4.5); SetTop(petal, -16);
            Children.Add(new Canvas { Width = 0, Height = 0, RenderTransform = new RotateTransform(index * 72), Children = { petal } });
            var grow = new Animation
            {
                Duration = TimeSpan.FromMilliseconds(700), Easing = new CubicEaseOut(), FillMode = FillMode.Forward,
                Children = { new KeyFrame { Cue = new Cue(0), Setters = { new Setter(ScaleTransform.ScaleXProperty, .2), new Setter(ScaleTransform.ScaleYProperty, .2) } }, new KeyFrame { Cue = new Cue(1), Setters = { new Setter(ScaleTransform.ScaleXProperty, 1.3), new Setter(ScaleTransform.ScaleYProperty, 1.3) } } }
            };
            _ = grow.RunAsync(petal);
        }
        _ = FadeAsync();
    }
    private async Task FadeAsync()
    {
        var fade = new Animation
        {
            Duration = TimeSpan.FromMilliseconds(700), Delay = TimeSpan.FromMilliseconds(150), FillMode = FillMode.Both,
            Children = { new KeyFrame { Cue = new Cue(0), Setters = { new Setter(OpacityProperty, 1d) } }, new KeyFrame { Cue = new Cue(1), Setters = { new Setter(OpacityProperty, 0d) } } }
        };
        await fade.RunAsync(this);
        (Parent as Panel)?.Children.Remove(this);
    }
}
