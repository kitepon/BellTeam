using System.IO;
using BellTeam.App;
using BellTeam.Core;
using Windows.UI.Notifications;

public static class NativeNotificationCheck
{
    public static async Task RunAsync(bool showSilently = false)
    {
        var shortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "BellTeam 通知試験.lnk");
        if (File.Exists(shortcut)) throw new IOException("通知試験のショートカットが既に存在します。前の試験の終了結果を確認してください。");
        var sink = new WindowsNotificationSink("BellTeam.NotificationCheck", suppressPopup: true);
        DesktopShortcut.Create(shortcut, Environment.ProcessPath!, "BellTeam.NotificationCheck");
        try
        {
            var identity = DesktopShortcut.Inspect(shortcut);
            if (identity.Target != Environment.ProcessPath || identity.AppId != "BellTeam.NotificationCheck") throw new InvalidOperationException("通知試験のショートカットが指定した内容と違います。");
            Console.WriteLine("ショートカットの接続先とAppUserModelIDを読み戻しました。");
            var failure = new TaskCompletionSource<string>(); sink.Start((_, _) => { }, error => failure.TrySetResult(error));
            Console.WriteLine("Windows通知を準備しました。");
            if (showSilently)
            {
                sink.Show(new("http://notification-check.invalid/", new("test", false), "BellTeam通知試験", "非表示・無音の検証用メッセージ"));
                await Task.WhenAny(failure.Task, Task.Delay(1000));
                if (failure.Task.IsCompleted) throw new InvalidOperationException(await failure.Task);
                var history = ToastNotificationManager.History.GetHistory("BellTeam.NotificationCheck");
                Console.WriteLine("非表示・無音の通知要求を送り、履歴を読めました。件数=" + history.Count);
            }
        }
        finally { try { await sink.StopAsync(); } finally { File.Delete(shortcut); } }
        if (showSilently && ToastNotificationManager.History.GetHistory("BellTeam.NotificationCheck").Count != 0) throw new InvalidOperationException("通知試験の履歴が残っています。");
        if (File.Exists(shortcut)) throw new IOException("通知試験のショートカットが残っています。");
        Console.WriteLine("Windows通知の終了と試験用ショートカットの削除を確認しました。");
    }
}
