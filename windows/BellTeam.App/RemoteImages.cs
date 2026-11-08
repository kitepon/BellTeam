using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Input;

namespace BellTeam.App;

// Mac MessageImages: one image up to 230 wide, or a fanned stack of up to three 230x322 cards captioned "画像N枚".
public sealed class RemoteImages(Workspace workspace) : StackPanel
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
        var button = new Button { Padding = new Thickness(0), Margin = new Thickness(0), HorizontalAlignment = outgoing ? HorizontalAlignment.Right : HorizontalAlignment.Left, Cursor = System.Windows.Input.Cursors.Hand };
        button.SetResourceReference(StyleProperty, "QuietButton"); button.Padding = new Thickness(0); button.Margin = new Thickness(0);
        System.Windows.Automation.AutomationProperties.SetName(button, urls.Length > 1 ? $"画像{urls.Length}枚を開く" : "画像を開く");
        button.Click += (_, _) => new ImageGallery(workspace, paths, 0) { Owner = Window.GetWindow(this) }.ShowDialog();
        if (urls.Length == 1)
        {
            var image = new RemoteImage(workspace, urls[0]) { Width = CardWidth }; RoundClip.Apply(image, 13);
            button.Content = image; Children.Add(button); return;
        }
        // Mac: padding on the side the fan leans away from, 8 above and 22% of the card width below, so the fan stays inside its frame.
        var canvas = new Canvas { Width = CardWidth * 1.2, Height = 8 + CardHeight + CardWidth * .22 };
        var sign = outgoing ? -1 : 1; var origin = outgoing ? CardWidth * .2 : 0;
        for (var depth = Math.Min(urls.Length, 3) - 1; depth >= 0; depth--)
        {
            var card = new Border { Width = CardWidth, Height = CardHeight, CornerRadius = new CornerRadius(18), BorderBrush = new SolidColorBrush(Color.FromArgb(20, 0, 0, 0)), BorderThickness = new Thickness(1), Background = Brushes.White };
            card.Effect = new System.Windows.Media.Effects.DropShadowEffect { Color = Colors.Black, Opacity = .18, BlurRadius = 20, ShadowDepth = 8, Direction = 270 };
            var inner = new Grid(); RoundClip.Apply(inner, 17);
            inner.Children.Add(new RemoteImage(workspace, urls[depth], maximumDimension: 1024));
            if (depth > 0) inner.Children.Add(new Border { Background = new SolidColorBrush(Color.FromArgb(71, 255, 255, 255)) });
            card.Child = inner;
            var scale = 1 - depth * .04;
            card.RenderTransform = new TransformGroup { Children = [new ScaleTransform(scale, scale, CardWidth / 2, CardHeight / 2), new RotateTransform(depth * 4 * sign, CardWidth / 2, CardHeight / 2), new TranslateTransform(depth * CardWidth * .10 * sign, depth * CardWidth * .11)] };
            Canvas.SetLeft(card, origin); Canvas.SetTop(card, 8); canvas.Children.Add(card);
        }
        var caption = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 0), HorizontalAlignment = outgoing ? HorizontalAlignment.Right : HorizontalAlignment.Left };
        caption.Children.Add(new TextBlock { Text = "\uE8B9", FontFamily = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"), FontSize = 13, Foreground = new SolidColorBrush(Color.FromRgb(120, 125, 145)), Margin = new Thickness(0, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center });
        caption.Children.Add(new TextBlock { Text = $"画像{urls.Length}枚", FontSize = 13, Foreground = new SolidColorBrush(Color.FromRgb(120, 125, 145)) });
        button.Content = canvas; Children.Add(button); Children.Add(caption);
    }
}

public sealed class RemoteImage : Grid
{
    private readonly CancellationTokenSource lifetime;
    private readonly Image image = new() { Stretch = Stretch.Uniform };
    private readonly TextBlock status = new() { Text = "画像を読込中…", TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center };
    public Task LoadTask { get; }
    public RemoteImage(Workspace workspace, string path, int? maximumDimension = null)
    {
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(workspace.ViewToken);
        if (maximumDimension is not null) { image.Stretch = Stretch.UniformToFill; ClipToBounds = true; status.Text = "読込中…"; status.FontSize = 12; }
        if (maximumDimension is null) MinHeight = 90; // Mac AuthenticatedImage placeholder (120x90) while loading
        Children.Add(image); Children.Add(status);
        LoadTask = LoadAsync(workspace, path, lifetime.Token, maximumDimension);
        Unloaded += Release;
    }
    private void Release(object sender, RoutedEventArgs args) { Unloaded -= Release; lifetime.Cancel(); lifetime.Dispose(); }
    private async Task LoadAsync(Workspace workspace, string path, CancellationToken token, int? maximumDimension)
    {
        try
        {
            var bytes = await workspace.ImageAsync(path, token);
            var bitmap = await ImageCodec.DecodeAsync(bytes, maximumDimension);
            token.ThrowIfCancellationRequested(); image.Source = bitmap; status.Visibility = Visibility.Collapsed; MinHeight = 0;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (!token.IsCancellationRequested) { status.Text = "画像を読み込めません"; status.Foreground = Brushes.Firebrick; ToolTip = error.Message; } }
    }
}

public sealed class ImageGallery : Window
{
    private int selected;
    private readonly ContentControl content = new();
    private readonly TextBlock position = new() { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(12) };
    private readonly List<Task> imageLoads = [];
    public Task ReadyTask => Task.WhenAll(imageLoads);
    public ImageGallery(Workspace workspace, string[] paths, int initial)
    {
        SetResourceReference(StyleProperty, typeof(Window));
        selected = initial; Title = "画像"; Width = 960; Height = 720; MinWidth = 500; MinHeight = 400;
        Background = new SolidColorBrush(Color.FromRgb(20, 21, 26)); Foreground = Brushes.White;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var dock = new DockPanel(); var header = new DockPanel { Margin = new Thickness(16, 10, 16, 0) };
        var close = new Button { Content = "閉じる", IsCancel = true, Foreground = Brushes.White, Width = 80, Margin = new Thickness(0) }; close.SetResourceReference(StyleProperty, "QuietButton"); close.Click += (_, _) => Close();
        DockPanel.SetDock(close, Dock.Right); header.Children.Add(close); var spacer = new Border { Width = 80 }; DockPanel.SetDock(spacer,Dock.Left); header.Children.Add(spacer); position.HorizontalAlignment = HorizontalAlignment.Center; position.FontSize = 18; header.Children.Add(position);
        DockPanel.SetDock(header, Dock.Top); dock.Children.Add(header);
        var thumbnails = new List<Button>();
        void ShowImage()
        {
            var image = new RemoteImage(workspace, paths[selected]) { Margin = new Thickness(20) }; imageLoads.Add(image.LoadTask); content.Content = image; position.Text = $"{selected + 1} / {paths.Length}";
            for (var index = 0; index < thumbnails.Count; index++) { thumbnails[index].Opacity = index == selected ? 1 : .5; thumbnails[index].BorderBrush = index == selected ? Brushes.MediumPurple : Brushes.Transparent; }
            if (thumbnails.Count != 0) thumbnails[selected].BringIntoView();
        }
        void Move(int change) { selected = (selected + paths.Length + change) % paths.Length; ShowImage(); }
        if (paths.Length > 1)
        {
            var controls = new DockPanel { Margin = new Thickness(16, 0, 16, 16) };
            var previous = new Button { Content = "前の画像", Foreground = Brushes.White, ToolTip = "前の画像（←）" }; previous.SetResourceReference(StyleProperty, "QuietButton"); previous.Click += (_, _) => Move(-1);
            var next = new Button { Content = "次の画像", Foreground = Brushes.White, ToolTip = "次の画像（→）" }; next.SetResourceReference(StyleProperty, "QuietButton"); next.Click += (_, _) => Move(1);
            DockPanel.SetDock(previous, Dock.Left); DockPanel.SetDock(next, Dock.Right); controls.Children.Add(previous); controls.Children.Add(next);
            var strip = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center }; var scroll = new ScrollViewer { Content = strip, HorizontalContentAlignment = HorizontalAlignment.Center, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled };
            foreach (var index in Enumerable.Range(0, paths.Length))
            {
                var image = new RemoteImage(workspace, paths[index], maximumDimension: 128) { Width = 64, Height = 64 }; imageLoads.Add(image.LoadTask);
                var thumbnail = new Button { Content = image, Padding = new Thickness(0), Margin = new Thickness(4), BorderThickness = new Thickness(2), Background = Brushes.Transparent };
                System.Windows.Automation.AutomationProperties.SetName(thumbnail, $"画像{index + 1}"); thumbnail.Click += (_, _) => { selected = index; ShowImage(); }; thumbnails.Add(thumbnail); strip.Children.Add(thumbnail);
            }
            controls.Children.Add(scroll); DockPanel.SetDock(controls, Dock.Bottom); dock.Children.Add(controls);
        }
        PreviewKeyDown += (_, args) =>
        {
            if (Keyboard.Modifiers != ModifierKeys.None) return;
            if (args.Key == Key.Escape) { args.Handled = true; Close(); }
            else if (paths.Length > 1 && args.Key is Key.Left or Key.Right) { args.Handled = true; Move(args.Key == Key.Left ? -1 : 1); }
        };
        dock.Children.Add(content); Content = dock; ShowImage();
    }
}
