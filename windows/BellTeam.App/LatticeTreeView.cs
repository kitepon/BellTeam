using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using BellTeam.Core;
using static BellTeam.App.LatticeLook;

namespace BellTeam.App;

/// <summary>
/// ツリー (screen-spec "ツリー"): the chart -> its phases -> cards nested by parent, left to right. Each card is a compact box (state glyph, one-line title, owner face)
/// that opens 詳細; tree links are soft elbows; dependencies are arcs on the right of the boxes (waiting = accent with an arrow toward the waiter, satisfied = faint).
/// Highlight dims boxes and arcs like the lane view. Holds no state of its own beyond the drawing.
/// </summary>
internal sealed class LatticeTreeView : Canvas
{
    public event Action<string>? CardOpened;
    public LatticeTreeLayout Layout { get; private set; } = new([], [], [], new Dictionary<string, LatticeTreeNode>(), 0, 0);
    private readonly Dictionary<string, FrameworkElement> cards = [];
    private readonly List<(LatticeTreeArc Arc, Path Path, Path? Head)> arcs = [];
    private readonly Func<string, string, Task<System.Windows.Media.Imaging.BitmapSource>>? avatar;
    private LatticeSnapshot? snapshot;
    private readonly Rectangle selection = new() { RadiusX = 12, RadiusY = 12, Stroke = Brush(Violet), StrokeThickness = 2.4, IsHitTestVisible = false };

    public LatticeTreeView(Func<string, string, Task<System.Windows.Media.Imaging.BitmapSource>>? avatar) => this.avatar = avatar;
    public Rect CardRect(string id) => Layout.Cards.TryGetValue(id, out var at) ? new Rect(at.X, at.Y, at.Width, at.Height) : Rect.Empty;
    public FrameworkElement? CardElement(string id) => cards.GetValueOrDefault(id);

    public void Show(LatticeSnapshot next, string name)
    {
        snapshot = next; Layout = LatticeChart.Tree(next, name);
        Children.Clear(); cards.Clear(); arcs.Clear();
        Width = Math.Max(Layout.Width, 400); Height = Layout.Height;
        var link = Brush(Muted, 0x55);
        foreach (var item in Layout.Links)
        {
            var bend = (item.X1 - item.X0) / 2; var figure = new PathFigure { StartPoint = new Point(item.X0, item.Y0) };
            figure.Segments.Add(new BezierSegment(new Point(item.X0 + bend, item.Y0), new Point(item.X1 - bend, item.Y1), new Point(item.X1, item.Y1), true));
            Children.Add(new Path { Data = new PathGeometry([figure]), Stroke = link, StrokeThickness = 1.2, IsHitTestVisible = false });
        }
        foreach (var arc in Layout.Arcs)
        {
            var figure = new PathFigure { StartPoint = new Point(arc.X0, arc.Y0) };
            figure.Segments.Add(new BezierSegment(new Point(arc.Bulge, arc.Y0), new Point(arc.Bulge, arc.Y1), new Point(arc.X1, arc.Y1), true));
            var path = new Path { Data = new PathGeometry([figure]), Stroke = Brush(arc.Waiting ? Violet : Muted, arc.Waiting ? (byte)0xE6 : (byte)0x40), StrokeThickness = arc.Waiting ? 2 : 1.2, IsHitTestVisible = false };
            Children.Add(path);
            Path? head = null;
            // The arrow points left, into the waiter's right edge.
            if (arc.Waiting) Children.Add(head = new Path { Data = Geometry.Parse($"M{arc.X1 - 6},{arc.Y1} L{arc.X1 + 4},{arc.Y1 - 5} L{arc.X1 + 4},{arc.Y1 + 5} Z"), Fill = Brush(Violet), IsHitTestVisible = false });
            arcs.Add((arc, path, head));
        }
        var ownerOf = LatticeChart.Owner(next);
        foreach (var node in Layout.Nodes)
        {
            FrameworkElement box = node.Kind switch { "card" => CardBox(node, ownerOf(node.Card)), "phase" => PhaseBox(node), _ => RootBox(node) };
            box.Width = node.Width; box.Height = node.Height; SetLeft(box, node.X); SetTop(box, node.Y); Children.Add(box);
        }
    }

    private static Border RootBox(LatticeTreeNode node)
    {
        var dock = new DockPanel();
        var count = Text($"{node.Done}/{node.Total}", 12, Muted, FontWeights.SemiBold); DockPanel.SetDock(count, Dock.Right); dock.Children.Add(count);
        var title = Text(node.Label, 13.5, Ink, FontWeights.Bold); title.HorizontalAlignment = HorizontalAlignment.Center; dock.Children.Add(title);
        var box = new Border { Child = dock, CornerRadius = new CornerRadius(10), Padding = new Thickness(12, 0, 10, 0), Background = Brush(Violet, 0x1F), BorderBrush = Brush(Violet, 0x26), BorderThickness = new Thickness(1) };
        System.Windows.Automation.AutomationProperties.SetName(box, $"{node.Label}、完了 {node.Done}/{node.Total}");
        return box;
    }
    private static Border PhaseBox(LatticeTreeNode node)
    {
        var dock = new DockPanel();
        var count = Text($"{node.Done}/{node.Total}", 11.5, Muted); DockPanel.SetDock(count, Dock.Right); count.Margin = new Thickness(8, 0, 0, 0); dock.Children.Add(count);
        var glyph = StateGlyph(node.Tone, 13, Violet); glyph.Margin = new Thickness(0, 0, 8, 0); DockPanel.SetDock(glyph, Dock.Left); dock.Children.Add(glyph);
        dock.Children.Add(Text(node.Label, 13, Ink, FontWeights.SemiBold));
        var box = new Border { Child = dock, CornerRadius = new CornerRadius(10), Padding = new Thickness(11, 0, 10, 0), Background = Brush(Colors.White, 0xE6), BorderBrush = Brush(LatticeLook.Line), BorderThickness = new Thickness(1) };
        System.Windows.Automation.AutomationProperties.SetName(box, $"{node.Label}、{LatticeChart.StateInfo(node.Tone).Badge}、完了 {node.Done}/{node.Total}");
        return box;
    }
    private FrameworkElement CardBox(LatticeTreeNode node, LatticePerson? owner)
    {
        var card = node.Card!; var accent = owner is { Known: true } ? Accent(owner.Color) : Violet;
        var dock = new DockPanel();
        var face = new LatticeAvatar(owner, 20, avatar); face.Margin = new Thickness(8, 0, 0, 0); DockPanel.SetDock(face, Dock.Right); dock.Children.Add(face);
        var glyph = StateGlyph(card.State, 13, accent); glyph.Margin = new Thickness(0, 0, 8, 0); DockPanel.SetDock(glyph, Dock.Left); dock.Children.Add(glyph);
        var title = Text(LatticeChart.Title(card), 13, LatticeChart.Finished(card.State) ? Muted : Ink, FontWeights.SemiBold);
        if (card.State == "retired") title.TextDecorations = TextDecorations.Strikethrough;
        dock.Children.Add(title);
        var shell = new Border { Child = dock, CornerRadius = new CornerRadius(10), Padding = new Thickness(10, 0, 6, 0), BorderThickness = new Thickness(1.2) };
        (shell.Background, shell.BorderBrush) = card.State switch
        {
            "ready" => (Brush(Colors.White, 0xF7), Brush(accent)),
            "in-progress" => (Brush(accent, 0x22), Brush(accent, 0x8C)),
            "blocked" => (Brush(Red, 0x1C), Brush(Red, 0xB3)),
            "done" => (Brush(Color.FromRgb(0xEE, 0xF1, 0xF0), 0xE6), Brush(Done, 0x40)),
            "retired" => (Brush(Color.FromRgb(0xF0, 0xF0, 0xF3), 0xCC), Brush(Muted, 0x30)),
            _ => (Brush(Colors.White, 0xB8), Brush(Muted, 0x80))
        };
        var grid = new Grid();
        if (card.State == "pending") { shell.BorderThickness = new Thickness(0); grid.Children.Add(new Rectangle { RadiusX = 10, RadiusY = 10, Stroke = Brush(Muted, 0x99), StrokeThickness = 1.2, StrokeDashArray = [4, 3], IsHitTestVisible = false }); }
        grid.Children.Add(shell);
        var button = Plain(grid, LatticeChart.CardLabel(card, owner)); button.Tag = card.Id; button.ToolTip = LatticeChart.Title(card);
        button.Click += (_, _) => CardOpened?.Invoke(card.Id);
        System.Windows.Automation.AutomationProperties.SetAutomationId(button, "lattice-tree-card");
        cards[card.Id] = button;
        return button;
    }

    /// <summary>Rings the box whose detail is open.</summary>
    public void Select(string? id)
    {
        Children.Remove(selection);
        if (id is null || !Layout.Cards.TryGetValue(id, out var at)) return;
        selection.Width = at.Width + 6; selection.Height = at.Height + 6; SetLeft(selection, at.X - 3); SetTop(selection, at.Y - 3); Children.Add(selection);
    }

    public void Highlight(string? botId)
    {
        var on = botId is null || snapshot is null ? ((HashSet<string> Cards, HashSet<string> Waits)?)null : LatticeChart.Highlight(snapshot, botId);
        foreach (var (id, card) in cards) card.Opacity = on is { } set && !set.Cards.Contains(id) ? .28 : 1;
        foreach (var (arc, path, head) in arcs)
        {
            var dim = on is { } set && !set.Waits.Contains($"{arc.To}>{arc.From}") && !(set.Cards.Contains(arc.From) && set.Cards.Contains(arc.To));
            path.Opacity = dim ? .25 : 1; if (head is not null) head.Opacity = path.Opacity;
        }
    }
}
