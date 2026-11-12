using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform.Storage;
using BellTeam.Core;

namespace BellTeam.Linux;

// Stub for the merge to drop: the avatar crop sheet belongs to the member editors group. This picker takes the middle of the chosen image
// (AvatarCrop at zoom 1, no offset) instead of opening the crop sheet; the data URL it holds is what the profile save sends.
public sealed class AvatarPicker : StackPanel
{
    private readonly Image image = new() { Stretch = Stretch.Uniform };
    private readonly TextBlock letter = new() { FontWeight = FontWeight.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap, FontSize = 12, Foreground = BellTheme.Red, HorizontalAlignment = HorizontalAlignment.Center, IsVisible = false };
    public string Value { get; private set; }
    public AvatarPicker(string value, string name = "B", string color = "violet", bool quiet = false, string changeLabel = "写真を変更")
    {
        Value = value;
        var size = quiet ? 74 : 80; image.Width = image.Height = size;
        letter.Text = name.Length == 0 ? "B" : System.Globalization.StringInfo.GetNextTextElement(name); letter.FontSize = size * .42;
        var portrait = new Grid { Width = size, Height = size, Children = { letter, image } };
        Children.Add(new Border { Child = portrait, Background = new SolidColorBrush(BellColors.Accent(color)), CornerRadius = new CornerRadius(size * .31), ClipToBounds = true, HorizontalAlignment = HorizontalAlignment.Center });
        Children.Add(status);
        var choose = new Button { Classes = { "plain" }, Content = changeLabel, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 0), Padding = new Thickness(6, 2), FontSize = 12, FontWeight = FontWeight.Normal, Foreground = BellTheme.Violet, Background = Brushes.Transparent };
        choose.Click += async (_, _) => await ChooseAsync(); Children.Add(choose);
        if (!quiet) return;
        var remove = new Button { Classes = { "plain" }, Content = "写真を取り外す", HorizontalAlignment = HorizontalAlignment.Center, Padding = new Thickness(6, 1), FontSize = 12, FontWeight = FontWeight.Normal, Foreground = BellTheme.Muted, Background = Brushes.Transparent };
        remove.Click += (_, _) => { Value = ""; image.Source = null; letter.IsVisible = true; Say("保存すると写真を取り外します。"); };
        Children.Add(remove);
    }
    private void Say(string text) { status.Text = text; status.IsVisible = text.Length != 0; }
    private async Task ChooseAsync()
    {
        if (TopLevel.GetTopLevel(this) is not { } top) return;
        var files = await top.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions { Title = "写真を選ぶ", FileTypeFilter = [new FilePickerFileType("画像") { Patterns = ["*.png", "*.jpg", "*.jpeg", "*.webp", "*.gif"] }] });
        if (files.Count == 0 || files[0].TryGetLocalPath() is not { } path) return;
        try
        {
            var (_, preview) = await AvaloniaImageCodec.Instance.ReadAsync(path);
            Value = Encode(preview); await LoadAsync(); Say("");
        }
        catch (Exception error) { Say(EditorText.ImageUnreadable + error.Message); }
    }
    private static string Encode(Bitmap source)
    {
        var crop = new AvatarCrop(source.PixelSize.Width, source.PixelSize.Height); var side = (int)crop.Side;
        using var target = new RenderTargetBitmap(new PixelSize(side, side), new Vector(96, 96));
        using (var context = target.CreateDrawingContext())
        {
            context.DrawRectangle(Brushes.White, null, new Rect(0, 0, side, side));
            context.DrawImage(source, new Rect(source.Size), new Rect(crop.Left, crop.Top, crop.RenderWidth, crop.RenderHeight));
        }
        using var stream = new MemoryStream(); target.Save(stream, new PngBitmapEncoderOptions());
        return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
    }
    public async Task LoadAsync()
    {
        var requested = Value;
        if (requested.Length == 0) { image.Source = null; letter.IsVisible = true; return; }
        try
        {
            var comma = requested.IndexOf(','); if (comma < 0 || !requested.StartsWith("data:image/", StringComparison.Ordinal)) throw new InvalidDataException("アバターの形式が一致しません。");
            var bitmap = await AvaloniaImageCodec.Instance.DecodeAsync(Convert.FromBase64String(requested[(comma + 1)..]));
            if (Value == requested) { image.Source = bitmap; letter.IsVisible = false; Say(""); }
        }
        catch (Exception error) { if (Value == requested) Say("画像を読み込めませんでした。" + error.Message); }
    }
}
