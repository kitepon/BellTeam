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
                var configuration = store.Load(); var origin = ServerOrigin.Parse(server);
                if (configuration.ServerUrl is { } previous && previous != origin.AbsoluteUri) await new DesktopAccess().SignOutAsync();
                store.Save(configuration with { ServerUrl = origin.AbsoluteUri });
                Shutdown(0);
                return;
            }
            if (e.Args is ["--install-shortcut"])
            {
                DesktopShortcut.Create(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "BellTeam.lnk"), Environment.ProcessPath!); Shutdown(0); return;
            }
            if (e.Args is ["--render-gallery", var galleryAddress, var galleryId, var galleryOutput])
            {
                using var galleryWorkspace = new Workspace(); await galleryWorkspace.ConnectAsync(galleryAddress,listen:false);
                if (galleryWorkspace.ConnectionError is { } failure) throw new BellApiException(failure);
                var target = galleryWorkspace.Entries.Single(item=>item.Target.Id==galleryId); await galleryWorkspace.SelectAsync(target);
                var paths = galleryWorkspace.Messages.SelectMany(item=>item.Message.DisplayedImageUrls).Distinct().ToArray();
                if (paths.Length==0) throw new BellApiException("表示する画像がありません。");
                var gallery = new ImageGallery(galleryWorkspace,paths,0); await gallery.ReadyTask; WritePng(gallery,960,720,galleryOutput); gallery.Close(); Shutdown(0); return;
            }
            if (e.Args is ["--render-editor", var editorKind, var editorAddress, var editorId, var editorOutput])
            {
                using var editorWorkspace = new Workspace(); await editorWorkspace.ConnectAsync(editorAddress, listen: false);
                if (editorWorkspace.ConnectionError is { } connectionError) throw new BellApiException(connectionError);
                EditorWindow editor;
                if (editorKind is "member" or "new-member") { var member = new MemberEditor(editorWorkspace, editorKind == "new-member" ? null : editorId); editor = member; await member.InitializeAsync(); }
                else if (editorKind is "room" or "new-room") { var room = new RoomEditor(editorWorkspace, editorKind == "new-room" ? null : editorId); editor = room; await room.InitializeAsync(); }
                else if (editorKind == "settings") { var settingsEditor = new SettingsWindow(editorWorkspace); editor = settingsEditor; await settingsEditor.InitializeAsync(); }
                else if (editorKind == "profile") { var profile = new ProfileEditor(editorWorkspace); editor = profile; await profile.InitializeAsync(); }
                else if (editorKind == "feature") { var feature = new FeatureEditor(editorWorkspace, editorId, "追加機能"); editor = feature; await feature.InitializeAsync(); }
                else if (editorKind == "schedules") { var schedules = new SchedulesWindow(editorWorkspace); editor = schedules; await schedules.InitializeAsync(); }
                else if (editorKind == "new-schedule") editor = new ScheduleEditor(editorWorkspace, null);
                else if (editorKind == "setup") editor = new SetupWindow(editorWorkspace, await new SetupApi(editorWorkspace.Management.Api).StatusAsync());
                else if (editorKind == "authentication") { var option = (await new HarnessAuthenticationApi(editorWorkspace.Management.Api).ListAsync(editorWorkspace.ConnectionToken)).Harnesses.Single(item => item.Id == editorId); var authentication = new HarnessAuthenticationWindow(editorWorkspace, option); editor = authentication; await authentication.InitializeAsync(); }
                else throw new ArgumentException("未対応の編集画面です。");
                await editor.ReadyTask; WritePng(editor, (int)editor.Width, (int)editor.Height, editorOutput); editor.Close(); Shutdown(0); return;
            }
            if (e.Args is ["--render-page", var pageKind, var pageAddress, var pageOutput])
            {
                using var pageWorkspace = new Workspace(); await pageWorkspace.ConnectAsync(pageAddress, listen: false);
                if (pageWorkspace.ConnectionError is { } failure) throw new BellApiException(failure);
                var pageWindow = new MainWindow(pageWorkspace, persistPlacement: false, notifications: new DesktopNotifications(new WindowsNotificationSink(), new SettingsStore(SettingsStore.UserDirectory), (_, _) => { }));
                if (pageKind is "settings" or "settings-lower") pageWindow.ShowSettings(); else if (pageKind == "schedules") pageWindow.ShowSchedules(); else throw new ArgumentException("未対応のページです。");
                await pageWindow.PageReady;
                var pageRoot = (FrameworkElement)pageWindow.Content; pageRoot.Measure(new Size(1280, 820)); pageRoot.Arrange(new Rect(0, 0, 1280, 820)); pageRoot.UpdateLayout();
                await pageWindow.PrepareRenderAsync(bottomOfPage: pageKind == "settings-lower"); WritePng(pageWindow, 1280, 820, pageOutput); pageWindow.Close(); Shutdown(0); return;
            }
            if (e.Args is ["--render-preview", _] || e.Args is ["--render-url", _, _] || e.Args is ["--render-url", _, _, _])
            {
                // HWNDを作らず、WPFの部品を画像へ描く。Show・Activateは呼ばない。
                var model = new Workspace();
                var window = new MainWindow(model, persistPlacement: false);
                if (e.Args[0] == "--render-url") await model.ConnectAsync(e.Args[1], listen: false);
                else model.LoadPreview();
                var first = e.Args is ["--render-url", _, var conversationId, _] ? model.Entries.FirstOrDefault(entry => entry.Target.Id == conversationId) ?? throw new BellApiException("指定した会話がありません。") : model.Entries.FirstOrDefault();
                if (first is not null) await model.SelectAsync(first);
                if (model.ConnectionError is { } renderError) throw new BellApiException(renderError);
                var root = (FrameworkElement)window.Content;
                var height = e.Args[0] == "--render-preview" ? 1200 : 820;
                root.Measure(new Size(1280, height));
                root.Arrange(new Rect(0, 0, 1280, height));
                root.UpdateLayout();
                await window.PrepareRenderAsync();
                WritePng(window, 1280, height, e.Args[^1]);
                model.Dispose();
                Shutdown(0);
                return;
            }
            if (e.Args.Length != 0) throw new ArgumentException("引数は --install-shortcut、--smoke-test <URL> <結果ファイル>、--configure <URL>、--render-preview <PNG>、--render-gallery <URL> <会話ID> <PNG>、--render-url <URL> [会話ID] <PNG>、--render-page <settings|settings-lower|schedules> <URL> <PNG>、--render-editor <member|new-member|room|new-room|settings|profile|feature|schedules|new-schedule|setup|authentication> <URL> <ID> <PNG> のいずれかです。");

            MainWindow? main = null;
            instance = new SingleInstance(() => Dispatcher.Invoke(() => { main!.WindowState = main.WindowState == WindowState.Minimized ? WindowState.Normal : main.WindowState; main.Show(); main.Activate(); }));
            if (!instance.IsPrimary) { Shutdown(0); return; }
            var access = new DesktopAccess();
            var workspace = new Workspace(origin => new BellApi(origin, cookies: access.Cookies), access.RestoreAsync);
            var notifications = new DesktopNotifications(new WindowsNotificationSink(), new SettingsStore(SettingsStore.UserDirectory), (server, target) => Dispatcher.BeginInvoke(() => _ = main!.OpenNotificationAsync(server, target)));
            main = new MainWindow(workspace, access: access, notifications: notifications);
            MainWindow = main;
            main.Closed += async (_, _) => { workspace.Dispose(); try { await notifications.DisposeAsync(); } catch (Exception error) { MessageBox.Show("通知の終了処理を完了できませんでした。" + error.Message, "BellTeam", MessageBoxButton.OK, MessageBoxImage.Error); } finally { Shutdown(); } };
            main.Show();
            var settings = new SettingsStore(SettingsStore.UserDirectory).Load();
            if (settings.ServerUrl is { } url) await main.ConnectAsync(url);
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
    private static void WritePng(Window window, int width, int height, string path)
    {
        var root = (FrameworkElement)window.Content;
        // Contentだけを描く画像にも、実際の窓の背景を含める。
        if (root is System.Windows.Controls.Panel { Background: null } panel) panel.Background = window.Background ?? SystemColors.WindowBrush;
        root.Measure(new Size(width, height)); root.Arrange(new Rect(0, 0, width, height)); root.UpdateLayout();
        var bitmap = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32); bitmap.Render(root);
        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
        var output = Path.GetFullPath(path); Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        using var stream = File.Create(output); encoder.Save(stream);
    }
    protected override void OnExit(ExitEventArgs e) { instance?.Dispose(); base.OnExit(e); }
}
