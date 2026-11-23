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
public sealed class PhoneSettingsPage : ScrollViewer
{
    public PhoneSettingsPage(LinuxWorkspace workspace, Action changeServer, Action signOut, Action openDetails, CancellationToken token)
    {
        var column = new StackPanel { Margin = new Thickness(16, 8, 16, 24), Spacing = 14 };

        // The other Mac settings pages (AI, terminals, features, display, update, stop) are the Linux screens, opened as a page of their own.
        var details = new Button { Classes = { "plain" }, Background = BellTheme.ProminentFill, Foreground = Brushes.White, Padding = new Thickness(16, 12), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Center, Content = "AI・端末・追加機能などの設定" };
        details.Click += (_, _) => openDetails();
        column.Children.Add(details);

        var connection = new StackPanel();
        connection.Children.Add(CardTitle(SettingsIcons.Globe, "接続", 17));
        connection.Children.Add(Text("つないでいるサーバー", 13, Muted, null, new Thickness(0, 12, 0, 2)));
        connection.Children.Add(Text(workspace.Server, 15, Ink));
        var change = Capsule("接続先を変更", Fill, Ink, 8, 13, new Thickness(14, 8)); change.FontWeight = FontWeight.Normal; change.HorizontalAlignment = HorizontalAlignment.Left; change.Margin = new Thickness(0, 12, 0, 0); change.Click += (_, _) => changeServer();
        connection.Children.Add(change);
        // Cloudflare Access servers: the login lives in the WebView and the container, so leaving it is an explicit step (Windows has the same button).
        if (workspace.AuthMode == "cloudflare")
        {
            var leave = Capsule("サインアウト", Fill, Ink, 8, 13, new Thickness(14, 8)); leave.FontWeight = FontWeight.Normal; leave.HorizontalAlignment = HorizontalAlignment.Left; leave.Margin = new Thickness(0, 8, 0, 0); leave.Click += (_, _) => signOut();
            connection.Children.Add(leave);
        }
        column.Children.Add(Card(connection));

        column.Children.Add(Card(new AccountCard(token)));

        var billing = new StackPanel();
        billing.Children.Add(CardTitle(SettingsIcons.Card, "利用と課金", 17));
        billing.Children.Add(Text("Web版は無料です。サーバーとAIは、ご自身の契約で利用します。", 14, Muted, null, new Thickness(0, 14, 0, 6)));
        var purchase = new BellTeam.Linux.PurchaseEntry(new SubscriptionApi(workspace.Management.Api), token);
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

    // The system browser (ExternalLink.Opener); a failure is shown on the page, never swallowed.
    private Button Link(string label, string key, Panel notice)
    {
        var button = Capsule(label, Fill, Ink, 8, 13, new Thickness(14, 8)); button.FontWeight = FontWeight.Normal; button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 8, 0, 0);
        button.Click += (_, _) =>
        {
            notice.Children.Clear();
            try { ExternalLink.Launch(EmbeddedAsset.ProductUrl(key)); }
            catch (Exception error) { notice.Children.Add(Banner("ページを開けませんでした。" + error.Message)); }
        };
        return button;
    }
}
