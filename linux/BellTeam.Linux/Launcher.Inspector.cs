using Avalonia;
using Avalonia.Controls;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

// The render modes of the inspector, the Bot screen and the editors (windows App.xaml.cs --render-inspector, --render-screen, --render-editors, --render-editor).
// They read from a mock server (GET only); states that need a POST result are set through render seams, never sent.
internal static partial class Launcher
{
    private static async Task<(LinuxWorkspace Model, MainWindow Window)> OpenForRenderAsync(string address, string? select)
    {
        var model = new LinuxWorkspace(); var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false };
        window.Show();
        await model.ConnectAsync(address, listen: false);
        if (model.ConnectionError is { } failure) throw new BellApiException(failure);
        if (select is not null) await model.SelectAsync(model.Entries.FirstOrDefault(entry => entry.Target.Id == select) ?? throw new BellApiException("指定した会話がありません。"));
        return (model, window);
    }
    // A window that is not the main one: layout and queued work first, then the frame.
    private static void WriteSettledPng(Window window, string output) { Dispatcher.UIThread.RunJobs(); window.UpdateLayout(); WritePng(window, output); }

    private static async Task RenderInspectorAsync(string scene, string address, string id, string output)
    {
        var (model, window) = await OpenForRenderAsync(address, id);
        using var _ = model;
        if (scene is "restart-busy" or "restart-success") window.ProfilePanel.SetRestartForRender(id, scene == "restart-busy");
        if (scene.StartsWith("pending", StringComparison.Ordinal))
        {
            var swatch = Swatch(0xE8, 0x6B, 0x94, 60, 60);
            model.ImageSession(id).Keep(AvatarVariant.Large, new AvatarSelection(AvatarCropView.Encode(swatch, new AvatarCrop(swatch.PixelSize.Width, swatch.PixelSize.Height, 1024)), "data:image/jpeg;base64,/9j/", new AvatarCropRect(0, 0, 1, 1)), BotProfileText.Unconfirmed(new BellApiException("接続が切れました。")));
        }
        var sheet = scene switch { "sheet-small" => window.ShowAvatarSheetForRender(AvatarVariant.Small), "sheet-large" or "sheet-unsupported" or "pending-sheet" => window.ShowAvatarSheetForRender(AvatarVariant.Large), _ => null };
        if (scene == "sheet-unsupported" && sheet is not null) await sheet.LoadSettingsAsync();
        if (sheet is not null) await sheet.Ready;
        // Without a sheet the whole panel is shown, so the window is as tall as the panel.
        window.Height = sheet is null ? 1400 : 820;
        await window.PrepareRenderAsync();
        WritePng(window, output);
        window.Close();
    }

    private static async Task RenderScreenAsync(string scene, string address, string id, string output)
    {
        var (model, window) = await OpenForRenderAsync(address, id);
        using var _ = model;
        var opened = model.OpenScreenAsync();
        await model.ScreenFirstRead.WaitAsync(TimeSpan.FromSeconds(10));
        if (scene == "digits") { window.ScreenPanel.OpenDigitsForRender(); model.ScreenInput!.SetNoticeForRender("席が起動していません"); }
        if (scene == "sent") window.ScreenPanel.ShowSentForRender("Enter");
        await window.PrepareRenderAsync();
        window.ScreenPanel.FollowBottomForRender(); window.UpdateLayout();
        WritePng(window, output);
        model.ReturnToProfile(); await opened;
        window.Close();
    }

    private static async Task RenderEditorAsync(string kind, string address, string id, string output)
    {
        if (kind != "member") throw new ArgumentException("未対応の編集画面です。" + Usage);
        using var model = new LinuxWorkspace(); await model.ConnectAsync(address, listen: false);
        if (model.ConnectionError is { } failure) throw new BellApiException(failure);
        var window = new MemberEditorWindow(model, id); window.Show();
        await window.InitializeAsync(); await window.View.ReadyTask;
        WriteSettledPng(window, output); window.Close();
    }

    private static async Task RenderEditorsAsync(string scene, string address, string id, string output)
    {
        var (model, window) = await OpenForRenderAsync(address, null);
        using var _ = model;
        if (model.Entries.FirstOrDefault(entry => entry.Target.Id == id) is { } behind) await model.SelectAsync(behind);
        if (scene.StartsWith("member", StringComparison.Ordinal))
        {
            if (scene == "member-delete-pending") model.SetBotDeletionPendingForRender(id);
            var memberWindow = window.CreateMemberWindowForRender(id); memberWindow.Show(); await memberWindow.InitializeAsync(); await memberWindow.View.ReadyTask;
            if (scene == "member-delete-unconfirmed") memberWindow.View.ShowDeletionUnconfirmedForRender();
            if (scene == "member-delete-alert") memberWindow.View.AskDelete();
            if (scene is "member-delete-pending" or "member-delete-unconfirmed") { memberWindow.UpdateLayout(); memberWindow.View.ScrollToEndForRender(); }
            WriteSettledPng(memberWindow, output); memberWindow.Close(); window.Close(); return;
        }
        if (scene.StartsWith("folder-", StringComparison.Ordinal))
        {
            // 端末とフォルダ: the picker over an existing member's window, or the new-member sheet with a terminal chosen. Reads are GETs; the terminal choice,
            // the picker's place and a refused save are set through seams, never sent.
            var picking = scene.StartsWith("folder-picker", StringComparison.Ordinal);
            MemberEditorView folderView; Window folderWindow;
            if (picking) { var memberWindow = window.CreateMemberWindowForRender(id); memberWindow.Show(); await memberWindow.InitializeAsync(); await memberWindow.View.ReadyTask; (folderWindow, folderView) = (memberWindow, memberWindow.View); }
            else { window.ShowMemberSheet(); await window.EditorReady; (folderWindow, folderView) = (window, (MemberEditorView)window.OpenEditor!); await folderView.ImagesReady; }
            folderWindow.UpdateLayout();
            if (!picking)
            {
                folderView.ChooseTerminalForRender("ハル", scene == "folder-new-windows" ? "fox" : "owner-macbook");
                if (scene == "folder-new-typed") { await folderView.OpenPickerForRender(null); folderView.ClosePickerForRender(); }
                if (scene == "folder-new-missing") folderView.ShowFolderRefusalForRender("FOLDER_MISSING");
                folderWindow.UpdateLayout();
                if (scene == "folder-new-missing") folderView.ScrollToEndForRender(); else folderView.ShowTerminalSectionForRender();
            }
            else await folderView.OpenPickerForRender(scene switch { "folder-picker-sub" => "/Users/kite/work", "folder-picker-created" => "/Users/kite/work/scratch", _ => null });
            folderWindow.UpdateLayout();
            if (folderWindow == window) await window.PrepareRenderAsync();
            WriteSettledPng(folderWindow, output); folderWindow.Close(); if (folderWindow != window) window.Close(); return;
        }
        if (scene is "new-member") window.ShowMemberSheet();
        else if (scene is "new-room") window.ShowRoomSheet(null);
        else if (scene is "room" or "room-delete-alert") window.ShowRoomSheet(id);
        else if (scene == "crop") window.ShowCropForRender(SplitSwatch(), AvatarVariant.Small);
        else throw new ArgumentException("未対応の編集画面です。" + Usage);
        await window.EditorReady;
        if (scene == "room-delete-alert" && window.OpenEditor is RoomEditorView roomView) roomView.AskDelete();
        if (window.OpenEditor is MemberEditorView created) await created.ImagesReady;
        await window.PrepareRenderAsync();
        WritePng(window, output);
        window.Close();
    }

    // Mac preview image of the crop sheet: the left half blue, the right half green.
    private static Bitmap SplitSwatch() => Pixels(400, 300, (x, _) => x < 200 ? (0xFF, 0x84, 0x0A) : (0x59, 0xC2, 0x34));
    private static Bitmap Swatch(int red, int green, int blue, int width, int height) => Pixels(width, height, (_, _) => (blue, green, red));
    private static Bitmap Pixels(int width, int height, Func<int, int, (int Blue, int Green, int Red)> color)
    {
        var bitmap = new WriteableBitmap(new PixelSize(width, height), new Vector(96, 96), PixelFormat.Bgra8888, AlphaFormat.Opaque);
        using var buffer = bitmap.Lock();
        var row = new byte[width * 4];
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++) { var (blue, green, red) = color(x, y); row[x * 4] = (byte)blue; row[x * 4 + 1] = (byte)green; row[x * 4 + 2] = (byte)red; row[x * 4 + 3] = 255; }
            System.Runtime.InteropServices.Marshal.Copy(row, 0, buffer.Address + y * buffer.RowBytes, row.Length);
        }
        return bitmap;
    }
}
