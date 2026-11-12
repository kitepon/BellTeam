using System.IO;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using BellTeam.Core;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace BellTeam.App;

public static class ImageCodec
{
    public static Task<BitmapSource> DecodeAsync(byte[] bytes) => DecodeAsync(bytes, null);
    public static async Task<BitmapSource> DecodeAsync(byte[] bytes, int? maximumDimension)
    {
        using var stream = new InMemoryRandomAccessStream();
        using (var writer = new DataWriter(stream)) { writer.WriteBytes(bytes); await writer.StoreAsync(); writer.DetachStream(); }
        stream.Seek(0);
        var decoder = await Windows.Graphics.Imaging.BitmapDecoder.CreateAsync(stream);
        var transform = new BitmapTransform();
        if (maximumDimension is { } limit)
        {
            var scale = Math.Min(1, (double)limit / Math.Max(decoder.PixelWidth, decoder.PixelHeight));
            transform.ScaledWidth = (uint)Math.Max(1, decoder.PixelWidth * scale); transform.ScaledHeight = (uint)Math.Max(1, decoder.PixelHeight * scale);
        }
        using var bitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied, transform, ExifOrientationMode.RespectExifOrientation, ColorManagementMode.ColorManageToSRgb);
        var pixels = new byte[checked(bitmap.PixelWidth * bitmap.PixelHeight * 4)]; var buffer = new Windows.Storage.Streams.Buffer((uint)pixels.Length); bitmap.CopyToBuffer(buffer);
        using (var reader = DataReader.FromBuffer(buffer)) reader.ReadBytes(pixels);
        var image = BitmapSource.Create(bitmap.PixelWidth, bitmap.PixelHeight, 96, 96, PixelFormats.Pbgra32, null, pixels, checked(bitmap.PixelWidth * 4));
        image.Freeze();
        return image;
    }

    public static string Mime(byte[] bytes) => ImageFile.Mime(bytes);
    public static async Task<(ImageAttachment Data, BitmapSource Preview)> ReadAsync(string path)
    {
        var data = await ImageFile.ReadAsync(path);
        return (data, await DecodeAsync(data.Bytes));
    }
    public static byte[] Png(BitmapSource image)
    {
        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(image));
        using var stream = new MemoryStream(); encoder.Save(stream); return stream.ToArray();
    }
}

// Workspace's image work on WPF: frozen BitmapSource previews.
public sealed class WpfImageCodec : IImageCodec<BitmapSource>
{
    public static readonly WpfImageCodec Instance = new();
    public Task<BitmapSource> DecodeAsync(byte[] bytes) => ImageCodec.DecodeAsync(bytes);
    public Task<(ImageAttachment Data, BitmapSource Preview)> ReadAsync(string path) => ImageCodec.ReadAsync(path);
    public (byte[] Png, BitmapSource Preview) Pasted(BitmapSource image) { var preview = image.Clone(); preview.Freeze(); return (ImageCodec.Png(image), preview); }
}
