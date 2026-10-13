using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using BellTeam.Core;

namespace BellTeam.App;

public partial class App : Application
{
    private SingleInstance? instance;
    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        try
        {
            if (e.Args is ["--smoke-test", var address, var result])
            {
                Shutdown(await SmokeTest.RunAsync(address, result));
                return;
            }
            if (e.Args is ["--configure", var server])
            {
                var store = new SettingsStore(SettingsStore.UserDirectory);
                store.Save(store.Load() with { ServerUrl = ServerOrigin.Parse(server).AbsoluteUri });
                Shutdown(0);
                return;
            }
            if (e.Args is ["--render-preview", _] || e.Args is ["--render-url", _, _])
            {
                // HWNDを作らず、WPFの部品を画像へ描く。Show・Activateは呼ばない。
                var model = new Workspace();
                var window = new MainWindow(model, persistPlacement: false);
                if (e.Args[0] == "--render-url") await model.ConnectAsync(e.Args[1], listen: false);
                else model.LoadPreview();
                if (model.Entries.FirstOrDefault() is { } first) await model.SelectAsync(first);
                if (model.ConnectionError is { } renderError) throw new BellApiException(renderError);
                var root = (FrameworkElement)window.Content;
                var height = e.Args[0] == "--render-preview" ? 1200 : 820;
                root.Measure(new Size(1280, height));
                root.Arrange(new Rect(0, 0, 1280, height));
                root.UpdateLayout();
                await window.PrepareRenderAsync();
                var bitmap = new RenderTargetBitmap(1280, height, 96, 96, PixelFormats.Pbgra32);
                bitmap.Render(root);
                var encoder = new PngBitmapEncoder();
                encoder.Frames.Add(BitmapFrame.Create(bitmap));
                var output = Path.GetFullPath(e.Args[^1]);
                Directory.CreateDirectory(Path.GetDirectoryName(output)!);
                using (var stream = File.Create(output)) encoder.Save(stream);
                model.Dispose();
                Shutdown(0);
                return;
            }
            if (e.Args.Length != 0) throw new ArgumentException("引数は --smoke-test <URL> <結果ファイル>、--configure <URL>、--render-preview <PNG>、--render-url <URL> <PNG> のいずれかです。");

            var workspace = new Workspace();
            var main = new MainWindow(workspace);
            instance = new SingleInstance(() => Dispatcher.Invoke(() => { main.WindowState = main.WindowState == WindowState.Minimized ? WindowState.Normal : main.WindowState; main.Show(); main.Activate(); }));
            if (!instance.IsPrimary) { Shutdown(0); return; }
            MainWindow = main;
            main.Closed += (_, _) => { workspace.Dispose(); Shutdown(); };
            main.Show();
            var settings = new SettingsStore(SettingsStore.UserDirectory).Load();
            if (settings.ServerUrl is { } url) await workspace.ConnectAsync(url);
            else main.OpenConnectionSettings();
        }
        catch (Exception error)
        {
            var unattended = e.Args.Length != 0;
            if (unattended)
            {
                // 自動検証で対話ダイアログを出さない。終了コードと標準エラーで失敗を返す。
                Console.Error.WriteLine(error.ToString());
            }
            else MessageBox.Show(error.Message, "BellTeam", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
        }
    }
    protected override void OnExit(ExitEventArgs e) { instance?.Dispose(); base.OnExit(e); }
}
