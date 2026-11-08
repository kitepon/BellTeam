using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using BellTeam.Core;
using Microsoft.Win32;

namespace BellTeam.App;

public sealed class AvatarPicker : StackPanel
{
    private readonly Image image = new() { Width = 80, Height = 80, Stretch = Stretch.Uniform };
    internal Image Preview => image;
    private readonly UIElement placeholder;
    private readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap, FontSize = 14 };
    private readonly Func<byte[], Task<BitmapSource>> decode;
    public string Value { get; private set; }
    public AvatarPicker(string value, Func<byte[], Task<BitmapSource>>? decode = null, string name = "B", string color = "violet", bool isRoom = false, bool compact = false, bool quiet = false)
    {
        // quiet: the Mac settings look (74pt portrait, small text-only 写真を変更).
        var size = quiet ? 74 : 80; image.Width = image.Height = size;
        this.decode = decode ?? ImageCodec.DecodeAsync;
        Value = value;
        placeholder = isRoom ? new System.Windows.Shapes.Path { Data = AvatarTile.CreateRoomSymbol(), Fill = Brushes.White, Stretch = Stretch.Uniform, Width = 50, Height = 50, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center }
            : new TextBlock { Text = name.Length == 0 ? "B" : System.Globalization.StringInfo.GetNextTextElement(name), FontSize = 34, FontWeight = FontWeights.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        var portrait = new Grid { Width = size, Height = size, Clip = new RectangleGeometry(new Rect(0, 0, size, size), size * .31, size * .31) }; portrait.Children.Add(placeholder); portrait.Children.Add(image);
        Children.Add(new Border { Child = portrait, Background = new SolidColorBrush(BellColors.Accent(color)), CornerRadius = new CornerRadius(size * .31), HorizontalAlignment = HorizontalAlignment.Center }); Children.Add(status);
        var choose = new Button { Content = "写真を変更", HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 10, 0, 2) };
        choose.Click += async (_, _) =>
        {
            var file = new OpenFileDialog { Filter = "画像|*.png;*.jpg;*.jpeg;*.webp;*.gif" };
            if (file.ShowDialog(Window.GetWindow(this)) != true) return;
            try
            {
                var loaded = await ImageCodec.ReadAsync(file.FileName);
                var crop = new AvatarCropWindow(loaded.Preview) { Owner = Window.GetWindow(this) };
                if (crop.ShowDialog() == true) { Value = crop.DataUrl; await LoadAsync(); }
            }
            catch (Exception error) { status.Text = "画像を読み込めませんでした。" + error.Message; }
        };
        var remove = new Button { Content = "写真を取り外す", HorizontalAlignment = HorizontalAlignment.Center, FontSize = 12 };
        remove.SetResourceReference(StyleProperty, "QuietButton");
        remove.Click += (_, _) => { Value = ""; image.Source = null; placeholder.Visibility = Visibility.Visible; status.Text = "保存すると写真を取り外します。"; };
        if (quiet) { choose.SetResourceReference(StyleProperty, "QuietButton"); choose.FontSize = 12; choose.Padding = new Thickness(6, 2, 6, 2); choose.Margin = new Thickness(0, 6, 0, 0); }
        if (quiet) { var hideEmpty = new Style(typeof(TextBlock)); hideEmpty.Triggers.Add(new Trigger { Property = TextBlock.TextProperty, Value = "", Setters = { new Setter(VisibilityProperty, Visibility.Collapsed) } }); status.Style = hideEmpty; }
        if (quiet) { remove.Padding = new Thickness(6, 1, 6, 1); remove.Margin = new Thickness(0, 0, 0, 2); remove.FontWeight = FontWeights.Normal; remove.Foreground = Brushes.SlateGray; }
        Children.Add(choose); Children.Add(remove);
        if (compact)
        {
            var portraitView = Children[0]; Children.Remove(portraitView); Children.Remove(choose); Children.Remove(remove);
            var row = new Grid { Margin = new Thickness(0, 0, 0, 12) }; row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(96) }); row.ColumnDefinitions.Add(new ColumnDefinition()); row.Children.Add(portraitView);
            var actions = new StackPanel { VerticalAlignment = VerticalAlignment.Center }; choose.HorizontalAlignment = remove.HorizontalAlignment = HorizontalAlignment.Left; choose.Margin = new Thickness(0, 0, 0, 4); actions.Children.Add(choose); actions.Children.Add(remove); Grid.SetColumn(actions, 1); row.Children.Add(actions); Children.Insert(0, row);
        }
    }
    public async Task LoadAsync()
    {
        var requested = Value;
        if (requested.Length == 0) { image.Source = null; placeholder.Visibility = Visibility.Visible; return; }
        try
        {
            var comma = requested.IndexOf(','); if (comma < 0 || !requested.StartsWith("data:image/", StringComparison.Ordinal)) throw new InvalidDataException("アバターの形式が一致しません。");
            var bitmap = await decode(Convert.FromBase64String(requested[(comma + 1)..]));
            if (Value == requested) { image.Source = bitmap; placeholder.Visibility = Visibility.Collapsed; status.Text = ""; }
        }
        catch (Exception error) { if (Value == requested) status.Text = "画像を読み込めませんでした。" + error.Message; }
    }
}

public sealed class AvatarCropWindow : Window
{
    private readonly BitmapSource original;
    private readonly AvatarCrop crop;
    private readonly Canvas preview = new() { Width = 320, Height = 320, Background = Brushes.White };
    private readonly Image image = new();
    private readonly TextBlock error = new() { TextWrapping = TextWrapping.Wrap, Foreground = Brushes.Firebrick, Margin = new Thickness(0, 12, 0, 0), FontSize = 13 };
    private Point? start;
    private Point offset;
    public string DataUrl { get; private set; } = "";
    // Set only when the window was asked for a selection (the inspector's image actions): the render, a source copy and the crop rectangle.
    public AvatarSelection? Selection { get; private set; }
    internal Slider ZoomSlider { get; }
    public AvatarCropWindow(BitmapSource original, AvatarVariant variant = AvatarVariant.Small, AvatarCropRect? initialCrop = null, bool wantsSelection = false)
    {
        this.original = original; crop = (initialCrop is null ? null : AvatarCrop.From(original.PixelWidth, original.PixelHeight, variant.Side(), initialCrop)) ?? new(original.PixelWidth, original.PixelHeight, variant.Side());
        Title = "画像を調整"; Width = 680; Height = 520; ResizeMode = ResizeMode.NoResize; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        preview.Clip = new RectangleGeometry(new Rect(0, 0, 320, 320), 76.8, 76.8); preview.Children.Add(image); image.Source = original;
        var dock = new DockPanel { Margin = new Thickness(24) };
        var note = new TextBlock { Text = "画像をドラッグして、使いたい部分を枠に合わせてね。", TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 15) }; DockPanel.SetDock(note, Dock.Top); dock.Children.Add(note);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        var cancel = new Button { Content = "キャンセル" }; cancel.Click += (_, _) => Close();
        var use = new Button { Content = "使用する" };
        use.Click += (_, _) =>
        {
            DataUrl = Encode(original, crop);
            if (wantsSelection)
            {
                var source = EncodeSource(original);
                if (source is null) { error.Text = "元画像を保存できませんでした。別の画像を選んでください。"; return; }
                Selection = new AvatarSelection(DataUrl, source, crop.Rect);
            }
            DialogResult = true;
        };
        buttons.Children.Add(cancel); buttons.Children.Add(use); DockPanel.SetDock(buttons, Dock.Bottom); dock.Children.Add(buttons);
        var controls = new StackPanel { Width = 230, Margin = new Thickness(20, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        controls.Children.Add(new TextBlock { Text = "拡大・縮小", Margin = new Thickness(0, 0, 0, 12) });
        var zoom = new Slider { Minimum = 1, Maximum = 3, Value = crop.Zoom }; ZoomSlider = zoom; zoom.ValueChanged += (_, args) => { crop.SetZoom(args.NewValue); Update(); }; controls.Children.Add(zoom); controls.Children.Add(error);
        DockPanel.SetDock(controls, Dock.Right); dock.Children.Add(controls); dock.Children.Add(preview); Content = dock;
        preview.MouseLeftButtonDown += (_, args) => { start = args.GetPosition(preview); offset = new(crop.OffsetX, crop.OffsetY); preview.CaptureMouse(); };
        preview.MouseMove += (_, args) => { if (start is not { } first || args.LeftButton != MouseButtonState.Pressed) return; var current = args.GetPosition(preview); crop.MoveTo(offset.X + (current.X - first.X) * crop.Side / 320, offset.Y + (current.Y - first.Y) * crop.Side / 320); Update(); };
        preview.MouseLeftButtonUp += (_, _) => { start = null; preview.ReleaseMouseCapture(); }; Update();
    }
    private void Update() { image.Width = crop.RenderWidth * 320 / crop.Side; image.Height = crop.RenderHeight * 320 / crop.Side; Canvas.SetLeft(image, crop.Left * 320 / crop.Side); Canvas.SetTop(image, crop.Top * 320 / crop.Side); }
    public static string Encode(BitmapSource source, AvatarCrop crop)
    {
        var side = (int)crop.Side;
        var drawing = new DrawingVisual(); using (var context = drawing.RenderOpen()) { context.DrawRectangle(Brushes.White, null, new Rect(0, 0, side, side)); context.DrawImage(source, new Rect(crop.Left, crop.Top, crop.RenderWidth, crop.RenderHeight)); }
        var output = new RenderTargetBitmap(side, side, 96, 96, PixelFormats.Pbgra32); output.Render(drawing);
        var encoder = new JpegBitmapEncoder { QualityLevel = 90 }; encoder.Frames.Add(BitmapFrame.Create(output)); using var stream = new MemoryStream(); encoder.Save(stream);
        return "data:image/jpeg;base64," + Convert.ToBase64String(stream.ToArray());
    }
    // Mac AvatarImage.sourceDataURL: the chosen image kept for later re-cropping, at most 1600 px on a side, JPEG 0.8, null when over 3,000,000 characters.
    public static string? EncodeSource(BitmapSource source)
    {
        var ratio = Math.Min(1, 1600.0 / Math.Max(source.PixelWidth, source.PixelHeight));
        var width = (int)Math.Max(1, Math.Round(source.PixelWidth * ratio)); var height = (int)Math.Max(1, Math.Round(source.PixelHeight * ratio));
        var drawing = new DrawingVisual(); using (var context = drawing.RenderOpen()) { context.DrawRectangle(Brushes.White, null, new Rect(0, 0, width, height)); context.DrawImage(source, new Rect(0, 0, width, height)); }
        var output = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32); output.Render(drawing);
        var encoder = new JpegBitmapEncoder { QualityLevel = 80 }; encoder.Frames.Add(BitmapFrame.Create(output)); using var stream = new MemoryStream(); encoder.Save(stream);
        var value = "data:image/jpeg;base64," + Convert.ToBase64String(stream.ToArray());
        return value.Length <= 3_000_000 ? value : null;
    }
}
