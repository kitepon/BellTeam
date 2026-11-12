using Avalonia.Controls;
using BellTeam.Core;

namespace BellTeam.Linux;

// The render modes of this group (Windows App.xaml.cs --render-page updates*/update-sheet and --render-startup onboarding-*/banner):
// read from a mock or live server (GET only), drawn into a PNG without a screen.
internal static class UpdatesRender
{
    // A render never reads or writes the user's saved settings.
    private static SettingsStore Scratch() => new(Path.Combine(Path.GetTempPath(), "BellTeam-render-" + Guid.NewGuid()));
    public static async Task PageAsync(string kind, string address, string output)
    {
        if (kind is not ("updates" or "updates-current" or "updates-narrow" or "updates-detail-narrow" or "update-sheet")) throw new ArgumentException("未対応のページです。" + Launcher.Usage);
        using var model = new LinuxWorkspace();
        if (kind == "update-sheet")
        {
            var window = new MainWindow(model, persistPlacement: false, settings: Scratch()) { AutoRetry = false };
            window.Show();
            await model.ConnectAsync(address, listen: false);
            if (model.ConnectionError is { } failure) throw new BellApiException(failure);
            if (model.Entries.FirstOrDefault() is { } behind) await model.SelectAsync(behind);
            window.ShowUpdateSheet();
            await window.SheetReady; await window.UpdateNoticeReady;
            await window.PrepareRenderAsync();
            Launcher.WritePng(window, output);
            return;
        }
        // The settings page that hosts the content is ported by the settings group; until then the content is drawn alone, at the page's size.
        await model.ConnectAsync(address, listen: false);
        if (model.ConnectionError is { } connectFailure) throw new BellApiException(connectFailure);
        var narrow = kind is "updates-narrow" or "updates-detail-narrow";
        using var content = new UpdateContent(model, Scratch());
        var host = new Window { Width = narrow ? 1100 : 1280, Height = narrow ? 700 : 820, Content = content };
        host.Show();
        await content.RefreshAsync();
        if (kind == "updates-detail-narrow") { content.DetailsOpen = true; content.ScrollToEnd(); }
        host.UpdateLayout();
        Launcher.WritePng(host, output);
    }

    // The startup screens with the app's real routing: the server's session and setup answers decide the phase.
    public static async Task StartupAsync(string scene, string address, string output)
    {
        StartupPhase expected = scene switch { "onboarding-choose" or "onboarding-waiting" => StartupPhase.Onboarding, "banner" => StartupPhase.Ready, _ => throw new ArgumentException("未対応の起動画面です。" + Launcher.Usage) };
        using var model = new LinuxWorkspace();
        var window = new MainWindow(model, persistPlacement: false, settings: Scratch()) { AutoRetry = false };
        window.Show();
        await window.ConnectAsync(address);
        if (window.Startup != expected) throw new BellApiException($"起動画面が想定と違います: {window.Startup}");
        if (scene == "banner") model.SetConnectionErrorForRender("更新の接続が切れました。再接続しています。");
        await window.PrepareRenderAsync();
        Launcher.WritePng(window, output);
    }
}
