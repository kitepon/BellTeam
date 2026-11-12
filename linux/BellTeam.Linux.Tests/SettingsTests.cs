using Avalonia.Controls;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

public sealed class SettingsTests
{
    private static string TempDirectory() => Directory.CreateTempSubdirectory("bellteam-settings-").FullName;

    [Fact]
    public async Task TheNotificationSwitchWritesAndReadsSettingsStoreNotificationsEnabled()
    {
        var store = new SettingsStore(TempDirectory());
        var control = new StoredNotificationSwitch(store);
        Assert.False(control.Enabled); Assert.Equal("通知はオフです。", control.Status);
        await control.SetEnabledAsync(true);
        Assert.True(store.Load().NotificationsEnabled); Assert.Equal("アプリが起きている間だけ通知します。", control.Status);
        Assert.True(new StoredNotificationSwitch(store).Enabled);
    }

    [Fact]
    public Task TheSettingsPageRoutesFromTheMainWindowAndTheTerminalEditorOffersNoThisPc() => Ui.Run(async () =>
    {
        var workspace = new LinuxWorkspace(origin => new BellApi(origin, new FakeServer()));
        var window = new MainWindow(workspace, persistPlacement: false, settings: new SettingsStore(TempDirectory())) { AutoRetry = false };
        window.Show();
        await window.ConnectAsync("http://localhost:1/");
        window.ShowSettings(SettingsPage.About);
        await window.PageReady; Dispatcher.UIThread.RunJobs();
        Assert.Equal(SettingsPage.About, window.SettingsPageWindow!.Selected);
        Assert.Contains(window.GetVisualDescendants().OfType<TextBlock>(), text => text.Text == "アプリの版");
        // 16c reads the Windows OpenSSH host-key path, so the editor has neither the row nor an owned host.
        var editor = new TerminalEditorView(workspace, workspace.Terminals, null);
        Assert.DoesNotContain(editor.GetVisualDescendants().OfType<TextBlock>(), text => text.Text?.Contains("このPC") == true);
        Assert.False(workspace.Terminals.OwnsHost(new Terminal { TerminalId = "x", Host = "192.0.2.1", User = "u", Port = 22 }));
        editor.Dispose();
        window.Close(); workspace.Dispose();
    });
}
