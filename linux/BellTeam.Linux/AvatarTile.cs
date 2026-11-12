using Avalonia;
using Avalonia.Controls;
using Shapes = Avalonia.Controls.Shapes;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using BellTeam.Core;

namespace BellTeam.Linux;

public sealed class AvatarTile : Border
{
    private ConversationEntry? entry;
    private LinuxWorkspace? workspace;
    public ConversationEntry? Entry { get => entry; set { entry = value; LoadTask = LoadAsync(); } }
    public LinuxWorkspace? Workspace { get => workspace; set { workspace = value; LoadTask = LoadAsync(); } }
    public Task LoadTask { get; private set; } = Task.CompletedTask;
    private readonly Image image = new() { Stretch = Stretch.UniformToFill };
    private readonly Shapes.Path roomSymbol = new() { Data = RoomSymbol, Fill = Brushes.White, Stretch = Stretch.Uniform, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, IsVisible = false };
    private readonly TextBlock label = new() { FontWeight = FontWeight.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    public AvatarTile()
    {
        ClipToBounds = true;
        Child = new Grid { Children = { label, roomSymbol, image } };
    }
    protected override Size ArrangeOverride(Size finalSize)
    {
        CornerRadius = new CornerRadius(finalSize.Width * .31); label.FontSize = finalSize.Width * .42; roomSymbol.Width = finalSize.Width * .62; roomSymbol.Height = finalSize.Height * .62;
        return base.ArrangeOverride(finalSize);
    }
    private async Task LoadAsync()
    {
        image.Source = null; ToolTip.SetTip(this, null);
        var entry = Entry; var workspace = Workspace;
        label.Text = entry?.Target.IsRoom == true ? "" : entry?.Initial ?? ""; roomSymbol.IsVisible = entry?.Target.IsRoom == true;
        var accent = BellColors.Accent(entry?.Bot?.Color);
        Background = new LinearGradientBrush { StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative), EndPoint = new RelativePoint(1, 1, RelativeUnit.Relative), GradientStops = [new GradientStop(Color.FromArgb(190, accent.R, accent.G, accent.B), 0), new GradientStop(accent, 1)] };
        if (entry?.AvatarUrl is not { } url || workspace is null)
        {
            if (entry?.Bot?.Avatar is { Length: > 0 } inline)
            {
                try { var bitmap = await AvaloniaImageCodec.Instance.DecodeAsync(Convert.FromBase64String(inline[(inline.IndexOf(',') + 1)..])); if (Entry?.Bot?.Avatar == inline) { image.Source = bitmap; label.Text = ""; } }
                catch (Exception error) { ToolTip.SetTip(this, "画像を読み込めませんでした。" + error.Message); label.Text = "!"; }
            }
            return;
        }
        try { var bitmap = await workspace.AvatarAsync(url); if (Entry?.AvatarUrl == url && Workspace == workspace) { image.Source = bitmap; label.Text = ""; roomSymbol.IsVisible = false; } }
        catch (Exception error)
        {
            if (Entry?.AvatarUrl == url && Workspace == workspace) { label.Text = "!"; ToolTip.SetTip(this, "画像を読み込めませんでした。" + error.Message); }
        }
    }
    // Mac person.3.fill: three heads over three rounded bodies.
    private static readonly Geometry RoomSymbol = StreamGeometry.Parse(Icons.Disc(12, 9, 3.5) + Icons.Disc(22, 7, 4) + Icons.Disc(32, 9, 3.5) + Icons.RoundedRect(6, 15, 12, 10, 4) + Icons.RoundedRect(14, 14, 16, 12, 5) + Icons.RoundedRect(26, 15, 12, 10, 4));
}
