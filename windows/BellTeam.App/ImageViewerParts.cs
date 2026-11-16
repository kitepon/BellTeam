using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using BellTeam.Core;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using WinRT;

namespace BellTeam.App;

// The picture of the full-window viewer (a277): wheel or pinch zooms about the pointer, a drag or touch pans while zoomed, a double click toggles fit and 2.5x.
// The maths is ImageZoom (Core); this only reads the pointer and applies the result as a render transform.
public sealed class ZoomPane : Border
{
    private readonly ImageZoom zoom = new();
    private readonly RemoteImage image;
    private readonly ScaleTransform scale = new();
    private readonly TranslateTransform move = new();
    private Point? dragFrom;
    public bool Zoomed => zoom.Zoomed;
    public ZoomPane(RemoteImage image)
    {
        this.image = image; Child = image; ClipToBounds = true; Background = Brushes.Transparent; IsManipulationEnabled = true;
        image.RenderTransform = new TransformGroup { Children = { scale, move } }; image.RenderTransformOrigin = new Point(.5, .5);
        SizeChanged += (_, _) => Fit();
        image.LoadTask.ContinueWith(_ => Dispatcher.BeginInvoke(Fit), TaskScheduler.Default);
        MouseWheel += (_, e) => { var at = Centered(e.GetPosition(this)); zoom.ZoomAt(Math.Pow(ImageZoom.Step, e.Delta / 120.0), at.X, at.Y); Apply(); e.Handled = true; };
        MouseLeftButtonDown += (_, e) =>
        {
            if (e.ClickCount == 2) { var at = Centered(e.GetPosition(this)); zoom.Toggle(at.X, at.Y); Apply(); return; }
            if (zoom.Zoomed) { dragFrom = e.GetPosition(this); CaptureMouse(); }
        };
        MouseMove += (_, e) =>
        {
            if (dragFrom is not { } from || e.LeftButton != MouseButtonState.Pressed) return;
            var now = e.GetPosition(this); zoom.Pan(now.X - from.X, now.Y - from.Y); dragFrom = now; Apply();
        };
        MouseLeftButtonUp += (_, _) => { dragFrom = null; ReleaseMouseCapture(); };
        ManipulationStarting += (_, e) => e.ManipulationContainer = this;
        ManipulationDelta += (_, e) =>
        {
            var at = Centered(e.ManipulationOrigin); zoom.ZoomAt(e.DeltaManipulation.Scale.X, at.X, at.Y); zoom.Pan(e.DeltaManipulation.Translation.X, e.DeltaManipulation.Translation.Y); Apply(); e.Handled = true;
        };
    }
    private Point Centered(Point at) => new(at.X - ActualWidth / 2, at.Y - ActualHeight / 2);
    // Scale 1 is the picture fitted to the pane (RemoteImage stretches uniformly), so the fitted size follows from the decoded size.
    private void Fit()
    {
        if (image.Source is not BitmapSource source || ActualWidth == 0 || ActualHeight == 0 || source.Width == 0 || source.Height == 0) return;
        var k = Math.Min(ActualWidth / source.Width, ActualHeight / source.Height);
        zoom.Resize(ActualWidth, ActualHeight, source.Width * k, source.Height * k); Apply();
    }
    private void Apply() { scale.ScaleX = scale.ScaleY = zoom.Scale; move.X = zoom.X; move.Y = zoom.Y; Cursor = zoom.Zoomed ? Cursors.SizeAll : null; }
    public void ZoomBy(double factor) { zoom.ZoomAt(factor, 0, 0); Apply(); }
    public void ResetZoom() { zoom.Reset(); Apply(); }
}

// The Windows share sheet for one file (Windows.ApplicationModel.DataTransfer through the window's interop factory; works without package identity).
internal static class WindowsShare
{
    [ComImport, Guid("3A3DCD6C-3EAB-43DC-BCDE-45671CE800C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDataTransferManagerInterop
    {
        IntPtr GetForWindow(IntPtr appWindow, in Guid riid);
        void ShowShareUIForWindow(IntPtr appWindow);
    }
    private static readonly Guid DataTransferManagerId = new("a5caee9b-8708-49d1-8d36-67d25a8da00c");

    public static async Task ShowFileAsync(IntPtr window, string title, string path)
    {
        var file = await StorageFile.GetFileFromPathAsync(path);
        var interop = DataTransferManager.As<IDataTransferManagerInterop>();
        var manager = MarshalInterface<DataTransferManager>.FromAbi(interop.GetForWindow(window, DataTransferManagerId));
        void Requested(DataTransferManager sender, DataRequestedEventArgs args)
        {
            sender.DataRequested -= Requested;
            args.Request.Data.Properties.Title = title;
            args.Request.Data.SetStorageItems([file]);
        }
        manager.DataRequested += Requested;
        interop.ShowShareUIForWindow(window);
    }
}
