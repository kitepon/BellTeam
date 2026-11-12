using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Headless;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

// What windows/BellTeam.App/App.xaml.cs OnStartup does: the render modes, otherwise the single window.
internal static partial class Launcher
{
    public const string Usage = "引数は --configure <URL>、--render-preview <PNG>、--render-url <URL> [会話ID] <PNG>、--render-startup <opening|setup|guide|failure|login> <PNG>、--render-startup <onboarding-choose|onboarding-waiting|banner> <URL> <PNG>、--render-page <updates|updates-current|updates-narrow|updates-detail-narrow|update-sheet> <URL> <PNG>、--render-inspector <場面> <URL> <会話ID> <PNG>、--render-screen <場面> <URL> <会話ID> <PNG>、--render-editors <場面> <URL> <会話ID> <PNG>、--render-editor member <URL> <メンバーID> <PNG>、--render-lattice <list|list-back|list-empty|old-server|single|chart|authored|tree|tree-detail|history|owner|owner-lanes|detail|highlight|unverified|last-verified|unknown|degraded|reconnecting|unavailable|not-found> <PNG>、--render-workgraph <URL> <PNG>" + RequestsRender.Usage + " のいずれかです。";
    public static bool IsKnown(string[] args) => args is [] or ["--configure", _] or ["--render-preview", _] or ["--render-url", _, _] or ["--render-url", _, _, _] or ["--render-startup", _, _] or ["--render-startup", _, _, _] or ["--render-page", _, _, _] or ["--render-inspector", _, _, _, _] or ["--render-screen", _, _, _, _] or ["--render-editors", _, _, _, _] or ["--render-editor", _, _, _, _] or ["--render-lattice", _, _] or ["--render-workgraph", _, _] || RequestsRender.IsKnown(args);
    public static bool IsRender(string[] args) => args.Any(argument => argument.StartsWith("--render", StringComparison.Ordinal));

    public static void Start(IClassicDesktopStyleApplicationLifetime desktop)
    {
        // The render modes show no window to close; the single window ends the app by closing.
        if (IsRender(desktop.Args ?? [])) desktop.ShutdownMode = ShutdownMode.OnExplicitShutdown;
        Avalonia.Threading.Dispatcher.UIThread.Post(() => _ = RunAsync(desktop));
    }

    private static SingleInstance? instance;
    private static async Task RunAsync(IClassicDesktopStyleApplicationLifetime desktop)
    {
        var args = desktop.Args ?? [];
        try
        {
            // Renders are screenshots taken right after layout; the card entrance animation would leave cards transparent.
            if (IsRender(args)) MessageEntrance.Enabled = false;
            if (await RequestsRender.TryRunAsync(args)) { desktop.Shutdown(0); return; }
            switch (args)
            {
                case ["--render-preview", var output]: await RenderAsync(null, null, output); break;
                case ["--render-url", var address, var output]: await RenderAsync(address, null, output); break;
                case ["--render-url", var address, var conversation, var output]: await RenderAsync(address, conversation, output); break;
                case ["--render-startup", var scene, var output]: await RenderStartupAsync(scene, output); break;
                case ["--render-startup", var scene, var address, var output]: await UpdatesRender.StartupAsync(scene, address, output); break;
                case ["--render-page", var kind, var address, var output]: await UpdatesRender.PageAsync(kind, address, output); break;
                case ["--render-inspector", var scene, var address, var id, var output]: await RenderInspectorAsync(scene, address, id, output); break;
                case ["--render-screen", var scene, var address, var id, var output]: await RenderScreenAsync(scene, address, id, output); break;
                case ["--render-editors", var scene, var address, var id, var output]: await RenderEditorsAsync(scene, address, id, output); break;
                case ["--render-editor", var kind, var address, var id, var output]: await RenderEditorAsync(kind, address, id, output); break;
                case ["--render-lattice", var scene, var output]: await LatticeRender.LatticeAsync(scene, output); break;
                case ["--render-workgraph", var address, var output]: await LatticeRender.WorkGraphAsync(address, output); break;
                case []: await RunWindowAsync(desktop); return;
                default: throw new ArgumentException(Usage);
            }
            desktop.Shutdown(0);
        }
        catch (Exception error)
        {
            // Unattended runs report through the exit code and standard error.
            Console.Error.WriteLine(error.ToString());
            desktop.Shutdown(1);
        }
    }

    private static async Task RunWindowAsync(IClassicDesktopStyleApplicationLifetime desktop)
    {
        MainWindow? main = null;
        instance = new SingleInstance(() => Dispatcher.UIThread.Post(() => main?.Raise()));
        if (!instance.IsPrimary) { desktop.Shutdown(0); return; }
        var workspace = new LinuxWorkspace();
        // Desktop notifications: default off, only while the app runs; a click opens the conversation (or the Update sheet) in the window.
        var notifications = new DesktopNotifications(new FreedesktopNotificationSink(), new SettingsStore(SettingsStore.UserDirectory), (server, target) => Dispatcher.UIThread.Post(() => _ = main!.OpenNotificationAsync(server, target)));
        main = new MainWindow(workspace, notifications: notifications);
        desktop.MainWindow = main;
        main.Closed += (_, _) => { workspace.Dispose(); instance.Dispose(); };
        // The window is already gone here, so the bus calls that close the open notifications get a few seconds before the process ends.
        desktop.Exit += (_, _) =>
        {
            try { if (!notifications.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(3))) Console.Error.WriteLine("通知の終了処理が時間内に終わりませんでした。"); }
            catch (Exception error) { Console.Error.WriteLine("通知の終了処理を完了できませんでした。" + error.Message); }
        };
        main.Show();
        var settings = new SettingsStore(SettingsStore.UserDirectory).Load();
        if (StartupRoute.Initial(settings.ServerUrl) == StartupPhase.Setup) main.ShowServerSetup(); else await main.ConnectAsync(settings.ServerUrl!);
    }

    // The preview fixture or a live server's read-only data, drawn into a PNG without a screen.
    private static async Task RenderAsync(string? address, string? conversationId, string output)
    {
        using var model = new LinuxWorkspace();
        var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false };
        window.Show();
        if (address is not null) await model.ConnectAsync(address, listen: false); else model.LoadPreview();
        var first = conversationId is not null ? model.Entries.FirstOrDefault(entry => entry.Target.Id == conversationId) ?? throw new BellApiException("指定した会話がありません。") : model.Entries.FirstOrDefault();
        if (first is not null) await model.SelectAsync(first);
        if (model.ConnectionError is { } renderError) throw new BellApiException(renderError);
        await window.PrepareRenderAsync();
        WritePng(window, output);
    }

    private static async Task RenderStartupAsync(string scene, string output)
    {
        using var model = new LinuxWorkspace();
        var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false };
        window.Show();
        switch (scene)
        {
            case "opening": window.ShowStartupForRender(StartupPhase.Checking); break;
            case "setup": window.ShowServerSetup(); break;
            case "guide": window.ShowServerSetup(); window.ShowServerGuide(); break;
            case "failure": window.ShowStartupForRender(StartupPhase.Failure, "サーバーに接続できませんでした。接続先とネットワークを確認してください。"); break;
            case "login": window.ShowStartupForRender(StartupPhase.SignIn); break;
            default: throw new ArgumentException("未対応の起動画面です。" + Usage);
        }
        await window.PrepareRenderAsync();
        WritePng(window, output);
    }

    internal static void WritePng(Window window, string path)
    {
        Dispatcher.UIThread.RunJobs();
        var frame = window.CaptureRenderedFrame() ?? throw new InvalidOperationException("画面を描画できませんでした。");
        var file = Path.GetFullPath(path); Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        frame.Save(file, new PngBitmapEncoderOptions());
    }
}
