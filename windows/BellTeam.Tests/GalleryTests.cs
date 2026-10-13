using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;
public sealed class GalleryTests
{
    [Theory]
    [InlineData(800,400,128,64)] [InlineData(400,800,64,128)] [InlineData(800,800,128,128)] [InlineData(32,16,32,16)]
    public async Task ThumbnailIsBoundedWithoutEnlargingSmallImages(int width,int height,int expectedWidth,int expectedHeight)
    {
        var bitmap = await ImageCodec.DecodeAsync(Picture(width,height),128);
        Assert.Equal(expectedWidth,bitmap.PixelWidth); Assert.Equal(expectedHeight,bitmap.PixelHeight); Assert.True(bitmap.IsFrozen);
    }
    [Fact]
    public async Task ThumbnailRespectsJpegExifRotation()
    {
        var source = BitmapSource.Create(800,400,96,96,PixelFormats.Bgra32,null,new byte[800*400*4],800*4);
        var metadata = new BitmapMetadata("jpg"); metadata.SetQuery("/app1/ifd/{ushort=274}",(ushort)6);
        var encoder = new JpegBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(source,null,metadata,null)); using var stream=new MemoryStream(); encoder.Save(stream);
        var bitmap=await ImageCodec.DecodeAsync(stream.ToArray(),128); Assert.Equal(64,bitmap.PixelWidth); Assert.Equal(128,bitmap.PixelHeight);
    }
    [Fact]
    public void ThumbnailButtonsAndArrowKeysSwitchPicturesAndEscapeClosesWithoutShowingWindow() => Sta(() =>
    {
        using var workspace=CreateWorkspace();
        using var source=new HwndSource(new HwndSourceParameters("非表示の画像キー試験") { Width=1,Height=1,WindowStyle=unchecked((int)0x80000000),ExtendedWindowStyle=0x08000000 });
        var gallery=new ImageGallery(workspace,["/one.png","/two.png"],0); Layout(gallery); Await(gallery.ReadyTask);
        Assert.False(IsWindowVisible(source.Handle)); Assert.Equal(800,MainImage(gallery).PixelWidth);
        var thumbnails=Find<Button>(gallery).Where(button=>System.Windows.Automation.AutomationProperties.GetName(button).StartsWith("画像")).ToArray();
        Assert.Equal(2,thumbnails.Length); Assert.Contains(Find<TextBlock>(gallery),text=>text.Text=="1 / 2");
        Assert.All(thumbnails,button=> { var image=Assert.IsType<RemoteImage>(button.Content).Children.OfType<Image>().Single(); Assert.True(Assert.IsAssignableFrom<BitmapSource>(image.Source).PixelWidth<=128); });
        thumbnails[1].RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Await(gallery.ReadyTask); Assert.Contains(Find<TextBlock>(gallery),text=>text.Text=="2 / 2"); Assert.Equal(1,thumbnails[1].Opacity); Assert.Equal(400,MainImage(gallery).PixelWidth);
        Press(gallery,source,Key.Right); Await(gallery.ReadyTask); Assert.Contains(Find<TextBlock>(gallery),text=>text.Text=="1 / 2"); Assert.Equal(800,MainImage(gallery).PixelWidth);
        Press(gallery,source,Key.Left); Await(gallery.ReadyTask); Assert.Contains(Find<TextBlock>(gallery),text=>text.Text=="2 / 2");
        Assert.Equal(IntPtr.Zero,new WindowInteropHelper(gallery).Handle); var closed=false; gallery.Closed+=(_,_)=>closed=true; Press(gallery,source,Key.Escape); Assert.True(closed);
    });
    [Fact]
    public void OneImageHasNoNavigationStripAndStillClosesWithEscape() => Sta(() =>
    {
        using var workspace=CreateWorkspace(); using var source=new HwndSource(new HwndSourceParameters("非表示の単画像キー試験") { Width=1,Height=1,WindowStyle=unchecked((int)0x80000000),ExtendedWindowStyle=0x08000000 });
        var gallery=new ImageGallery(workspace,["/one.png"],0); Layout(gallery); Await(gallery.ReadyTask);
        Assert.False(IsWindowVisible(source.Handle));
        Assert.DoesNotContain(Find<Button>(gallery),button=>button.Content as string is "前の画像" or "次の画像"); Press(gallery,source,Key.Right); Assert.Contains(Find<TextBlock>(gallery),text=>text.Text=="1 / 1");
        var closed=false; gallery.Closed+=(_,_)=>closed=true; Press(gallery,source,Key.Escape); Assert.True(closed);
    });
    private static Workspace CreateWorkspace()
    {
        var picture=Picture(800,400); var second=Picture(400,800);
        var workspace=new Workspace(origin=>new BellApi(origin,new StubHandler((request,_)=>
        {
            if (request.RequestUri!.AbsolutePath.EndsWith(".png")) { var response=new HttpResponseMessage(HttpStatusCode.OK) { Content=new ByteArrayContent(request.RequestUri.AbsolutePath=="/one.png"?picture:second) }; response.Content.Headers.ContentType=new("image/png"); return Task.FromResult(response); }
            return Task.FromResult(StubHandler.Json(request.RequestUri.AbsolutePath switch { "/api/session"=>"""{"authenticated":true,"authMode":"local"}""", "/api/bots"=>ApiTests.Bots, "/api/rooms"=>ApiTests.Rooms, "/api/queue"=>ApiTests.EmptyQueue, "/api/owner"=>ApiTests.Owner, _=>ApiTests.Page }));
        })));
        Await(workspace.ConnectAsync("http://localhost",listen:false)); return workspace;
    }
    private static byte[] Picture(int width,int height) => ImageCodec.Png(BitmapSource.Create(width,height,96,96,PixelFormats.Bgra32,null,new byte[checked(width*height*4)],width*4));
    private static BitmapSource MainImage(Window gallery) => (BitmapSource)Assert.IsType<RemoteImage>(Find<ContentControl>(gallery).Single(control=>control.GetType()==typeof(ContentControl)).Content).Children.OfType<Image>().Single().Source;
    [DllImport("user32.dll")] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindowVisible(IntPtr handle);
    private static void Layout(Window window) { var root=(FrameworkElement)window.Content; root.Measure(new Size(960,720)); root.Arrange(new Rect(0,0,960,720)); root.UpdateLayout(); }
    private static void Press(Window window,PresentationSource source,Key key) => window.RaiseEvent(new KeyEventArgs(Keyboard.PrimaryDevice,source,0,key) { RoutedEvent=Keyboard.PreviewKeyDownEvent });
    private static IEnumerable<T> Find<T>(DependencyObject root) where T:DependencyObject { if(root is T value)yield return value; foreach(var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>())foreach(var item in Find<T>(child))yield return item; }
    private static void Await(Task task) { var deadline=DateTime.UtcNow.AddSeconds(10); while(!task.IsCompleted) { if(DateTime.UtcNow>deadline)throw new TimeoutException(); var frame=new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background,new Action(()=>frame.Continue=false)); Dispatcher.PushFrame(frame); Thread.Sleep(1); } task.GetAwaiter().GetResult(); }
    private static void Sta(Action action) { Exception? failure=null; var thread=new Thread(()=> { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch(Exception error) { failure=error; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } }); thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join(); if(failure is not null)System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw(); }
}
