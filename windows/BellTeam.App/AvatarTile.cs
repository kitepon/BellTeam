using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace BellTeam.App;

public sealed class AvatarTile : Border
{
    public static readonly DependencyProperty EntryProperty = DependencyProperty.Register(nameof(Entry), typeof(ConversationEntry), typeof(AvatarTile), new PropertyMetadata(null, Changed));
    public static readonly DependencyProperty WorkspaceProperty = DependencyProperty.Register(nameof(Workspace), typeof(Workspace), typeof(AvatarTile), new PropertyMetadata(null, Changed));
    public ConversationEntry? Entry { get => (ConversationEntry?)GetValue(EntryProperty); set => SetValue(EntryProperty, value); }
    public Workspace? Workspace { get => (Workspace?)GetValue(WorkspaceProperty); set => SetValue(WorkspaceProperty, value); }
    public Task LoadTask { get; private set; } = Task.CompletedTask;
    private readonly Image image = new() { Stretch = Stretch.UniformToFill };
    private readonly System.Windows.Shapes.Path roomSymbol = new() { Data = CreateRoomSymbol(), Fill = Brushes.White, Stretch = Stretch.Uniform, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Visibility = Visibility.Collapsed };
    private readonly TextBlock label = new() { FontSize = 20, FontWeight = FontWeights.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    public AvatarTile()
    {
        var grid = new Grid(); grid.Children.Add(label); grid.Children.Add(roomSymbol); grid.Children.Add(image); Child = grid;
        SizeChanged += (_, _) => { CornerRadius = new CornerRadius(ActualWidth * .31); Clip = new RectangleGeometry(new Rect(0, 0, ActualWidth, ActualHeight), ActualWidth * .31, ActualHeight * .31); label.FontSize = ActualWidth * .42; roomSymbol.Width = ActualWidth * .62; roomSymbol.Height = ActualHeight * .62; };
    }
    private static void Changed(DependencyObject target, DependencyPropertyChangedEventArgs args) { var tile = (AvatarTile)target; tile.LoadTask = tile.LoadAsync(); }
    private async Task LoadAsync()
    {
        image.Source = null; ToolTip = null;
        var entry = Entry; var workspace = Workspace;
        System.Windows.Automation.AutomationProperties.SetName(this, (entry?.Name ?? "") + "の写真");
        label.Text = entry?.Target.IsRoom == true ? "" : entry?.Initial ?? ""; roomSymbol.Visibility = entry?.Target.IsRoom == true ? Visibility.Visible : Visibility.Collapsed;
        var accent = BellColors.Accent(entry?.Bot?.Color);
        Background = new LinearGradientBrush(Color.FromArgb(190, accent.R, accent.G, accent.B), accent, 45);
        if (entry?.AvatarUrl is not { } url || workspace is null)
        {
            if (entry?.Bot?.Avatar is { Length: > 0 } inline)
            {
                try { var bitmap = await ImageCodec.DecodeAsync(Convert.FromBase64String(inline[(inline.IndexOf(',') + 1)..])); if (Entry?.Bot?.Avatar == inline) { image.Source = bitmap; label.Text = ""; } }
                catch (Exception error) { ToolTip = "画像を読み込めませんでした。" + error.Message; label.Text = "!"; }
            }
            return;
        }
        try { var bitmap = await workspace.AvatarAsync(url); if (Entry?.AvatarUrl == url && Workspace == workspace) { image.Source = bitmap; label.Text = ""; roomSymbol.Visibility = Visibility.Collapsed; } }
        catch (Exception error)
        {
            if (Entry?.AvatarUrl == url && Workspace == workspace) { label.Text = "!"; ToolTip = "画像を読み込めませんでした。" + error.Message; System.Windows.Automation.AutomationProperties.SetName(this, entry.Name + "の画像を読み込めませんでした。"); }
        }
    }
    internal static Geometry CreateRoomSymbol()
    {
        var geometry = new GeometryGroup();
        geometry.Children.Add(new EllipseGeometry(new Point(12, 9), 3.5, 3.5)); geometry.Children.Add(new EllipseGeometry(new Point(22, 7), 4, 4)); geometry.Children.Add(new EllipseGeometry(new Point(32, 9), 3.5, 3.5));
        geometry.Children.Add(new RectangleGeometry(new Rect(6, 15, 12, 10), 4, 4)); geometry.Children.Add(new RectangleGeometry(new Rect(14, 14, 16, 12), 5, 5)); geometry.Children.Add(new RectangleGeometry(new Rect(26, 15, 12, 10), 4, 4)); geometry.Freeze(); return geometry;
    }
}
