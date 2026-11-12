namespace BellTeam.Core;

// The OS-neutral half of reading an image file to attach: the size limit and the format check by magic bytes.
public static class ImageFile
{
    public static string Mime(byte[] bytes)
    {
        if (bytes.AsSpan().StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })) return "image/png";
        if (bytes.AsSpan().StartsWith(new byte[] { 255, 216, 255 })) return "image/jpeg";
        if (bytes.AsSpan().StartsWith("GIF87a"u8) || bytes.AsSpan().StartsWith("GIF89a"u8)) return "image/gif";
        if (bytes.Length >= 12 && bytes.AsSpan(0, 4).SequenceEqual("RIFF"u8) && bytes.AsSpan(8, 4).SequenceEqual("WEBP"u8)) return "image/webp";
        throw new InvalidDataException("PNG・JPEG・WebP・GIFの画像を選んでください。");
    }

    public static async Task<ImageAttachment> ReadAsync(string path)
    {
        if (new FileInfo(path).Length > 25 * 1024 * 1024) throw new InvalidDataException("画像1枚は25MBまでです。");
        var bytes = await File.ReadAllBytesAsync(path);
        return new(Path.GetFileName(path), Mime(bytes), bytes);
    }
}
