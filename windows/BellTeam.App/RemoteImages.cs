using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;

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
    public RemoteImage(Workspace workspace, string path)
    {
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(workspace.ViewToken);
        Children.Add(image); Children.Add(status);
        LoadTask = LoadAsync(workspace, path, lifetime.Token);
        Unloaded += Release;
    }
    private void Release(object sender, RoutedEventArgs args) { Unloaded -= Release; lifetime.Cancel(); lifetime.Dispose(); }
    private async Task LoadAsync(Workspace workspace, string path, CancellationToken token)
    {
        try
        {
            var bytes = await workspace.ImageAsync(path, token);
            var bitmap = await ImageCodec.DecodeAsync(bytes);
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
    public ImageGallery(Workspace workspace, string[] paths, int initial)
    {
        selected = initial; Title = "画像"; Width = 960; Height = 720; MinWidth = 500; MinHeight = 400;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var dock = new DockPanel(); var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        var previous = new Button { Content = "前の画像", IsEnabled = paths.Length > 1 };
        var next = new Button { Content = "次の画像", IsEnabled = paths.Length > 1 };
        void ShowImage() { content.Content = new RemoteImage(workspace, paths[selected]) { Margin = new Thickness(20) }; position.Text = $"{selected + 1} / {paths.Length}"; }
        previous.Click += (_, _) => { selected = (selected + paths.Length - 1) % paths.Length; ShowImage(); };
        next.Click += (_, _) => { selected = (selected + 1) % paths.Length; ShowImage(); };
        buttons.Children.Add(previous); buttons.Children.Add(position); buttons.Children.Add(next);
        DockPanel.SetDock(buttons, Dock.Bottom); dock.Children.Add(buttons); dock.Children.Add(content); Content = dock; ShowImage();
    }
}
