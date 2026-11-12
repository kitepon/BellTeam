using Avalonia.Automation;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;

namespace BellTeam.Linux;

// Mac MessageImages: one image up to 230 wide, or a fanned stack of up to three 230x322 cards captioned "画像N枚".
public sealed class RemoteImages(LinuxWorkspace workspace) : StackPanel
{
    private const double CardWidth = 230, CardHeight = CardWidth * 1.4;
    private string[] paths = [];
    private bool outgoing;
    public void Update(string[] urls, bool outgoing)
    {
        if (paths.SequenceEqual(urls) && this.outgoing == outgoing) return;
        paths = urls; this.outgoing = outgoing; Children.Clear();
        HorizontalAlignment = outgoing ? HorizontalAlignment.Right : HorizontalAlignment.Left;
        if (urls.Length == 0) return;
        var button = new Button { Classes = { "plain" }, Background = Brushes.Transparent, Padding = default, Margin = default, HorizontalAlignment = outgoing ? HorizontalAlignment.Right : HorizontalAlignment.Left };
        AutomationProperties.SetName(button, urls.Length > 1 ? $"画像{urls.Length}枚を開く" : "画像を開く");
        button.Click += (_, _) => (TopLevel.GetTopLevel(this) as MainWindow)?.ShowGallery(paths, 0);
        if (urls.Length == 1) { button.Content = Round.Clip(new RemoteImage(workspace, urls[0]) { Width = CardWidth }, 13); Children.Add(button); return; }
        // Mac: padding on the side the fan leans away from, 8 above and 22% of the card width below, so the fan stays inside its frame.
        var canvas = new Canvas { Width = CardWidth * 1.2, Height = 8 + CardHeight + CardWidth * .22 };
        var sign = outgoing ? -1 : 1; var origin = outgoing ? CardWidth * .2 : 0;
        for (var depth = Math.Min(urls.Length, 3) - 1; depth >= 0; depth--)
        {
            var inner = new Grid { Children = { new RemoteImage(workspace, urls[depth], cover: true) } };
            if (depth > 0) inner.Children.Add(new Border { Background = new SolidColorBrush(Color.FromArgb(71, 255, 255, 255)) });
            var card = new Border
            {
                Width = CardWidth, Height = CardHeight, CornerRadius = new CornerRadius(18), BorderBrush = new SolidColorBrush(Color.FromArgb(20, 0, 0, 0)), BorderThickness = new Thickness(1), Background = Brushes.White,
                BoxShadow = BoxShadows.Parse("0 8 20 0 #2E000000"), Child = Round.Clip(inner, 17), RenderTransformOrigin = RelativePoint.Center
            };
            var scale = 1 - depth * .04;
            card.RenderTransform = new TransformGroup { Children = { new ScaleTransform(scale, scale), new RotateTransform(depth * 4 * sign), new TranslateTransform(depth * CardWidth * .10 * sign, depth * CardWidth * .11) } };
            Canvas.SetLeft(card, origin); Canvas.SetTop(card, 8); canvas.Children.Add(card);
        }
        var caption = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Margin = new Thickness(0, 10, 0, 0), HorizontalAlignment = outgoing ? HorizontalAlignment.Right : HorizontalAlignment.Left };
        caption.Children.Add(Icons.Draw(Icons.Image, 14, BellTheme.Muted, thickness: 1.6));
        caption.Children.Add(new TextBlock { Text = $"画像{urls.Length}枚", FontSize = 13, Foreground = BellTheme.Muted });
        button.Content = canvas; Children.Add(button); Children.Add(caption);
    }
}

public sealed class RemoteImage : Grid
{
    private CancellationTokenSource? lifetime;
    private readonly LinuxWorkspace workspace;
    private readonly string path;
    private readonly Image image;
    private readonly TextBlock status = new() { Text = "画像を読込中…", TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center };
    public Task LoadTask { get; private set; } = Task.CompletedTask;
    public RemoteImage(LinuxWorkspace workspace, string path, bool cover = false)
    {
        this.workspace = workspace; this.path = path;
        image = new Image { Stretch = cover ? Stretch.UniformToFill : Stretch.Uniform };
        if (cover) { ClipToBounds = true; status.Text = "読込中…"; status.FontSize = 12; }
        else MinHeight = 90; // Mac AuthenticatedImage placeholder (120x90) while loading
        Children.Add(image); Children.Add(status);
    }
    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        if (lifetime is not null) return;
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(workspace.ViewToken);
        LoadTask = LoadAsync(lifetime.Token);
    }
    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e) { lifetime?.Cancel(); lifetime?.Dispose(); lifetime = null; base.OnDetachedFromVisualTree(e); }
    private async Task LoadAsync(CancellationToken token)
    {
        try
        {
            var bytes = await workspace.ImageAsync(path, token);
            var bitmap = await AvaloniaImageCodec.Instance.DecodeAsync(bytes);
            token.ThrowIfCancellationRequested(); image.Source = bitmap; status.IsVisible = false; MinHeight = 0;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (!token.IsCancellationRequested) { status.Text = "画像を読み込めません"; status.Foreground = Brushes.Firebrick; ToolTip.SetTip(this, error.Message); } }
    }
}

// Mac MessageImageGallery as a full-window dark cover inside the main window: × and "n / N" on top, the picture, then ‹ ›.
// shortcut: no thumbnail strip, upgrade with the Windows ImageGallery strip when many-image messages need it.
public sealed class ImageGallery : Grid
{
    private readonly string[] paths;
    private readonly LinuxWorkspace workspace;
    private readonly Action close;
    private readonly ContentControl content = new();
    private readonly TextBlock position = new() { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center, FontSize = 18, Foreground = Brushes.White };
    public int Selected { get; private set; }
    public ImageGallery(LinuxWorkspace workspace, string[] paths, int initial, Action close)
    {
        this.workspace = workspace; this.paths = paths; this.close = close; Background = Brushes.Black;
        RowDefinitions = new RowDefinitions("Auto,*");
        var header = new Grid { Margin = new Thickness(16, 16, 16, 0), ColumnDefinitions = new ColumnDefinitions("44,*,44") };
        header.Children.Add(Control(Icons.Close, "閉じる", "閉じる（Esc）", close));
        SetColumn(position, 1); header.Children.Add(position); Children.Add(header);
        SetRow(content, 1); content.Margin = new Thickness(16); Children.Add(content);
        if (paths.Length > 1)
        {
            var previous = Control(Icons.ChevronRight, "前の画像", "前の画像（←）", () => Move(-1)); previous.RenderTransform = new ScaleTransform(-1, 1); previous.RenderTransformOrigin = RelativePoint.Center;
            previous.HorizontalAlignment = HorizontalAlignment.Left; previous.VerticalAlignment = VerticalAlignment.Center; previous.Margin = new Thickness(16, 0, 0, 0); SetRow(previous, 1); Children.Add(previous);
            var next = Control(Icons.ChevronRight, "次の画像", "次の画像（→）", () => Move(1));
            next.HorizontalAlignment = HorizontalAlignment.Right; next.VerticalAlignment = VerticalAlignment.Center; next.Margin = new Thickness(0, 0, 16, 0); SetRow(next, 1); Children.Add(next);
        }
        Show(initial);
    }
    private static Button Control(string icon, string name, string tip, Action click)
    {
        var button = new Button { Classes = { "plain" }, Width = 44, Height = 44, Padding = default, CornerRadius = new CornerRadius(22), Background = new SolidColorBrush(Color.Parse("#2EFFFFFF")), Content = Icons.Draw(icon, 20, Brushes.White), HorizontalContentAlignment = HorizontalAlignment.Center, VerticalContentAlignment = VerticalAlignment.Center };
        ToolTip.SetTip(button, tip); AutomationProperties.SetName(button, name); button.Click += (_, _) => click(); return button;
    }
    // Mac: ← and → wrap around the pictures, Esc closes.
    public void Move(int change) => Show((Selected + paths.Length + change) % paths.Length);
    public bool HandleKey(Key key)
    {
        if (key == Key.Escape) { close(); return true; }
        if (paths.Length > 1 && key is Key.Left or Key.Right) { Move(key == Key.Left ? -1 : 1); return true; }
        return false;
    }
    private void Show(int index) { Selected = index; content.Content = new RemoteImage(workspace, paths[index]); position.Text = $"{index + 1} / {paths.Length}"; }
}
