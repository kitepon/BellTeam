using System.IO;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using BellTeam.Core;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace BellTeam.App;

public static class ImageCodec
{
    public static async Task<BitmapSource> DecodeAsync(byte[] bytes)
    {
        using var stream = new InMemoryRandomAccessStream();
        using (var writer = new DataWriter(stream)) { writer.WriteBytes(bytes); await writer.StoreAsync(); writer.DetachStream(); }
        stream.Seek(0);
        var decoder = await Windows.Graphics.Imaging.BitmapDecoder.CreateAsync(stream);
        var pixels = (await decoder.GetPixelDataAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied, new BitmapTransform(), ExifOrientationMode.RespectExifOrientation, ColorManagementMode.ColorManageToSRgb)).DetachPixelData();
        var image = BitmapSource.Create((int)decoder.OrientedPixelWidth, (int)decoder.OrientedPixelHeight, 96, 96, PixelFormats.Pbgra32, null, pixels, checked((int)decoder.OrientedPixelWidth * 4));
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
