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
    private readonly TextBlock label = new() { FontSize = 20, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    public AvatarTile()
    {
        var grid = new Grid(); grid.Children.Add(label); grid.Children.Add(image); Child = grid;
        SizeChanged += (_, _) => Clip = new EllipseGeometry(new Rect(0, 0, ActualWidth, ActualHeight));
    }
    private static void Changed(DependencyObject target, DependencyPropertyChangedEventArgs args) { var tile = (AvatarTile)target; tile.LoadTask = tile.LoadAsync(); }
    private async Task LoadAsync()
    {
        image.Source = null; ToolTip = null;
        var entry = Entry; var workspace = Workspace;
        System.Windows.Automation.AutomationProperties.SetName(this, (entry?.Name ?? "") + "の写真");
        label.Text = entry?.Initial ?? "";
        Background = new SolidColorBrush((entry?.Bot?.Color ?? "violet") switch { "rose" => Color.FromRgb(236, 210, 220), "indigo" => Color.FromRgb(208, 209, 229), _ => Color.FromRgb(221, 211, 236) });
        if (entry?.AvatarUrl is not { } url || workspace is null) return;
        label.Text = "…";
        try { var bitmap = await workspace.AvatarAsync(url); if (Entry?.AvatarUrl == url && Workspace == workspace) { image.Source = bitmap; label.Text = ""; } }
        catch (Exception error)
        {
            if (Entry?.AvatarUrl == url && Workspace == workspace) { label.Text = "!"; ToolTip = "画像を読み込めませんでした。" + error.Message; System.Windows.Automation.AutomationProperties.SetName(this, entry.Name + "の画像を読み込めませんでした。"); }
        }
    }
}
