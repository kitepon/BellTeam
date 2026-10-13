using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Input;

namespace BellTeam.App;

public sealed class RemoteImages(Workspace workspace) : WrapPanel
{
    private string[] paths = [];
    public void Update(string[] urls)
    {
        if (paths.SequenceEqual(urls)) return;
        paths = urls; Children.Clear();
        for (var index = 0; index < paths.Length; index++)
        {
            var selected = index;
            var image = new RemoteImage(workspace, paths[index]) { Width = 190, Height = 150, Margin = new Thickness(3) };
            var button = new Button { Content = image, Padding = new Thickness(0) };
            button.Click += (_, _) => new ImageGallery(workspace, paths, selected) { Owner = Window.GetWindow(this) }.ShowDialog();
            Children.Add(button);
        }
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
            token.ThrowIfCancellationRequested(); image.Source = bitmap; status.Visibility = Visibility.Collapsed;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (!token.IsCancellationRequested) { status.Text = "画像を読み込めませんでした。" + error.Message; status.Foreground = Brushes.Firebrick; } }
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
