using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using BellTeam.Core;
using static BellTeam.App.LatticeLook;

namespace BellTeam.App;

/// <summary>
/// The swimlanes: one lane per producer, cards in columns by depth, edges as smooth curves under them. Waiting edges carry an accent gradient and particles flowing to the
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
    private readonly Dictionary<string, FrameworkElement> cards = [];
    private readonly Func<string, string, Task<System.Windows.Media.Imaging.BitmapSource>>? avatar;

    public LatticeBoard(Func<string, string, Task<System.Windows.Media.Imaging.BitmapSource>>? avatar)
    {
        this.avatar = avatar; edges = new EdgeLayer(this); labels.RenderTransform = labelShift; ClipToBounds = false;
        Loaded += (_, _) => { if (Motion) CompositionTarget.Rendering += Tick; };
        Unloaded += (_, _) => CompositionTarget.Rendering -= Tick;
    }
    private void Tick(object? sender, EventArgs e) { if (Flowing && snapshot?.Edges.Any(edge => edge.Waiting) == true) edges.InvalidateVisual(); }
    /// <summary>Keeps the lane names at the visible left edge.</summary>
    public void ScrolledTo(double horizontal) => labelShift.X = horizontal;
    public Rect CardRect(string id) => Layout.Cards.TryGetValue(id, out var at) ? new Rect(at.X, at.Y, at.Width, at.Height) : Rect.Empty;
    public FrameworkElement? CardElement(string id) => cards.GetValueOrDefault(id);

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
            var tag = new StackPanel { Width = LatticeChart.LabelWidth - 8, HorizontalAlignment = HorizontalAlignment.Center };
            tag.Children.Add(new LatticeAvatar(lane.Member, 40, avatar) { HorizontalAlignment = HorizontalAlignment.Center });
            tag.Children.Add(new TextBlock { Text = LatticeChart.NameOf(lane.Member), FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = Brush(lane.Member is { Known: true } ? Ink : Muted), TextAlignment = TextAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis, Margin = new Thickness(0, 6, 0, 0) });
            var cell = new Border { Width = LatticeChart.LabelWidth, Height = lane.Height, CornerRadius = new CornerRadius(16, 0, 0, 16), Background = Brush(Color.FromRgb(0xF7, 0xF5, 0xFE), 0xF2), Child = tag, Padding = new Thickness(4, 0, 4, 0) };
            tag.VerticalAlignment = VerticalAlignment.Center;
            SetLeft(cell, 4); SetTop(cell, lane.Y); labels.Children.Add(cell);
        }
        edges.Width = Width; edges.Height = Height; Children.Add(edges);
        // Chips sit on their curve where they cover no card and no other chip (the middle first, then further along either way).
        var taken = Layout.Cards.Values.Select(at => new Rect(at.X - 4, at.Y - 4, at.Width + 8, at.Height + 8)).ToList();
        foreach (var edge in next.Edges.Where(edge => edge.Waiting && Layout.Cards.ContainsKey(edge.From) && Layout.Cards.ContainsKey(edge.To)))
        {
            var curve = LatticeChart.EdgeCurve(Layout.Cards[edge.From], Layout.Cards[edge.To]);
            var chip = Pill(Text(LatticeChart.EdgeChip(next, edge), 11, Violet, FontWeights.SemiBold), Violet, 0x1A, new Thickness(8, 2, 8, 3));
            chip.Background = Brush(Color.FromRgb(0xF2, 0xEE, 0xFF), 0xF2); chip.BorderBrush = Brush(Violet, 0x40); chip.BorderThickness = new Thickness(1); chip.IsHitTestVisible = false;
            chip.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            var size = chip.DesiredSize; Rect? spot = null;
            foreach (var t in new[] { .5, .4, .6, .3, .7, .2, .8 })
            {
                var (x, y) = LatticeChart.PointOnCurve(curve, t); var rect = new Rect(x - size.Width / 2, y - size.Height / 2, size.Width, size.Height);
                if (!taken.Any(other => other.IntersectsWith(rect))) { spot = rect; break; }
            }
            if (spot is not { } place) continue;   // no free place: the curve and its particles still show the wait, and 待ちの流れ names it
            taken.Add(place); SetLeft(chip, place.X); SetTop(chip, place.Y); chip.Tag = edge; Children.Add(chip);
        }
        var lookup = LatticeChart.Lookup(next);
        foreach (var card in next.Cards.Where(card => Layout.Cards.ContainsKey(card.Id)))
        {
            var at = Layout.Cards[card.Id]; var view = CardView(card, lookup(card.Producer), now);
            var button = Plain(view, LatticeChart.CardLabel(card, lookup(card.Producer))); button.Width = at.Width; button.Height = at.Height; button.Tag = card.Id;
            button.Click += (_, _) => CardOpened?.Invoke(card.Id);
            System.Windows.Automation.AutomationProperties.SetAutomationId(button, "lattice-card");
            SetLeft(button, at.X); SetTop(button, at.Y); Children.Add(button); cards[card.Id] = button;
            if (diff is { First: false } && Motion) Animate(button, card.Id, diff);
        }
        Children.Add(labels);
        ApplyHighlight();
    }

    private static void Animate(FrameworkElement card, string id, LatticeDiff diff)
    {
        var scale = new ScaleTransform(1, 1); card.RenderTransform = scale; card.RenderTransformOrigin = new Point(.5, .5);
        if (diff.AddedCards.Contains(id))
        {
            var grow = new DoubleAnimation(.92, 1, TimeSpan.FromMilliseconds(300)) { EasingFunction = Spring };
            scale.BeginAnimation(ScaleTransform.ScaleXProperty, grow); scale.BeginAnimation(ScaleTransform.ScaleYProperty, grow);
            card.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(300)));
        }
        else if (diff.ChangedCards.Contains(id))
        {
            var settle = new DoubleAnimation(1.06, 1, TimeSpan.FromMilliseconds(450)) { EasingFunction = new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = .35 } };
            scale.BeginAnimation(ScaleTransform.ScaleXProperty, settle); scale.BeginAnimation(ScaleTransform.ScaleYProperty, settle);
        }
        if (diff.CompletedCards.Contains(id) && card is ContentControl { Content: Grid grid }) grid.Children.Add(new LatticeBloom());
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
            chip.Opacity = highlight is { } on && !on.Waits.Contains($"{((LatticeEdge)chip.Tag).To}>{((LatticeEdge)chip.Tag).From}") ? .25 : 1;
        edges.InvalidateVisual();
    }

    private FrameworkElement CardView(LatticeCard card, LatticePerson? producer, DateTimeOffset now)
    {
        var accent = producer is { Known: true } ? Accent(producer.Color) : Violet; var info = LatticeChart.StateInfo(card.State);
        var shell = new Border { CornerRadius = new CornerRadius(14), BorderThickness = new Thickness(1.2), Padding = new Thickness(11, 9, 11, 9) };
        var finished = LatticeChart.Finished(card.State);
        switch (card.State)
        {
            case "ready":
                shell.Background = Brush(Colors.White, 0xF7); shell.BorderBrush = Brush(accent); shell.BorderThickness = new Thickness(1.6);
                shell.Effect = new System.Windows.Media.Effects.DropShadowEffect { Color = accent, Opacity = .35, BlurRadius = 18, ShadowDepth = 0 }; break;
            case "in-progress":
                shell.Background = new LinearGradientBrush(Color.FromArgb(0x2E, accent.R, accent.G, accent.B), Color.FromArgb(0x12, accent.R, accent.G, accent.B), 90); shell.BorderBrush = Brush(accent, 0x8C);
                shell.Effect = new System.Windows.Media.Effects.DropShadowEffect { Color = Ink, Opacity = .08, BlurRadius = 14, ShadowDepth = 4, Direction = 270 }; break;
            case "blocked":
                shell.Background = Brush(Red, 0x1C); shell.BorderBrush = Brush(Red, 0xB3); shell.BorderThickness = new Thickness(1.4); break;
            case "done": shell.Background = Brush(Color.FromRgb(0xEE, 0xF1, 0xF0), 0xE6); shell.BorderBrush = Brush(Done, 0x40); shell.CornerRadius = new CornerRadius(25); shell.Padding = new Thickness(12, 6, 14, 6); break;
            case "retired": shell.Background = Brush(Color.FromRgb(0xF0, 0xF0, 0xF3), 0xCC); shell.BorderBrush = Brush(Muted, 0x30); shell.CornerRadius = new CornerRadius(25); shell.Padding = new Thickness(12, 6, 14, 6); break;
            default: shell.Background = Brush(Colors.White, 0xB8); shell.BorderBrush = Brush(Muted, 0x80); shell.BorderThickness = new Thickness(0); break;
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
        var stack = new DockPanel { LastChildFill = true };
        var top = new DockPanel { Margin = new Thickness(0, 0, 0, 5) }; DockPanel.SetDock(top, Dock.Top);
        var badgeColor = card.State switch { "blocked" => Red, "in-progress" or "ready" => accent, _ => Muted };
        var badge = Row(StateGlyph(card.State, 14, accent), Spaced(Text(info.Badge, 11, badgeColor, FontWeights.SemiBold), 5));
        top.Children.Add(badge);
        if (card.State == "in-progress")
        {
            var face = new Grid { Width = 26, Height = 26, HorizontalAlignment = HorizontalAlignment.Right };
            face.Children.Add(new LatticeAvatar(producer, 20, avatar) { HorizontalAlignment = HorizontalAlignment.Center });
            face.Children.Add(Arc(26, accent, 1.8));
            var minutes = Text(LatticeChart.SinceText(card.StartedAt, now), 11, Muted); minutes.Margin = new Thickness(0, 0, 6, 0);
            var right = Row(minutes, face); right.HorizontalAlignment = HorizontalAlignment.Right; top.Children.Add(right);
        }
        stack.Children.Add(top);
        var note = LatticeChart.CardNote(card, producer);
        if (note.Length > 0) { var line = Text(note, 11, card.State == "blocked" ? Red : Muted); DockPanel.SetDock(line, Dock.Bottom); line.Margin = new Thickness(0, 3, 0, 0); stack.Children.Add(line); }
        stack.Children.Add(new TextBlock { Text = LatticeChart.Title(card), FontSize = 13.5, FontWeight = FontWeights.SemiBold, Foreground = Brush(Ink), TextWrapping = TextWrapping.Wrap, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Top, LineHeight = 18, LineStackingStrategy = LineStackingStrategy.BlockLineHeight });
        shell.Child = stack;
        return grid;
    }

    /// <summary>Edges under the cards: satisfied ones thin and faint, waiting ones a thicker accent gradient with particles flowing toward the waiter.</summary>
    private sealed class EdgeLayer(LatticeBoard board) : FrameworkElement
    {
        protected override void OnRender(DrawingContext context)
        {
            if (board.snapshot is not { } snapshot) return;
            var layout = board.Layout; var lookup = LatticeChart.Lookup(snapshot); var now = board.Clock();
            var producers = snapshot.Cards.GroupBy(card => card.Id).ToDictionary(group => group.Key, group => group.First());
            foreach (var edge in snapshot.Edges)
            {
                if (!layout.Cards.TryGetValue(edge.From, out var from) || !layout.Cards.TryGetValue(edge.To, out var to)) continue;
                var curve = LatticeChart.EdgeCurve(from, to);
                var figure = new PathFigure { StartPoint = new Point(curve.X0, curve.Y0) }; figure.Segments.Add(new BezierSegment(new Point(curve.X1, curve.Y1), new Point(curve.X2, curve.Y2), new Point(curve.X3, curve.Y3), true));
                var geometry = new PathGeometry([figure]);
                var dim = board.highlight is { } on && !on.Waits.Contains($"{edge.To}>{edge.From}") && !(on.Cards.Contains(edge.From) && on.Cards.Contains(edge.To));
                if (!edge.Waiting) { context.DrawGeometry(null, new Pen(Brush(Muted, dim ? (byte)0x1A : (byte)0x40), 1.2), geometry); continue; }
                var producer = producers.GetValueOrDefault(edge.From)?.Producer; var color = lookup(producer) is { Known: true } person ? Accent(person.Color) : Violet;
                var opacity = dim ? .22 : 1;
                var gradient = new LinearGradientBrush(Color.FromArgb((byte)(0x66 * opacity), color.R, color.G, color.B), Color.FromArgb((byte)(0xF0 * opacity), Violet.R, Violet.G, Violet.B), new Point(curve.X0, 0), new Point(curve.X3, 0)) { MappingMode = BrushMappingMode.Absolute };
                context.DrawGeometry(null, new Pen(gradient, 2.6) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round }, geometry);
                context.DrawEllipse(Brush(Violet, (byte)(0xFF * opacity)), null, new Point(curve.X3 - 1, curve.Y3), 3.2, 3.2);
                if (!Motion || dim) continue;
                var blocked = producers.GetValueOrDefault(edge.From)?.State == "blocked";
                foreach (var t in LatticeChart.FlowPositions(blocked ? now / 2 : now))
                {
                    var (x, y) = LatticeChart.PointOnCurve(curve, t); var alpha = LatticeChart.ParticleOpacity(t);
                    context.DrawEllipse(new RadialGradientBrush(Color.FromArgb((byte)(0xFF * alpha), 0xFF, 0xFF, 0xFF), Color.FromArgb((byte)(0xC0 * alpha), Violet.R, Violet.G, Violet.B)), null, new Point(x, y), 3.4, 3.4);
                }
            }
        }
    }
}

/// <summary>Completion: five petals that open around the card and fade in 700 ms.</summary>
internal sealed class LatticeBloom : Canvas
{
    public LatticeBloom()
    {
        IsHitTestVisible = false; HorizontalAlignment = HorizontalAlignment.Left; VerticalAlignment = VerticalAlignment.Center; Margin = new Thickness(21, 0, 0, 0);
        for (var index = 0; index < 5; index++)
        {
            var petal = new Ellipse { Width = 9, Height = 16, Fill = Brush(Color.FromRgb(0xF5, 0xA6, 0xC3), 0xD0), RenderTransformOrigin = new Point(.5, 1) };
            SetLeft(petal, -4.5); SetTop(petal, -16);
            var group = new TransformGroup(); var scale = new ScaleTransform(.2, .2); group.Children.Add(scale); group.Children.Add(new RotateTransform(index * 72)); petal.RenderTransform = group;
            var grow = new DoubleAnimation(.2, 1.3, TimeSpan.FromMilliseconds(700)) { EasingFunction = Spring };
            scale.BeginAnimation(ScaleTransform.ScaleXProperty, grow); scale.BeginAnimation(ScaleTransform.ScaleYProperty, grow);
            Children.Add(petal);
        }
        var fade = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(700)) { BeginTime = TimeSpan.FromMilliseconds(150) };
        fade.Completed += (_, _) => (Parent as Panel)?.Children.Remove(this);
        BeginAnimation(OpacityProperty, fade);
    }
}
