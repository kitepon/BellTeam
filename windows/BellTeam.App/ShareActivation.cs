using System.IO;
using BellTeam.Core;
using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.ApplicationModel.DataTransfer;
using Windows.ApplicationModel.DataTransfer.ShareTarget;
using Windows.Storage;
using Windows.Storage.Streams;

namespace BellTeam.App;

// What another app handed to BellTeam through the Windows share sheet (a283): text, links and images; anything else is counted and left out.
internal sealed record SharedData(ShareContent Content, ImageAttachment[] Images, int Skipped, ShareOperation? Operation);

// Reads the share-target activation. Only a sparse-package registration gives the process an identity to be activated with (scripts/register-windows-share-target.ps1);
// without one, GetActivatedEventArgs throws and this answers null, so a normal start is untouched.
internal static class ShareActivation
{
    private const int ImageLimit = 20 * 1024 * 1024;
    public static async Task<SharedData?> ReadAsync()
    {
        IActivatedEventArgs? activation;
        try { activation = AppInstance.GetActivatedEventArgs(); }
        catch (System.Runtime.InteropServices.COMException) { return null; }
        if (activation is not IShareTargetActivatedEventArgs share) return null;
        var operation = share.ShareOperation; var view = operation.Data;
        string? text = null; var links = new List<string>(); var images = new List<ImageAttachment>(); var skipped = 0;
        if (view.Contains(StandardDataFormats.Text)) text = await view.GetTextAsync();
        if (view.Contains(StandardDataFormats.WebLink)) links.Add((await view.GetWebLinkAsync()).AbsoluteUri);
        if (view.Contains(StandardDataFormats.StorageItems))
            foreach (var item in await view.GetStorageItemsAsync())
            {
                if (item is StorageFile file && file.ContentType is "image/png" or "image/jpeg" or "image/webp" or "image/gif" && await ReadImageAsync(file, file.Name, file.ContentType) is { } image) images.Add(image);
                else skipped++;
            }
        else if (view.Contains(StandardDataFormats.Bitmap))
        {
            using var stream = await (await view.GetBitmapAsync()).OpenReadAsync();
            if (await ReadAsync(stream) is { } bytes) images.Add(new ImageAttachment("shared.png", stream.ContentType is { Length: > 0 } type ? type : "image/png", bytes)); else skipped++;
        }
        // A link shared as text (most browsers) stays in the text; only real URLs are also offered as links.
        if (text is not null) links.AddRange(text.Split([' ', '\n', '\r', '\t'], StringSplitOptions.RemoveEmptyEntries).Where(word => word.StartsWith("http://", StringComparison.Ordinal) || word.StartsWith("https://", StringComparison.Ordinal)));
        var app = view.Properties.ApplicationName;
        return new SharedData(new ShareContent(string.IsNullOrWhiteSpace(app) ? null : app.Trim(), string.IsNullOrWhiteSpace(text) ? null : text, ShareContent.WebLinks(links)), [.. images], skipped, operation);
    }
    private static async Task<ImageAttachment?> ReadImageAsync(StorageFile file, string name, string mime)
    {
        using var stream = await file.OpenReadAsync();
        return await ReadAsync(stream) is { } bytes ? new ImageAttachment(name, mime, bytes) : null;
    }
    // null when the picture is larger than the image cap (it is then counted as left out).
    private static async Task<byte[]?> ReadAsync(IRandomAccessStreamWithContentType stream)
    {
        if (stream.Size > ImageLimit) return null;
        using var memory = new MemoryStream(); await stream.AsStreamForRead().CopyToAsync(memory); return memory.ToArray();
    }
}
