using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using BellTeam.Linux;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Android;

// The phone settings page (docs/android-architecture.md): connection, 利用と課金 with the purchase rows, and the app's version. The Linux SettingsWindow is a Window and cannot be built on Android,
// so the page is written here from the same SettingsUi parts, in the order of the Mac settings list; the other Mac items arrive as pages of their own.
public sealed class SettingsPage : ScrollViewer
{
    public SettingsPage(LinuxWorkspace workspace, Action changeServer, CancellationToken token)
    {
        var column = new StackPanel { Margin = new Thickness(16, 8, 16, 24), Spacing = 14 };

        var connection = new StackPanel();
        connection.Children.Add(CardTitle(SettingsIcons.Globe, "接続", 17));
        connection.Children.Add(Text("つないでいるサーバー", 13, Muted, null, new Thickness(0, 12, 0, 2)));
        connection.Children.Add(Text(workspace.Server, 15, Ink));
        var change = Capsule("接続先を変更", Fill, Ink, 8, 13, new Thickness(14, 8)); change.FontWeight = FontWeight.Normal; change.HorizontalAlignment = HorizontalAlignment.Left; change.Margin = new Thickness(0, 12, 0, 0); change.Click += (_, _) => changeServer();
        connection.Children.Add(change);
        column.Children.Add(Card(connection));

        var billing = new StackPanel();
        billing.Children.Add(CardTitle(SettingsIcons.Card, "利用と課金", 17));
        billing.Children.Add(Text("Web版は無料です。サーバーとAIは、ご自身の契約で利用します。", 14, Muted, null, new Thickness(0, 14, 0, 6)));
        var purchase = new PurchaseEntry(workspace.Management.Api, new PlayBilling(MainActivity.Current), () => MainActivity.Current, token);
        billing.Children.Add(purchase);
        var notice = new StackPanel();
        billing.Children.Add(Link("プライバシー方針", "privacyPolicyUrl", notice)); billing.Children.Add(Link("サポート", "supportUrl", notice)); billing.Children.Add(notice);
        column.Children.Add(Card(billing));

        var about = new StackPanel();
        about.Children.Add(CardTitle(SettingsIcons.Info, "このアプリについて", 17));
        about.Children.Add(Text("アプリの版", 13, Muted, null, new Thickness(0, 12, 0, 2)));
        about.Children.Add(Text(Version(), 15, Ink));
        column.Children.Add(Card(about));

        Content = column;
        _ = purchase.LoadAsync();
    }

    private static StackPanel CardTitle(string glyph, string title, double size)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        line.Children.Add(Glyph(glyph, size + 3, Ink)); var text = Text(title, size, Ink, FontWeight.SemiBold); text.VerticalAlignment = VerticalAlignment.Center; line.Children.Add(text);
        return line;
    }

    private static string Version() => MainActivity.Current.PackageManager?.GetPackageInfo(MainActivity.Current.PackageName!, 0)?.VersionName ?? "不明";

    // The system browser through Avalonia's launcher; a failure is shown on the page, never swallowed.
    private Button Link(string label, string key, Panel notice)
    {
        var button = Capsule(label, Fill, Ink, 8, 13, new Thickness(14, 8)); button.FontWeight = FontWeight.Normal; button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 8, 0, 0);
        button.Click += async (_, _) =>
        {
            notice.Children.Clear();
            try { if (!await TopLevel.GetTopLevel(this)!.Launcher.LaunchUriAsync(EmbeddedAsset.ProductUrl(key))) notice.Children.Add(Banner("ページを開けませんでした。")); }
            catch (Exception error) { notice.Children.Add(Banner("ページを開けませんでした。" + error.Message)); }
        };
        return button;
    }
}
