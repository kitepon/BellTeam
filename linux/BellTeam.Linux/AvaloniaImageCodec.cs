using Avalonia.Media.Imaging;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

// Workspace's image work on Avalonia: decoded Bitmaps, PNG bytes for a pasted image.
public sealed class AvaloniaImageCodec : IImageCodec<Bitmap>
{
    public static readonly AvaloniaImageCodec Instance = new();
    public Task<Bitmap> DecodeAsync(byte[] bytes) => Task.Run(() => { using var stream = new MemoryStream(bytes); return new Bitmap(stream); });
    public async Task<(ImageAttachment Data, Bitmap Preview)> ReadAsync(string path)
    {
        var data = await ImageFile.ReadAsync(path);
        return (data, await DecodeAsync(data.Bytes));
    }
    // The pasted bitmap is ours alone, so it stays valid as the draft's preview after the clipboard changes.
    public (byte[] Png, Bitmap Preview) Pasted(Bitmap image) { using var stream = new MemoryStream(); image.Save(stream, new PngBitmapEncoderOptions()); return (stream.ToArray(), image); }
}

// The shared Workspace (BellTeam.Core) with Avalonia images. The Background post runs after the layout and Loaded jobs
// of the first page's cards, which read Opening when they load.
public sealed class LinuxWorkspace(Func<Uri, BellApi>? apiFactory = null, Func<Uri, Task>? prepareConnection = null, Func<int, CancellationToken, Task>? retryDelay = null)
    : Workspace<Bitmap>(AvaloniaImageCodec.Instance, action => Dispatcher.UIThread.Post(action, DispatcherPriority.Background), apiFactory, prepareConnection, retryDelay);
