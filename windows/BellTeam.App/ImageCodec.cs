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

    public static string Mime(byte[] bytes)
    {
        if (bytes.AsSpan().StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })) return "image/png";
        if (bytes.AsSpan().StartsWith(new byte[] { 255, 216, 255 })) return "image/jpeg";
        if (bytes.AsSpan().StartsWith("GIF87a"u8) || bytes.AsSpan().StartsWith("GIF89a"u8)) return "image/gif";
        if (bytes.Length >= 12 && bytes.AsSpan(0, 4).SequenceEqual("RIFF"u8) && bytes.AsSpan(8, 4).SequenceEqual("WEBP"u8)) return "image/webp";
        throw new InvalidDataException("PNG・JPEG・WebP・GIFの画像を選んでください。");
    }
    public static async Task<(ImageAttachment Data, BitmapSource Preview)> ReadAsync(string path)
    {
        if (new FileInfo(path).Length > 25 * 1024 * 1024) throw new InvalidDataException("画像1枚は25MBまでです。");
        var bytes = await File.ReadAllBytesAsync(path);
        var mime = Mime(bytes);
        return (new(Path.GetFileName(path), mime, bytes), await DecodeAsync(bytes));
    }
    public static byte[] Png(BitmapSource image)
    {
        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(image));
        using var stream = new MemoryStream(); encoder.Save(stream); return stream.ToArray();
    }
}
