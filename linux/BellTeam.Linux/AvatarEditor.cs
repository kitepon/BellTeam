using System.Globalization;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Shapes;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform.Storage;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// What the crop sheet hands back: the rendered image and, when the caller asked for one, the kept source and crop rectangle.
public sealed record AvatarCropOutcome(string DataUrl, AvatarSelection? Selection);

internal static class AvatarHost
{
    public static readonly FilePickerFileType Images = new("画像") { Patterns = ["*.png", "*.jpg", "*.jpeg", "*.webp", "*.gif"] };
    // The window that shows sheets (the crop sheet among them), found through the tree so an editor not yet shown still resolves it.
    public static IInspectorHost? Of(Visual element)
    {
        for (Visual? current = element; current is not null; current = current.GetVisualParent()) if (current is IInspectorHost host) return host;
        return null;
    }
    public static async Task<Bitmap> DecodeAsync(string dataUrl)
    {
        var comma = dataUrl.IndexOf(',');
        if (comma < 0 || !dataUrl.StartsWith("data:image/", StringComparison.Ordinal)) throw new InvalidDataException("アバターの形式が一致しません。");
        return await AvaloniaImageCodec.Instance.DecodeAsync(Convert.FromBase64String(dataUrl[(comma + 1)..]));
    }
    // One image file picked in the owner window; null when the picker was cancelled.
    public static async Task<string?> PickImageAsync(Window? owner, string title)
    {
        if (owner is null) return null;
        var files = await owner.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions { Title = title, AllowMultiple = false, FileTypeFilter = [Images] });
        return files.Count == 0 ? null : files[0].TryGetLocalPath();
    }
}

// A portrait with its change link. quiet: the Mac settings look (74pt portrait, 写真を変更 and 写真を取り外す). Otherwise the Mac Form row look:
// an 80pt portrait with one small link under it, which opens the crop sheet.
public sealed class AvatarPicker : StackPanel
{
    private readonly Image image = new() { Stretch = Stretch.UniformToFill };
    internal Image Preview => image;
    private readonly Control placeholder;
    private readonly Border tile;
    private readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap, FontSize = 14, IsVisible = false };
    private readonly Func<byte[], Task<Bitmap>> decode;
    private readonly AvatarVariant variant;
    private readonly bool keepSelection;
    internal Button ChooseButton { get; }
    public string Value { get; private set; }
    // Set only when the picker keeps the source and crop (a new member's 小画像): what the create sends beside the rendered image.
    public AvatarSelection? Selection { get; private set; }
    public event Action<AvatarCropOutcome>? Chosen;
    public AvatarPicker(string value, Func<byte[], Task<Bitmap>>? decode = null, string name = "B", string color = "violet", bool isRoom = false, bool quiet = false, string changeLabel = "写真を変更", bool keepSelection = false, AvatarVariant variant = AvatarVariant.Small)
    {
        var size = quiet ? 74 : 80;
        this.decode = decode ?? AvaloniaImageCodec.Instance.DecodeAsync; this.variant = variant; this.keepSelection = keepSelection;
        Value = value;
        placeholder = isRoom ? new Avalonia.Controls.Shapes.Path { Data = AvatarTile.RoomSymbol, Fill = Brushes.White, Stretch = Stretch.Uniform, Width = 50, Height = 50, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center }
            : new TextBlock { Text = name.Length == 0 ? "B" : StringInfo.GetNextTextElement(name), FontSize = 34, FontWeight = FontWeight.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        tile = new Border { Width = size, Height = size, Child = new Grid { Children = { placeholder, image } }, Background = new SolidColorBrush(BellColors.Accent(color)), CornerRadius = new CornerRadius(size * .31), ClipToBounds = true, HorizontalAlignment = HorizontalAlignment.Center };
        Children.Add(tile); Children.Add(status);
        var choose = new Button { Classes = { "plain" }, Content = changeLabel, HorizontalAlignment = HorizontalAlignment.Center, Background = Brushes.Transparent, Foreground = BellTheme.Violet, FontSize = 12, FontWeight = FontWeight.Normal, Padding = new Thickness(6, 2), Margin = new Thickness(0, 6, 0, 0) };
        AutomationProperties.SetName(choose, changeLabel);
        choose.Click += async (_, _) => await ChooseAsync();
        ChooseButton = choose;
        Children.Add(choose);
        if (!quiet) { status.FontSize = 12; status.Foreground = Brushes.Firebrick; status.HorizontalAlignment = HorizontalAlignment.Center; return; }
        var remove = new Button { Classes = { "plain" }, Content = "写真を取り外す", HorizontalAlignment = HorizontalAlignment.Center, Background = Brushes.Transparent, Foreground = Brushes.SlateGray, FontSize = 12, FontWeight = FontWeight.Normal, Padding = new Thickness(6, 1), Margin = new Thickness(0, 0, 0, 2) };
        AutomationProperties.SetName(remove, "写真を取り外す");
        remove.Click += (_, _) => { Value = ""; Selection = null; image.Source = null; placeholder.IsVisible = true; status.Text = "保存すると写真を取り外します。"; status.IsVisible = true; };
        Children.Add(remove);
    }
    private async Task ChooseAsync()
    {
        var host = AvatarHost.Of(this);
        var path = await AvatarHost.PickImageAsync(host?.OwnerWindow, "画像を選ぶ");
        if (path is null) return;
        try
        {
            var loaded = await AvaloniaImageCodec.Instance.ReadAsync(path);
            var outcome = await (host ?? throw new InvalidOperationException("画像の調整画面を開けません。")).CropAsync(loaded.Preview, variant, null, keepSelection);
            if (outcome is null) return;
            Value = outcome.DataUrl; Selection = outcome.Selection; await LoadAsync(); Chosen?.Invoke(outcome);
        }
        catch (Exception error) { ShowStatus(EditorText.ImageUnreadable + error.Message); }
    }
    private void ShowStatus(string text) { status.Text = text; status.IsVisible = text.Length != 0; }
    // The initial and the tile colour follow the name and theme colour being typed, as the Mac AvatarView does.
    public void SetIdentity(string name, string color)
    {
        if (placeholder is TextBlock letter) letter.Text = name.Length == 0 ? "B" : StringInfo.GetNextTextElement(name);
        tile.Background = new SolidColorBrush(BellColors.Accent(color));
    }
    // The shown image becomes dataUrl (an image set from outside, such as a re-crop in the 画像 section).
    public Task ShowAsync(string dataUrl, AvatarSelection? selection) { Value = dataUrl; Selection = selection; return LoadAsync(); }
    public async Task LoadAsync()
    {
        var requested = Value;
        if (requested.Length == 0) { image.Source = null; placeholder.IsVisible = true; return; }
        try
        {
            var comma = requested.IndexOf(','); if (comma < 0 || !requested.StartsWith("data:image/", StringComparison.Ordinal)) throw new InvalidDataException("アバターの形式が一致しません。");
            var bitmap = await decode(Convert.FromBase64String(requested[(comma + 1)..]));
            if (Value == requested) { image.Source = bitmap; placeholder.IsVisible = false; ShowStatus(""); }
        }
        catch (Exception error) { if (Value == requested) ShowStatus("画像を読み込めませんでした。" + error.Message); }
    }
}

// Mac AvatarCropEditor: the 680x520 sheet body. 画像をドラッグして…, a 320 preview beside a 240-wide 拡大・縮小 panel. キャンセル and 使用する live in the sheet header.
public sealed class AvatarCropView : Grid
{
    private readonly Bitmap original;
    private readonly AvatarCrop crop;
    private readonly bool wantsSelection;
    private readonly Canvas preview = new() { Width = 320, Height = 320, Background = new SolidColorBrush(Color.FromRgb(0xF2, 0xF2, 0xF7)), Cursor = new Cursor(StandardCursorType.SizeAll) };
    private readonly Image image = new() { Stretch = Stretch.Fill };
    private readonly TextBlock error = new() { TextWrapping = TextWrapping.Wrap, Foreground = Brushes.Firebrick, FontSize = 13 };
    private Point? start;
    private Point offset;
    internal Slider ZoomSlider { get; }
    public AvatarCropView(Bitmap original, AvatarVariant variant = AvatarVariant.Small, AvatarCropRect? initialCrop = null, bool wantsSelection = false)
    {
        this.original = original; this.wantsSelection = wantsSelection;
        crop = (initialCrop is null ? null : AvatarCrop.From(original.PixelSize.Width, original.PixelSize.Height, variant.Side(), initialCrop)) ?? new(original.PixelSize.Width, original.PixelSize.Height, variant.Side());
        image.Source = original; preview.Children.Add(image);
        Background = BellTheme.ConversationBackground;
        var column = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        column.Children.Add(new TextBlock { Text = "画像をドラッグして、使いたい部分を枠に合わせてね。", FontSize = 13, Foreground = FormUi.Muted, TextAlignment = TextAlignment.Center, Margin = new Thickness(0, 0, 0, 20) });
        var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        // The frame's corner is 0.18 of its side, as on the Mac.
        row.Children.Add(new Border { Child = preview, Width = 320, Height = 320, CornerRadius = new CornerRadius(57.6), ClipToBounds = true });
        var controls = new StackPanel { Width = 240, Margin = new Thickness(28, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        controls.Children.Add(new TextBlock { Text = "拡大・縮小", FontSize = 13, FontWeight = FontWeight.SemiBold, Foreground = FormUi.Ink, Margin = new Thickness(0, 0, 0, 12) });
        var zoom = FormUi.Violetize(new Slider { Minimum = 1, Maximum = 3, Value = crop.Zoom }); ZoomSlider = zoom;
        AutomationProperties.SetName(zoom, "アバター画像の拡大・縮小"); AutomationProperties.SetName(preview, "アバター画像の切り抜き位置");
        zoom.ValueChanged += (_, args) => { crop.SetZoom(args.NewValue); Update(); }; controls.Children.Add(zoom); controls.Children.Add(error);
        row.Children.Add(controls); column.Children.Add(row); Children.Add(column);
        preview.PointerPressed += (_, args) => { if (!args.GetCurrentPoint(preview).Properties.IsLeftButtonPressed) return; start = args.GetPosition(preview); offset = new(crop.OffsetX, crop.OffsetY); args.Pointer.Capture(preview); };
        preview.PointerMoved += (_, args) => { if (start is not { } first || !args.GetCurrentPoint(preview).Properties.IsLeftButtonPressed) return; var current = args.GetPosition(preview); crop.MoveTo(offset.X + (current.X - first.X) * crop.Side / 320, offset.Y + (current.Y - first.Y) * crop.Side / 320); Update(); };
        preview.PointerReleased += (_, args) => { start = null; args.Pointer.Capture(null); };
        Update();
    }
    private void Update() { image.Width = crop.RenderWidth * 320 / crop.Side; image.Height = crop.RenderHeight * 320 / crop.Side; Canvas.SetLeft(image, crop.Left * 320 / crop.Side); Canvas.SetTop(image, crop.Top * 320 / crop.Side); }
    // 使用する: the rendered image, plus the kept source and crop when asked for. A failure stays on the sheet with its reason.
    public AvatarCropOutcome? TryUse()
    {
        string render;
        try { render = Encode(original, crop); } catch (Exception) { error.Text = "写真を読み込めませんでした。"; return null; }
        if (!wantsSelection) return new(render, null);
        string? source;
        try { source = EncodeSource(original); } catch (Exception) { source = null; }
        if (source is null) { error.Text = "元画像を保存できませんでした。別の画像を選んでください。"; return null; }
        return new(render, new AvatarSelection(render, source, crop.Rect));
    }
    public string ErrorText => error.Text ?? "";
    public static string Encode(Bitmap source, AvatarCrop crop)
    {
        var side = (int)crop.Side;
        var canvas = new Canvas { Width = side, Height = side, Background = Brushes.White, ClipToBounds = true };
        var picture = new Image { Source = source, Stretch = Stretch.Fill, Width = crop.RenderWidth, Height = crop.RenderHeight };
        Canvas.SetLeft(picture, crop.Left); Canvas.SetTop(picture, crop.Top); canvas.Children.Add(picture);
        return "data:image/jpeg;base64," + Convert.ToBase64String(Jpeg(canvas, side, side, 90));
    }
    // Mac AvatarImage.sourceDataURL: the chosen image kept for later re-cropping, at most 1600 px on a side, JPEG 0.8, null when over 3,000,000 characters.
    public static string? EncodeSource(Bitmap source)
    {
        var ratio = Math.Min(1, 1600.0 / Math.Max(source.PixelSize.Width, source.PixelSize.Height));
        var width = (int)Math.Max(1, Math.Round(source.PixelSize.Width * ratio)); var height = (int)Math.Max(1, Math.Round(source.PixelSize.Height * ratio));
        var canvas = new Canvas { Width = width, Height = height, Background = Brushes.White };
        canvas.Children.Add(new Image { Source = source, Stretch = Stretch.Fill, Width = width, Height = height });
        var value = "data:image/jpeg;base64," + Convert.ToBase64String(Jpeg(canvas, width, height, 80));
        return value.Length <= 3_000_000 ? value : null;
    }
    // A visual drawn at its own pixel size, so the result does not depend on the screen's scale.
    private static byte[] Jpeg(Control visual, int width, int height, int quality)
    {
        visual.Measure(new Size(width, height)); visual.Arrange(new Rect(0, 0, width, height));
        using var target = new RenderTargetBitmap(new PixelSize(width, height), new Vector(96, 96)); target.Render(visual);
        using var stream = new MemoryStream(); target.Save(stream, new JpegBitmapEncoderOptions { Quality = quality });
        return stream.ToArray();
    }
}
