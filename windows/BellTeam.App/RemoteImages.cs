using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Input;
using BellTeam.Core;

namespace BellTeam.App;

// Mac MessageImages: one image up to 230 wide, or a fanned stack of up to three 230x322 cards captioned "画像N枚".
public sealed class RemoteImages(Workspace workspace) : StackPanel
{
    private const double CardWidth = 230;
    private const double CardHeight = CardWidth * 1.4;
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
        System.Windows.Automation.AutomationProperties.SetName(button, urls.Length > 1 ? AppStrings.RemoteImages_Update_1(urls.Length) : AppStrings.RemoteImages_Update_2);
        button.Click += (_, _) => ((MainWindow)Window.GetWindow(this)).ShowGallery(paths, 0);
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
        caption.Children.Add(new TextBlock { Text = AppStrings.MessageCard_UpdateRow_1(urls.Length), FontSize = 13, Foreground = new SolidColorBrush(Color.FromRgb(120, 125, 145)) });
        button.Content = canvas; Children.Add(button); Children.Add(caption);
    }
}

public sealed class RemoteImage : Grid
{
    private readonly CancellationTokenSource lifetime;
    private readonly Image image = new() { Stretch = Stretch.Uniform };
    private readonly TextBlock status = new() { Text = AppStrings.RemoteImages_status_1, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center };
    public Task LoadTask { get; }
    public ImageSource? Source => image.Source;
    public RemoteImage(Workspace workspace, string path, int? maximumDimension = null)
    {
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(workspace.ViewToken);
        if (maximumDimension is not null) { image.Stretch = Stretch.UniformToFill; ClipToBounds = true; status.Text = AppStrings.RemoteImages_RemoteImage_1; status.FontSize = 12; }
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
        catch (Exception error) { if (!token.IsCancellationRequested) { status.Text = AppStrings.RemoteImages_LoadAsync_1; status.Foreground = Brushes.Firebrick; ToolTip = error.Message; } }
    }
}

// Mac MessageImageGallery as a full-window dark cover inside the main window: × and "n / N" on top, the picture, then ‹ thumbnail strip ›.
public sealed class ImageGallery : Grid
{
    private static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");
    private readonly string[] paths;
    private readonly ContentControl content = new();
    private readonly TextBlock position = new() { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center, FontSize = 18, Foreground = Brushes.White };
    private readonly List<Task> imageLoads = [];
    private readonly List<Button> thumbnails = [];
    private readonly Workspace workspace;
    private readonly Action close;
    private readonly Border notice = new() { Background = new SolidColorBrush(Color.FromArgb(220, 40, 40, 48)), CornerRadius = new CornerRadius(14), Padding = new Thickness(16, 9, 16, 9), Margin = new Thickness(0, 0, 0, 24), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Bottom, Child = new TextBlock { FontSize = 15, Foreground = Brushes.White, TextWrapping = TextWrapping.Wrap } };
    private readonly System.Windows.Threading.DispatcherTimer noticeTimer = new() { Interval = TimeSpan.FromSeconds(4) };
    private ZoomPane? pane;
    public int Selected { get; private set; }
    public string? NoticeText => notice.Visibility == Visibility.Visible ? ((TextBlock)notice.Child).Text : null;
    public Task ReadyTask => Task.WhenAll(imageLoads);
    public ImageGallery(Workspace workspace, string[] paths, int initial, Action close)
    {
        this.workspace = workspace; this.paths = paths; this.close = close; Background = Brushes.Black;
        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); RowDefinitions.Add(new RowDefinition()); RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var header = new Grid { Margin = new Thickness(16, 16, 16, 0) };
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(100) }); header.ColumnDefinitions.Add(new ColumnDefinition()); header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(100) });
        var closeButton = Control("", "GalleryCircleButton", AppStrings.ApprovalsWindow_NotUsable_1, AppStrings.RemoteImages_ImageGallery_2, close); closeButton.HorizontalAlignment = HorizontalAlignment.Left;
        header.Children.Add(closeButton); Grid.SetColumn(position, 1); header.Children.Add(position);
        // The original bytes of the shown picture (image-original.md): 保存 writes them to a file the Owner picks, 共有 hands them to the Windows share sheet.
        var actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        actions.Children.Add(Control("\uE896", "GalleryCircleButton", AppStrings.EditorForm_SaveLabel_1, AppStrings.RemoteImages_ImageGallery_4, () => _ = SaveAsync()));
        var share = Control("\uE72D", "GalleryCircleButton", AppStrings.RemoteImages_ImageGallery_5, AppStrings.RemoteImages_ImageGallery_6, () => _ = ShareAsync()); share.Margin = new Thickness(8, 0, 0, 0); actions.Children.Add(share);
        Grid.SetColumn(actions, 2); header.Children.Add(actions);
        Children.Add(header);
        SetRow(content, 1); content.Margin = new Thickness(16, 16, 16, 8); Children.Add(content);
        notice.Visibility = Visibility.Collapsed; SetRow(notice, 1); Children.Add(notice);
        if (paths.Length > 1)
        {
            var controls = new DockPanel { Margin = new Thickness(16, 0, 16, 16) };
            var previous = Control("", "GalleryChevronButton", AppStrings.RemoteImages_ImageGallery_7, AppStrings.RemoteImages_ImageGallery_8, () => Move(-1)); var next = Control("", "GalleryChevronButton", AppStrings.RemoteImages_ImageGallery_9, AppStrings.RemoteImages_ImageGallery_10, () => Move(1));
            DockPanel.SetDock(previous, Dock.Left); DockPanel.SetDock(next, Dock.Right); controls.Children.Add(previous); controls.Children.Add(next);
            var strip = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
            var scroll = new ScrollViewer { Content = strip, HorizontalScrollBarVisibility = ScrollBarVisibility.Hidden, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled, Height = 72 };
            foreach (var index in Enumerable.Range(0, paths.Length))
            {
                var image = new RemoteImage(workspace, paths[index], maximumDimension: 192) { Width = 64, Height = 64 }; imageLoads.Add(image.LoadTask); RoundClip.Apply(image, 8);
                var thumbnail = new Button { Content = image }; thumbnail.SetResourceReference(StyleProperty, "GalleryThumbButton");
                System.Windows.Automation.AutomationProperties.SetName(thumbnail, AppStrings.RemoteImages_ImageGallery_11(index + 1)); thumbnail.Click += (_, _) => Show(index); thumbnails.Add(thumbnail); strip.Children.Add(thumbnail);
            }
            controls.Children.Add(scroll); SetRow(controls, 2); Children.Add(controls);
        }
        Show(initial);
    }
    private static Button Control(string glyph, string style, string name, string tip, Action click)
    {
        var button = new Button { Content = new TextBlock { Text = glyph, FontFamily = Icons, FontSize = 16, Foreground = Brushes.White }, ToolTip = tip };
        button.SetResourceReference(StyleProperty, style); System.Windows.Automation.AutomationProperties.SetName(button, name); button.Click += (_, _) => click(); return button;
    }
    // Mac: ← and → wrap around the pictures, Esc closes.
    public void Move(int change) => Show((Selected + paths.Length + change) % paths.Length);
    public bool HandleKey(Key key)
    {
        if (key == Key.Escape) { close(); return true; }
        if (paths.Length > 1 && key is Key.Left or Key.Right) { Move(key == Key.Left ? -1 : 1); return true; }
        // + - 0: zoom about the centre and back to fit (the wheel and a pinch zoom about the pointer in ZoomPane).
        if (key is Key.OemPlus or Key.Add) { pane?.ZoomBy(ImageZoom.Step); return true; }
        if (key is Key.OemMinus or Key.Subtract) { pane?.ZoomBy(1 / ImageZoom.Step); return true; }
        if (key is Key.D0 or Key.NumPad0) { pane?.ResetZoom(); return true; }
        return false;
    }
    internal void ZoomForRender(double factor) => pane?.ZoomBy(factor);
    internal void Notify(string text, bool error = false)
    {
        var label = (TextBlock)notice.Child; label.Text = text; label.Foreground = error ? new SolidColorBrush(Color.FromRgb(255, 140, 130)) : Brushes.White; notice.Visibility = Visibility.Visible;
        noticeTimer.Stop(); noticeTimer.Tick -= HideNotice; noticeTimer.Tick += HideNotice; noticeTimer.Start();
    }
    private void HideNotice(object? sender, EventArgs args) { noticeTimer.Stop(); notice.Visibility = Visibility.Collapsed; }
    // The saved file name is the one the server gave the picture (the last segment of its URL, ASCII, extension matches the type).
    private string FileName() => System.IO.Path.GetFileName(paths[Selected].Split('?')[0]);
    private async Task SaveAsync()
    {
        var name = FileName(); var extension = System.IO.Path.GetExtension(name);
        var dialog = new Microsoft.Win32.SaveFileDialog { FileName = name, DefaultExt = extension, Filter = AppStrings.RemoteImages_SaveAsync_1(extension, extension) };
        if (dialog.ShowDialog(Window.GetWindow(this)) != true) return;
        try { await System.IO.File.WriteAllBytesAsync(dialog.FileName, await workspace.ImageAsync(paths[Selected], workspace.ViewToken)); Notify(AppStrings.App_xaml_OnStartup_2(System.IO.Path.GetFileName(dialog.FileName))); }
        catch (Exception error) { Notify(AppStrings.RemoteImages_SaveAsync_3(error.Message), error: true); }
    }
    private async Task ShareAsync()
    {
        try
        {
            var name = FileName(); var folder = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "BellTeam", "share"); System.IO.Directory.CreateDirectory(folder);
            var file = System.IO.Path.Combine(folder, name);
            await System.IO.File.WriteAllBytesAsync(file, await workspace.ImageAsync(paths[Selected], workspace.ViewToken));
            await WindowsShare.ShowFileAsync(new System.Windows.Interop.WindowInteropHelper(Window.GetWindow(this)).Handle, name, file);
        }
        catch (Exception error) { Notify(AppStrings.RemoteImages_ShareAsync_1(error.Message), error: true); }
    }
    private void Show(int index)
    {
        Selected = index;
        var image = new RemoteImage(workspace, paths[index]); imageLoads.Add(image.LoadTask); pane = new ZoomPane(image); content.Content = pane; position.Text = $"{index + 1} / {paths.Length}";
        for (var at = 0; at < thumbnails.Count; at++) { thumbnails[at].Opacity = at == index ? 1 : .5; thumbnails[at].BorderBrush = at == index ? Brushes.White : Brushes.Transparent; }
        if (thumbnails.Count != 0) thumbnails[index].BringIntoView();
    }
}
