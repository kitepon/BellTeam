using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using BellTeam.Core;
using Microsoft.Win32;

namespace BellTeam.App;

// What the crop sheet hands back: the rendered image and, when the caller asked for one, the kept source and crop rectangle.
public sealed record AvatarCropOutcome(string DataUrl, AvatarSelection? Selection);

internal static class AvatarHost
{
    // The window that shows sheets (the crop sheet among them), found through the tree so an editor not yet shown still resolves it.
    public static IInspectorHost? Of(DependencyObject element)
    {
        for (DependencyObject? current = element; current is not null; current = Parent(current))
            if (current is IInspectorHost host) return host;
        return null;
    }
    private static DependencyObject? Parent(DependencyObject element) => (element is Visual ? VisualTreeHelper.GetParent(element) : null) ?? LogicalTreeHelper.GetParent(element);
    public static async Task<BitmapSource> DecodeAsync(string dataUrl)
    {
        var comma = dataUrl.IndexOf(',');
        if (comma < 0 || !dataUrl.StartsWith("data:image/", StringComparison.Ordinal)) throw new InvalidDataException("アバターの形式が一致しません。");
        return await ImageCodec.DecodeAsync(Convert.FromBase64String(dataUrl[(comma + 1)..]));
    }
}

// A portrait with its change link. quiet: the Mac settings look (74pt portrait, 写真を変更 and 写真を取り外す). Otherwise the Mac Form row look:
// an 80pt portrait with one small link under it, which opens the crop sheet.
public sealed class AvatarPicker : StackPanel
{
    private readonly Image image = new() { Width = 80, Height = 80, Stretch = Stretch.Uniform };
    internal Image Preview => image;
    private readonly UIElement placeholder;
    private readonly Border tile;
    private readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap, FontSize = 14 };
    private readonly Func<byte[], Task<BitmapSource>> decode;
    private readonly AvatarVariant variant;
    private readonly bool keepSelection;
    internal Button ChooseButton { get; }
    public string Value { get; private set; }
    // Set only when the picker keeps the source and crop (a new member's 小画像): what the create sends beside the rendered image.
    public AvatarSelection? Selection { get; private set; }
    public event Action<AvatarCropOutcome>? Chosen;
    public AvatarPicker(string value, Func<byte[], Task<BitmapSource>>? decode = null, string name = "B", string color = "violet", bool isRoom = false, bool quiet = false, string changeLabel = "写真を変更", bool keepSelection = false, AvatarVariant variant = AvatarVariant.Small)
    {
        var size = quiet ? 74 : 80; image.Width = image.Height = size;
        this.decode = decode ?? ImageCodec.DecodeAsync; this.variant = variant; this.keepSelection = keepSelection;
        Value = value;
        placeholder = isRoom ? new System.Windows.Shapes.Path { Data = AvatarTile.CreateRoomSymbol(), Fill = Brushes.White, Stretch = Stretch.Uniform, Width = 50, Height = 50, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center }
            : new TextBlock { Text = name.Length == 0 ? "B" : System.Globalization.StringInfo.GetNextTextElement(name), FontSize = 34, FontWeight = FontWeights.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        var portrait = new Grid { Width = size, Height = size, Clip = new RectangleGeometry(new Rect(0, 0, size, size), size * .31, size * .31) }; portrait.Children.Add(placeholder); portrait.Children.Add(image);
        tile = new Border { Child = portrait, Background = new SolidColorBrush(BellColors.Accent(color)), CornerRadius = new CornerRadius(size * .31), HorizontalAlignment = HorizontalAlignment.Center }; Children.Add(tile); Children.Add(status);
        var choose = new Button { Content = changeLabel, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 10, 0, 2) };
        choose.Click += async (_, _) => await ChooseAsync();
        ChooseButton = choose;
        var hideEmpty = new Style(typeof(TextBlock)); hideEmpty.Triggers.Add(new Trigger { Property = TextBlock.TextProperty, Value = "", Setters = { new Setter(VisibilityProperty, Visibility.Collapsed) } }); status.Style = hideEmpty;
        choose.SetResourceReference(StyleProperty, "QuietButton"); choose.FontSize = 12; choose.Padding = new Thickness(6, 2, 6, 2); choose.Margin = new Thickness(0, 6, 0, 0); choose.FontWeight = FontWeights.Normal;
        Children.Add(choose);
        if (!quiet) { status.FontSize = 12; status.Foreground = Brushes.Firebrick; status.HorizontalAlignment = HorizontalAlignment.Center; return; }
        var remove = new Button { Content = "写真を取り外す", HorizontalAlignment = HorizontalAlignment.Center, FontSize = 12 };
        remove.SetResourceReference(StyleProperty, "QuietButton");
        remove.Click += (_, _) => { Value = ""; Selection = null; image.Source = null; placeholder.Visibility = Visibility.Visible; status.Text = "保存すると写真を取り外します。"; };
        remove.Padding = new Thickness(6, 1, 6, 1); remove.Margin = new Thickness(0, 0, 0, 2); remove.FontWeight = FontWeights.Normal; remove.Foreground = Brushes.SlateGray;
        Children.Add(remove);
    }
    private async Task ChooseAsync()
    {
        var file = new OpenFileDialog { Filter = "画像|*.png;*.jpg;*.jpeg;*.webp;*.gif" };
        var host = AvatarHost.Of(this);
        if ((host?.OwnerWindow is { } owner ? file.ShowDialog(owner) : file.ShowDialog()) != true) return;
        try
        {
            var loaded = await ImageCodec.ReadAsync(file.FileName);
            var outcome = await (host ?? throw new InvalidOperationException("画像の調整画面を開けません。")).CropAsync(loaded.Preview, variant, null, keepSelection);
            if (outcome is null) return;
            Value = outcome.DataUrl; Selection = outcome.Selection; await LoadAsync(); Chosen?.Invoke(outcome);
        }
        catch (Exception error) { status.Text = EditorText.ImageUnreadable + error.Message; }
    }
    // The initial and the tile colour follow the name and theme colour being typed, as the Mac AvatarView does.
    public void SetIdentity(string name, string color)
    {
        if (placeholder is TextBlock letter) letter.Text = name.Length == 0 ? "B" : System.Globalization.StringInfo.GetNextTextElement(name);
        tile.Background = new SolidColorBrush(BellColors.Accent(color));
    }
    // The shown image becomes dataUrl (an image set from outside, such as a re-crop in the 画像 section).
    public Task ShowAsync(string dataUrl, AvatarSelection? selection) { Value = dataUrl; Selection = selection; return LoadAsync(); }
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

// Mac AvatarCropEditor: the 680x520 sheet body. 画像をドラッグして…, a 320 preview beside a 240-wide 拡大・縮小 panel. キャンセル and 使用する live in the sheet header.
public sealed class AvatarCropView : Grid
{
    private readonly BitmapSource original;
    private readonly AvatarCrop crop;
    private readonly bool wantsSelection;
    private readonly Canvas preview = new() { Width = 320, Height = 320, Background = new SolidColorBrush(Color.FromRgb(0xF2, 0xF2, 0xF7)) };
    private readonly Image image = new();
    private readonly TextBlock error = new() { TextWrapping = TextWrapping.Wrap, Foreground = Brushes.Firebrick, FontSize = 13 };
    private Point? start;
    private Point offset;
    internal Slider ZoomSlider { get; }
    public AvatarCropView(BitmapSource original, AvatarVariant variant = AvatarVariant.Small, AvatarCropRect? initialCrop = null, bool wantsSelection = false)
    {
        this.original = original; this.wantsSelection = wantsSelection;
        crop = (initialCrop is null ? null : AvatarCrop.From(original.PixelWidth, original.PixelHeight, variant.Side(), initialCrop)) ?? new(original.PixelWidth, original.PixelHeight, variant.Side());
        // The frame's corner is 0.18 of its side, as on the Mac.
        preview.Clip = new RectangleGeometry(new Rect(0, 0, 320, 320), 57.6, 57.6); preview.Children.Add(image); image.Source = original; preview.Cursor = Cursors.SizeAll;
        var muted = SettingsUi.Muted; var ink = SettingsUi.Ink;
        var column = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        column.Children.Add(new TextBlock { Text = "画像をドラッグして、使いたい部分を枠に合わせてね。", FontSize = 13, Foreground = muted, TextAlignment = TextAlignment.Center, Margin = new Thickness(0, 0, 0, 20) });
        var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        var clipped = new Border { Child = preview, Width = 320, Height = 320, CornerRadius = new CornerRadius(57.6) }; row.Children.Add(clipped);
        var controls = new StackPanel { Width = 240, Margin = new Thickness(28, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        controls.Children.Add(new TextBlock { Text = "拡大・縮小", FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = ink, Margin = new Thickness(0, 0, 0, 12) });
        var zoom = new Slider { Minimum = 1, Maximum = 3, Value = crop.Zoom }; zoom.SetResourceReference(StyleProperty, "MacSlider"); ZoomSlider = zoom;
        System.Windows.Automation.AutomationProperties.SetName(zoom, "アバター画像の拡大・縮小"); System.Windows.Automation.AutomationProperties.SetName(preview, "アバター画像の切り抜き位置");
        zoom.ValueChanged += (_, args) => { crop.SetZoom(args.NewValue); Update(); }; controls.Children.Add(zoom); controls.Children.Add(error);
        row.Children.Add(controls); column.Children.Add(row); Children.Add(column);
        SetResourceReference(BackgroundProperty, "ConversationBackground");
        preview.MouseLeftButtonDown += (_, args) => { start = args.GetPosition(preview); offset = new(crop.OffsetX, crop.OffsetY); preview.CaptureMouse(); };
        preview.MouseMove += (_, args) => { if (start is not { } first || args.LeftButton != MouseButtonState.Pressed) return; var current = args.GetPosition(preview); crop.MoveTo(offset.X + (current.X - first.X) * crop.Side / 320, offset.Y + (current.Y - first.Y) * crop.Side / 320); Update(); };
        preview.MouseLeftButtonUp += (_, _) => { start = null; preview.ReleaseMouseCapture(); }; Update();
    }
    private void Update() { image.Width = crop.RenderWidth * 320 / crop.Side; image.Height = crop.RenderHeight * 320 / crop.Side; Canvas.SetLeft(image, crop.Left * 320 / crop.Side); Canvas.SetTop(image, crop.Top * 320 / crop.Side); }
    // 使用する: the rendered image, plus the kept source and crop when asked for. A failure stays on the sheet with its reason.
    public AvatarCropOutcome? TryUse()
    {
        string render;
        try { render = Encode(original, crop); } catch (Exception) { error.Text = "写真を読み込めませんでした。"; return null; }
        if (!wantsSelection) return new(render, null);
        var source = EncodeSource(original);
        if (source is null) { error.Text = "元画像を保存できませんでした。別の画像を選んでください。"; return null; }
        return new(render, new AvatarSelection(render, source, crop.Rect));
    }
    public string ErrorText => error.Text;
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
