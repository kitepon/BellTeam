using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Input.GestureRecognizers;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform.Storage;
using BellTeam.Core;

namespace BellTeam.Linux;

// The viewer's zoom model. The picture is laid out to fit the pane (Stretch.Uniform); Scale is relative to that fit (1 = whole picture
// visible, Max = 8x) and Offset moves the scaled picture from the pane centre, kept so the picture always covers the pane edge it overflows.
public readonly record struct ZoomView(double Scale, Vector Offset)
{
    public const double Max = 8;
    public static readonly ZoomView Fit = new(1, default);

    // The size the picture takes at Scale 1 inside the pane.
    public static Size Displayed(Size pane, PixelSize image)
    {
        if (image.Width == 0 || image.Height == 0) return default;
        var fit = Math.Min(pane.Width / image.Width, pane.Height / image.Height);
        return new Size(image.Width * fit, image.Height * fit);
    }

    private static Vector Clamp(Vector offset, double scale, Size displayed, Size pane)
    {
        var x = Math.Max(0, (displayed.Width * scale - pane.Width) / 2); var y = Math.Max(0, (displayed.Height * scale - pane.Height) / 2);
        return new Vector(Math.Clamp(offset.X, -x, x), Math.Clamp(offset.Y, -y, y));
    }

    // Zoom by a factor while the point under `anchor` (relative to the pane centre) stays under the pointer.
    public ZoomView ZoomAt(double factor, Point anchor, Size displayed, Size pane)
    {
        var scale = Math.Clamp(Scale * factor, 1, Max);
        if (scale == 1) return Fit;
        var ratio = scale / Scale; var from = new Vector(anchor.X, anchor.Y);
        return new(scale, Clamp(from - (from - Offset) * ratio, scale, displayed, pane));
    }

    public ZoomView Pan(Vector delta, Size displayed, Size pane) => Scale == 1 ? this : this with { Offset = Clamp(Offset + delta, Scale, displayed, pane) };

    // The scale at which one picture pixel is one screen pixel (at least 2 so a small picture still zooms).
    public static double ActualSize(Size displayed, PixelSize image) => displayed.Width == 0 ? 1 : Math.Clamp(Math.Max(2, image.Width / displayed.Width), 1, Max);
}

// One picture of the gallery: wheel and pinch zoom, drag to pan, double click between fit and actual size.
public sealed class ZoomPane : Border
{
    private readonly RemoteImage image;
    private readonly ScaleTransform scale = new(); private readonly TranslateTransform move = new();
    private ZoomView view = ZoomView.Fit;
    private Point? dragFrom;
    private double? pinchStart; // the Scale when the running pinch began (a pinch reports its scale since its start)
    public ZoomPane(LinuxWorkspace workspace, string path)
    {
        image = new RemoteImage(workspace, path); Background = Brushes.Transparent; ClipToBounds = true; Child = image;
        image.RenderTransformOrigin = RelativePoint.Center; image.RenderTransform = new TransformGroup { Children = { scale, move } };
        GestureRecognizers.Add(new PinchGestureRecognizer());
        Pinch += (_, e) => { pinchStart ??= view.Scale; Apply(view.ZoomAt(pinchStart.Value * e.Scale / view.Scale, Anchor(e.ScaleOrigin), Displayed, Bounds.Size)); e.Handled = true; };
        PinchEnded += (_, _) => pinchStart = null;
        DoubleTapped += (_, e) => { var target = view.Scale > 1 ? 1 : ZoomView.ActualSize(Displayed, Pixels); Apply(view.ZoomAt(target / view.Scale, Anchor(e.GetPosition(this)), Displayed, Bounds.Size)); };
    }
    public RemoteImage Image => image;
    public ZoomView View => view;
    private PixelSize Pixels => image.Bitmap?.PixelSize ?? default;
    private Size Displayed => ZoomView.Displayed(Bounds.Size, Pixels);
    private Point Anchor(Point inside) => new(inside.X - Bounds.Width / 2, inside.Y - Bounds.Height / 2);
    private void Apply(ZoomView next) { view = next; scale.ScaleX = scale.ScaleY = next.Scale; move.X = next.Offset.X; move.Y = next.Offset.Y; }
    public void ZoomBy(double factor) => Apply(view.ZoomAt(factor, default, Displayed, Bounds.Size));
    public void Reset() => Apply(ZoomView.Fit);
    protected override void OnPointerWheelChanged(PointerWheelEventArgs e)
    {
        base.OnPointerWheelChanged(e);
        Apply(view.ZoomAt(Math.Pow(1.2, e.Delta.Y), Anchor(e.GetPosition(this)), Displayed, Bounds.Size)); e.Handled = true;
    }
    protected override void OnPointerPressed(PointerPressedEventArgs e)
    {
        base.OnPointerPressed(e);
        if (view.Scale > 1 && e.GetCurrentPoint(this).Properties.IsLeftButtonPressed) { dragFrom = e.GetPosition(this); e.Pointer.Capture(this); Cursor = new Cursor(StandardCursorType.SizeAll); }
    }
    protected override void OnPointerMoved(PointerEventArgs e)
    {
        base.OnPointerMoved(e);
        if (dragFrom is not { } from) return;
        var at = e.GetPosition(this); Apply(view.Pan(at - from, Displayed, Bounds.Size)); dragFrom = at;
    }
    protected override void OnPointerReleased(PointerReleasedEventArgs e) { base.OnPointerReleased(e); dragFrom = null; e.Pointer.Capture(null); Cursor = null; }
}

// What the viewer does with the picture's original bytes. Linux has no share sheet: 共有 = ほかのアプリで開く + コピー (told to the Owner).
public static class ImageActions
{
    // The saved name is the URL's last segment (contract a274); the extension always matches the bytes' type.
    public static string FileName(string path, byte[] bytes)
    {
        var last = path.Split('?')[0].Split('/').LastOrDefault() ?? "";
        var name = Path.GetFileName(Uri.UnescapeDataString(last)).Trim();
        var extension = ImageFile.Mime(bytes) switch { "image/jpeg" => ".jpg", "image/png" => ".png", "image/webp" => ".webp", "image/gif" => ".gif", _ => "" };
        if (name.Length == 0) name = "image";
        return extension.Length == 0 || Path.GetExtension(name).Equals(extension, StringComparison.OrdinalIgnoreCase) ? name : Path.GetFileNameWithoutExtension(name) + extension;
    }

    // Returns the saved file's name, or null when the Owner cancelled the dialog.
    public static async Task<string?> SaveAsync(TopLevel top, string name, byte[] bytes)
    {
        var extension = Path.GetExtension(name).TrimStart('.');
        var file = await top.StorageProvider.SaveFilePickerAsync(new FilePickerSaveOptions
        {
            Title = LinuxStrings.ImageViewer_SaveAsync_1, SuggestedFileName = name, DefaultExtension = extension, ShowOverwritePrompt = true,
            FileTypeChoices = [new FilePickerFileType(LinuxStrings.AvatarEditor_Images_1) { Patterns = [$"*.{extension}"] }]
        });
        if (file is null) return null;
        await using var stream = await file.OpenWriteAsync(); await stream.WriteAsync(bytes); await stream.FlushAsync();
        return file.Name;
    }

    // The default app for the type opens a copy under the temp folder. The Owner reads plain words and the next step; the opener's name and exit code go to the log only.
    public static async Task OpenWithAsync(string name, byte[] bytes, Func<string, Task<int>>? open = null)
    {
        var folder = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "bellteam-images")).FullName;
        var file = Path.Combine(folder, name); await File.WriteAllBytesAsync(file, bytes);
        int code;
        try { code = await (open ?? XdgOpen)(file); }
        catch (System.ComponentModel.Win32Exception error) { Console.Error.WriteLine(LinuxStrings.ImageViewer_OpenWithAsync_1(error.Message)); code = 127; }
        if (code == 0) return;
        Console.Error.WriteLine(LinuxStrings.ImageViewer_OpenWithAsync_2(code, file));
        throw new InvalidOperationException(code is 3 or 127 ? OpenWithMissing : OpenWithFailed);
    }
    public static string OpenWithMissing  => LinuxStrings.ImageViewer_OpenWithMissing_1;
    public static string OpenWithFailed  => LinuxStrings.ImageViewer_OpenWithFailed_1;
    private static async Task<int> XdgOpen(string file)
    {
        var info = new ProcessStartInfo("xdg-open") { UseShellExecute = false }; info.ArgumentList.Add(file);
        using var process = Process.Start(info) ?? throw new InvalidOperationException(OpenWithFailed);
        await process.WaitForExitAsync(); return process.ExitCode;
    }

    public static async Task CopyAsync(TopLevel top, Bitmap bitmap)
    {
        var clipboard = top.Clipboard ?? throw new InvalidOperationException(LinuxStrings.ImageViewer_CopyAsync_1);
        var item = new DataTransferItem(); item.SetBitmap(bitmap);
        var transfer = new DataTransfer(); transfer.Add(item);
        await clipboard.SetDataAsync(transfer);
    }
}
