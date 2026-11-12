using Avalonia.Controls;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// The render modes of the settings group (Windows App.xaml.cs --render-page settings-*, --render-terminals, --render-editor settings|profile|feature|authentication).
// Every request is a GET from the mock; what follows a check or a write is set through render seams, never sent.
internal static class SettingsRender
{
    public static bool IsPage(string[] args) => args is ["--render-page", _, _, _];
    public static bool IsKnownEditor(string kind) => kind is "settings" or "profile" or "feature" or "authentication";

    private static async Task<LinuxWorkspace> ConnectAsync(string address)
    {
        var model = new LinuxWorkspace();
        await model.ConnectAsync(address, listen: false);
        if (model.ConnectionError is { } failure) { model.Dispose(); throw new BellApiException(failure); }
        return model;
    }

    // --render-page <settings|settings-lower|settings-<page>|onepassword-<scene>> <URL> <PNG>
    public static async Task PageAsync(string kind, string address, string output)
    {
        using var model = await ConnectAsync(address);
        var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false };
        window.Show();
        if (kind is "settings" or "settings-lower") window.ShowSettings();
        else if (kind.StartsWith("settings-", StringComparison.Ordinal) && Enum.TryParse<SettingsPage>(kind["settings-".Length..], ignoreCase: true, out var page)) window.ShowSettings(page);
        else if (kind.StartsWith("onepassword-", StringComparison.Ordinal)) window.ShowSettings(SettingsPage.Features);
        else throw new ArgumentException("未対応のページです。" + Launcher.Usage);
        await window.PageReady;
        if (kind.StartsWith("onepassword-", StringComparison.Ordinal)) await (window.SettingsPageWindow ?? throw new BellApiException("設定を開けませんでした。")).OpenOnePasswordForRender(kind["onepassword-".Length..]);
        await window.SettingsPageWindow!.ReadyTask;
        await window.PrepareRenderAsync(bottomOfPage: kind == "settings-lower");
        Launcher.WritePng(window, output); window.Close();
    }

    // --render-terminals <scene> <URL> <PNG>
    public static async Task TerminalsAsync(string scene, string address, string output)
    {
        using var model = await ConnectAsync(address);
        var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false };
        window.Show();
        window.ShowSettings(SettingsPage.Terminals); await window.PageReady;
        var settings = window.SettingsPageWindow!; var terminals = model.Terminals;
        var terminalId = scene.StartsWith("editor", StringComparison.Ordinal) ? "" : terminals.Terminals.First().TerminalId;
        var observed = DateTimeOffset.Now.AddMinutes(-3).ToString("o");
        TerminalCheck Failed(string reason, string? action) => new() { TerminalId = terminalId, Reachable = false, Reason = reason, Action = action, ObservedAt = observed };
        if (scene.StartsWith("editor-", StringComparison.Ordinal))
        {
            var editor = new TerminalEditorView(model, terminals, null) { Closer = window.CloseSheet };
            TerminalParts.Select(editor.OsPicker, scene["editor-".Length..]);
            window.OpenSheet("端末を追加", editor);
        }
        else if (scene != "list")
        {
            settings.OpenTerminal(terminalId);
            switch (scene)
            {
                case "detail-auth-failed": terminals.Checks[terminalId] = Failed("AUTH_FAILED", "この鍵がまだMacに入っていないかもしれません。「このMacにこの鍵を入れる」で、Macのログインパスワードを使って入れられます"); break;
                case "detail-windows": terminals.Checks[terminalId] = Failed("CONNECTION_REFUSED", null); break;
                case "detail-authorizing": terminals.Checks[terminalId] = Failed("AUTH_FAILED", null); terminals.Authorizations[terminalId] = new AuthorizeState.Waiting("r1", false); break;
                case "detail-hostkey": case "hostkey-sheet": terminals.Checks[terminalId] = Failed("TARGET_MISMATCH", "confirm the new host key SHA256:nsffMHVAtGXV6+uEQqXTTMcNxrINQqErir/1ZI1Ch/Y on office-imac.local"); break;
                case "keys" or "keys-pending": break;
                default: throw new ArgumentException("未対応の端末画面です。" + Launcher.Usage);
            }
            terminals.Notify();
            if (scene == "detail-hostkey") settings.TerminalDetail!.OtherWaysOpen = true;
            if (scene == "hostkey-sheet") window.OpenSheet("ホスト鍵", new HostKeyView(model, terminals, terminals.Find(terminalId)!, terminals.Checks[terminalId]) { Closer = window.CloseSheet });
        }
        await window.PrepareRenderAsync(bottomOfPage: scene.StartsWith("keys", StringComparison.Ordinal));
        Launcher.WritePng(window, output); window.Close();
    }

    // --render-editor <settings|profile|feature|authentication> <URL> <ID> <PNG>: the editor as a window of its own.
    public static async Task EditorAsync(string kind, string address, string id, string output)
    {
        using var model = await ConnectAsync(address);
        EditorWindow editor;
        if (kind is "settings" or "profile") { var settings = new SettingsWindow(model, notifications: new StoredNotificationSwitch(new SettingsStore(SettingsStore.UserDirectory))) { Width = 960, Height = 800 }; editor = settings; await settings.InitializeAsync(SettingsPage.Profile); }
        else if (kind == "feature") { var feature = new FeatureEditor(model, id, "追加機能"); editor = feature; await feature.InitializeAsync(); }
        else if (kind == "authentication") { var option = (await new HarnessAuthenticationApi(model.Management.Api).ListAsync(model.ConnectionToken)).Harnesses.Single(item => item.Id == id); var authentication = new HarnessAuthenticationWindow(model, option); editor = authentication; await authentication.InitializeAsync(); }
        else throw new ArgumentException("未対応の編集画面です。" + Launcher.Usage);
        editor.Show();
        await editor.ReadyTask;
        await PrepareAsync(editor);
        Launcher.WritePng(editor, output); editor.Close();
    }

    // Waits for the avatars that were just asked for (the profile portrait), then lays the window out.
    private static async Task PrepareAsync(Window window)
    {
        for (var round = 0; round < 3; round++)
        {
            Dispatcher.UIThread.RunJobs();
            await Task.WhenAll(window.GetVisualDescendants().OfType<AvatarTile>().Select(tile => tile.LoadTask)); await Task.Yield();
        }
        window.UpdateLayout();
    }
}
