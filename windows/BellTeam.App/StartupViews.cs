using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;

namespace BellTeam.App;

// The files the Mac app bundles for its server setup screen; the project embeds the same sources.
internal static class EmbeddedAsset
{
    public static Stream Open(string name) => typeof(EmbeddedAsset).Assembly.GetManifestResourceStream(name) ?? throw new InvalidOperationException($"組み込みの資料 {name} が見つかりません。");
    public static string Text(string name) { using var reader = new StreamReader(Open(name), Encoding.UTF8); return reader.ReadToEnd(); }
    public static Uri ProductUrl(string key)
    {
        using var product = JsonDocument.Parse(Text("product.json"));
        return new Uri(product.RootElement.GetProperty(key).GetString() ?? throw new InvalidOperationException($"product.json に {key} がありません。"));
    }
    public static BitmapImage Portrait(int pixelWidth)
    {
        var image = new BitmapImage(); image.BeginInit(); image.StreamSource = Open("BellPortrait.png"); image.DecodePixelWidth = pixelWidth; image.CacheOption = BitmapCacheOption.OnLoad; image.EndInit(); image.Freeze(); return image;
    }
}

// Mac catalyst controls and BellTheme pieces used by the full-window screens.
internal static class MacUi
{
    private static SolidColorBrush Solid(string hex) { var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex)); brush.Freeze(); return brush; }
    public static readonly Brush Ink = Solid("#21293D"), Muted = Solid("#787D91"), Secondary = Solid("#8A8A8E"), Violet = Solid("#6147D4"), ProminentFill = Solid("#5642C9"), Red = Solid("#FF3B30"), Line = Solid("#E5E3F0"), ButtonFill = Solid("#E4E3E8");
    public static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");
    private const string Namespaces = "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"";
    // A template belongs to the thread that parsed it, so each UI thread keeps its own.
    [ThreadStatic] private static ControlTemplate? chromeTemplate, primaryTemplate, bareTemplate;
    private static ControlTemplate Chrome(int radius) => (ControlTemplate)XamlReader.Parse($"<ControlTemplate {Namespaces} TargetType=\"Button\"><Border x:Name=\"Chrome\" Background=\"{{TemplateBinding Background}}\" CornerRadius=\"{radius}\" Padding=\"{{TemplateBinding Padding}}\"><ContentPresenter HorizontalAlignment=\"Center\" VerticalAlignment=\"Center\"/></Border><ControlTemplate.Triggers><Trigger Property=\"IsEnabled\" Value=\"False\"><Setter TargetName=\"Chrome\" Property=\"Opacity\" Value=\"0.4\"/></Trigger><Trigger Property=\"IsMouseOver\" Value=\"True\"><Setter TargetName=\"Chrome\" Property=\"Opacity\" Value=\"0.88\"/></Trigger></ControlTemplate.Triggers></ControlTemplate>");
    private static ControlTemplate ChromeTemplate => chromeTemplate ??= Chrome(6);
    private static ControlTemplate PrimaryTemplate => primaryTemplate ??= Chrome(12);
    private static ControlTemplate BareTemplate => bareTemplate ??= (ControlTemplate)XamlReader.Parse($"<ControlTemplate {Namespaces} TargetType=\"Button\"><Border x:Name=\"Chrome\" Background=\"Transparent\"><ContentPresenter/></Border><ControlTemplate.Triggers><Trigger Property=\"IsEnabled\" Value=\"False\"><Setter TargetName=\"Chrome\" Property=\"Opacity\" Value=\"0.4\"/></Trigger><Trigger Property=\"IsMouseOver\" Value=\"True\"><Setter TargetName=\"Chrome\" Property=\"Opacity\" Value=\"0.9\"/></Trigger></ControlTemplate.Triggers></ControlTemplate>");

    public static TextBlock Text(string text, double size, Brush? color = null, FontWeight? weight = null, Thickness? margin = null)
        => new() { Text = text, FontSize = size, Foreground = color ?? Ink, FontWeight = weight ?? FontWeights.Normal, TextWrapping = TextWrapping.Wrap, Margin = margin ?? new Thickness(0) };
    public static TextBlock Glyph(string glyph, double size, Brush? color = null) => new() { Text = glyph, FontFamily = Icons, FontSize = size, Foreground = color ?? Ink, VerticalAlignment = VerticalAlignment.Center };
    private static UIElement Label(string text, string? glyph, Brush color, FontWeight weight)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        if (glyph is not null) { var icon = Glyph(glyph, 13, color); icon.Margin = new Thickness(0, 0, 6, 0); line.Children.Add(icon); }
        line.Children.Add(new TextBlock { Text = text, FontSize = 13, FontWeight = weight, Foreground = color, VerticalAlignment = VerticalAlignment.Center }); return line;
    }
    private static Button Chrome(string text, string? glyph, Brush fill, Brush foreground, Action click, bool primary = false)
    {
        var button = new Button { Style = null, Template = primary ? PrimaryTemplate : ChromeTemplate, Background = fill, Foreground = foreground, Padding = primary ? new Thickness(16, 11, 16, 11) : new Thickness(14, 5, 14, 5), Margin = new Thickness(0), HorizontalAlignment = primary ? HorizontalAlignment.Stretch : HorizontalAlignment.Left, Cursor = System.Windows.Input.Cursors.Hand, Content = Label(text, glyph, foreground, primary ? FontWeights.SemiBold : FontWeights.Normal) };
        System.Windows.Automation.AutomationProperties.SetName(button, text); button.Click += (_, _) => click(); return button;
    }
    // bellPrimary: violet, semibold, 12 pt corners, as wide as its column.
    public static Button Primary(string text, Action click, string? glyph = null) => Chrome(text, glyph, Violet, Brushes.White, click, primary: true);
    // The label (and the icon, when given) of a Chrome button changes in place; its accessible name follows.
    public static void Relabel(Button button, string text, string? glyph = null)
    {
        if (button.Content is StackPanel line && line.Children[^1] is TextBlock label) label.Text = text;
        if (glyph is not null && button.Content is StackPanel { Children.Count: 2 } icon) ((TextBlock)icon.Children[0]).Text = glyph;
        System.Windows.Automation.AutomationProperties.SetName(button, text);
    }
    // borderedProminent
    public static Button Prominent(string text, Action click, string? glyph = null) => Chrome(text, glyph, ProminentFill, Brushes.White, click);
    // the default (bordered) Mac button
    public static Button Bordered(string text, Action click, string? glyph = null) => Chrome(text, glyph, ButtonFill, Ink, click);
    // A button that only adds the click and the disabled look to its content (the Mac Button { label } form).
    public static Button Bare(UIElement content, Action click, string name)
    {
        var button = new Button { Style = null, Template = BareTemplate, Margin = new Thickness(0), Padding = new Thickness(0), HorizontalContentAlignment = HorizontalAlignment.Stretch, Cursor = System.Windows.Input.Cursors.Hand, Content = content };
        System.Windows.Automation.AutomationProperties.SetName(button, name); button.Click += (_, _) => click(); return button;
    }
    // A text link such as the Mac Link.
    public static Button Link(string text, Action click)
    {
        var button = Bare(new TextBlock { Text = text, FontSize = 13, Foreground = Violet }, click, text); button.HorizontalAlignment = HorizontalAlignment.Left; return button;
    }
    // bellCard(): white at 91 %, a 24 pt corner, a faint line and a soft shadow.
    public static Border Card(UIElement child, Thickness padding)
        => new() { Child = child, Padding = padding, CornerRadius = new CornerRadius(24), Background = new SolidColorBrush(Color.FromArgb(0xE8, 255, 255, 255)), BorderBrush = new SolidColorBrush(Color.FromArgb(0xA6, 0xE5, 0xE3, 0xF0)), BorderThickness = new Thickness(1), Effect = new DropShadowEffect { Color = Color.FromRgb(0x21, 0x29, 0x3D), Opacity = 0.035, BlurRadius = 16, ShadowDepth = 8, Direction = 270 } };
    public static void OpenUrl(Uri address, Action<string> failed)
    {
        try { Process.Start(new ProcessStartInfo(address.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception error) { failed("ブラウザーを開けませんでした。" + error.Message); }
    }
}

// Mac BellBackground: a violet-to-white diagonal wash and one soft violet disc.
internal class StartupBackdrop : Grid
{
    public StartupBackdrop()
    {
        ClipToBounds = true;
        Background = Wash();
        Children.Add(new System.Windows.Shapes.Ellipse { Width = 380, Height = 380, Fill = new SolidColorBrush(Color.FromArgb(20, 0x61, 0x47, 0xD4)), Effect = new BlurEffect { Radius = 65 }, RenderTransform = new TranslateTransform(170, -330), IsHitTestVisible = false });
    }
    public static Brush Wash() => new LinearGradientBrush([new GradientStop(Color.FromRgb(0xEC, 0xE6, 0xFE), 0), new GradientStop(Color.FromRgb(0xF8, 0xF8, 0xFB), 0.5), new GradientStop(Colors.White, 1)], new Point(0, 0), new Point(1, 1));
    protected static ScrollViewer Scroll(StackPanel column, double maxWidth, Thickness margin)
    {
        column.MaxWidth = maxWidth; column.Margin = margin; column.HorizontalAlignment = HorizontalAlignment.Center;
        return new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Content = column };
    }
    protected static Image Portrait(double side, double radius)
    {
        var image = new Image { Source = EmbeddedAsset.Portrait((int)(side * 2)), Stretch = Stretch.UniformToFill, Width = side, Height = side, HorizontalAlignment = HorizontalAlignment.Left };
        RoundClip.Apply(image, radius); return image;
    }
}

// Mac RootView .checking.
internal sealed class StartupOpeningView : StartupBackdrop
{
    public StartupOpeningView()
    {
        var stack = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        stack.Children.Add(new Spinner { Width = 20, Height = 20, Stroke = MacUi.Secondary, HorizontalAlignment = HorizontalAlignment.Center });
        stack.Children.Add(MacUi.Text("BellTeamを開いています", 11, MacUi.Secondary, margin: new Thickness(0, 8, 0, 0)));
        Children.Add(stack);
    }
}

// Mac ConnectionFailureView: what happened in plain words, where we tried and the two ways out; the raw error is folded under 「詳細」.
// 「もう一度試す」 keeps this page and reads 「接続しています…」 until the attempt ends; 「接続先を変更」 asks first (confirmChange).
internal sealed class StartupFailureView : StartupBackdrop
{
    private readonly Func<Task> retry;
    private readonly Action changeServer;
    private readonly Func<bool> confirmChange;
    private readonly Button again, change;
    private bool retrying;
    public StartupFailureView(string? message, string? host, Func<Task> retry, Action changeServer, Func<bool> confirmChange)
    {
        this.retry = retry; this.changeServer = changeServer; this.confirmChange = confirmChange;
        var stack = new StackPanel();
        var tile = new Grid { HorizontalAlignment = HorizontalAlignment.Center, Width = 64, Height = 64 };
        tile.Children.Add(SettingsUi.Tile("\uE701", Color.FromRgb(0xFF, 0x95, 0x00), 64));
        tile.Children.Add(new TextBlock { Text = "!", FontSize = 20, FontWeight = FontWeights.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(0, 0, 14, 8) });
        stack.Children.Add(tile);
        var title = MacUi.Text("BellTeamにつながりません", 22, MacUi.Ink, FontWeights.Bold, new Thickness(0, 18, 0, 0)); title.TextAlignment = TextAlignment.Center; stack.Children.Add(title);
        var hint = MacUi.Text("サーバーが動いているか、この端末が同じネットワークにいるかを確かめてから、もう一度試してください。", 14, MacUi.Muted, margin: new Thickness(0, 8, 0, 0)); hint.TextAlignment = TextAlignment.Center; stack.Children.Add(hint);
        if (!string.IsNullOrEmpty(host))
        {
            var server = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 8, 0, 0) };
            var icon = MacUi.Glyph("\uE774", 12, MacUi.Muted); icon.Margin = new Thickness(0, 0, 6, 0); server.Children.Add(icon);
            server.Children.Add(new TextBlock { Text = "接続先 " + host, FontSize = 12, Foreground = MacUi.Muted, VerticalAlignment = VerticalAlignment.Center }); stack.Children.Add(server);
        }
        again = MacUi.Primary("もう一度試す", Retry); again.Margin = new Thickness(0, 18, 0, 0); stack.Children.Add(again);
        change = MacUi.Bordered("接続先を変更", () => { if (confirmChange()) changeServer(); }); change.HorizontalAlignment = HorizontalAlignment.Center; change.Margin = new Thickness(0, 10, 0, 0); stack.Children.Add(change);
        if (!string.IsNullOrEmpty(message))
        {
            var detail = new TextBox { Text = message, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontSize = 12, Foreground = MacUi.Secondary, BorderThickness = new Thickness(0), Background = Brushes.Transparent, Padding = new Thickness(0) };
            var disclosure = TerminalParts.Disclosure("詳細", detail, false, _ => { }); disclosure.Margin = new Thickness(10, 14, 10, 0); stack.Children.Add(disclosure);
        }
        var card = MacUi.Card(stack, new Thickness(28)); card.MaxWidth = 460; card.Margin = new Thickness(24); card.HorizontalAlignment = HorizontalAlignment.Center; card.VerticalAlignment = VerticalAlignment.Center;
        Children.Add(card);
    }
    private void Retry() { if (!retrying) _ = RetryAsync(); }
    private async Task RetryAsync()
    {
        retrying = true; again.IsEnabled = change.IsEnabled = false; MacUi.Relabel(again, "接続しています…");
        try { await retry(); }
        finally { retrying = false; again.IsEnabled = change.IsEnabled = true; MacUi.Relabel(again, "もう一度試す"); }
    }
}

// Mac ServerSetupView.
internal sealed class ServerSetupView : StartupBackdrop
{
    private readonly Action<string> connect;
    private readonly TextBox address = new() { Style = null, Background = Brushes.Transparent, BorderThickness = new Thickness(0), Padding = new Thickness(0), FontSize = 13, VerticalContentAlignment = VerticalAlignment.Center };
    private readonly TextBlock error = MacUi.Text("", 10, MacUi.Red, margin: new Thickness(0, 22, 0, 0));
    public string Address { get => address.Text; set => address.Text = value; }
    public string? ErrorText => error.Visibility == Visibility.Visible ? error.Text : null;
    // connect validates and starts the connection; a thrown error is shown under the field (the Mac errorText).
    public ServerSetupView(Action<string> connect, Action openGuide, string initial = "")
    {
        this.connect = connect; address.Text = initial; error.Visibility = Visibility.Collapsed;
        var column = new StackPanel();
        column.Children.Add(Portrait(106, 30));
        column.Children.Add(MacUi.Text("BellTeamを始める", 37, MacUi.Ink, FontWeights.Bold, new Thickness(0, 22, 0, 0)));
        column.Children.Add(MacUi.Text("自分のPCやサーバーでBellTeamを動かし、このアプリから接続して使います。", 13, MacUi.Muted, margin: new Thickness(0, 22, 0, 0)));
        var guide = new Grid(); guide.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); guide.ColumnDefinitions.Add(new ColumnDefinition()); guide.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var box = MacUi.Glyph("", 17); box.Margin = new Thickness(0, 0, 16, 0); guide.Children.Add(box);
        var words = new StackPanel { VerticalAlignment = VerticalAlignment.Center }; words.Children.Add(MacUi.Text("はじめて使う", 13, MacUi.Ink, FontWeights.Bold)); words.Children.Add(MacUi.Text("Dockerの準備からアプリへの接続まで", 11, MacUi.Ink, margin: new Thickness(0, 6, 0, 0)));
        Grid.SetColumn(words, 1); guide.Children.Add(words);
        var chevron = MacUi.Glyph("", 12); Grid.SetColumn(chevron, 2); guide.Children.Add(chevron);
        var guideButton = MacUi.Bare(MacUi.Card(guide, new Thickness(20)), openGuide, "はじめて使う"); guideButton.Margin = new Thickness(0, 22, 0, 0);
        System.Windows.Automation.AutomationProperties.SetAutomationId(guideButton, "server-installation-guide"); column.Children.Add(guideButton);
        column.Children.Add(MacUi.Text("サーバーを用意済みの方", 13, MacUi.Ink, FontWeights.Bold, new Thickness(0, 30, 0, 0)));
        column.Children.Add(MacUi.Text("同じマシンならhttp://localhost:18891、iPhone・iPadならLAN上のBellTeamのURLを入力してください。外部接続はHTTPSを使います。", 13, MacUi.Muted, margin: new Thickness(0, 22, 0, 0)));
        var field = new Grid(); var placeholder = MacUi.Text("BellTeamの接続先URL", 13, new SolidColorBrush(Color.FromRgb(0xC4, 0xC4, 0xC8))); placeholder.IsHitTestVisible = false; placeholder.VerticalAlignment = VerticalAlignment.Center;
        field.Children.Add(address); field.Children.Add(placeholder);
        void ShowPlaceholder() => placeholder.Visibility = address.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        address.TextChanged += (_, _) => ShowPlaceholder(); ShowPlaceholder();
        System.Windows.Automation.AutomationProperties.SetName(address, "BellTeamの接続先URL"); System.Windows.Automation.AutomationProperties.SetAutomationId(address, "server-address");
        address.KeyDown += (_, args) => { if (args.Key == System.Windows.Input.Key.Enter) { args.Handled = true; Continue(); } };
        var card = MacUi.Card(field, new Thickness(18)); card.Margin = new Thickness(0, 22, 0, 0); column.Children.Add(card);
        column.Children.Add(error);
        var go = new Grid { Height = 60 }; var arrow = MacUi.Glyph("", 15, Brushes.White); arrow.HorizontalAlignment = HorizontalAlignment.Right;
        var label = MacUi.Text("続ける", 17, Brushes.White, FontWeights.SemiBold); label.VerticalAlignment = VerticalAlignment.Center; go.Children.Add(label); go.Children.Add(arrow);
        var fill = new Border { Child = go, Background = MacUi.ProminentFill, CornerRadius = new CornerRadius(20), Padding = new Thickness(23, 0, 23, 0) };
        // The Mac screenshot shows the default button's grey plate behind the custom label.
        var plate = new Border { Child = MacUi.Bare(fill, Continue, "続ける"), Background = MacUi.ButtonFill, CornerRadius = new CornerRadius(6), Padding = new Thickness(12, 4, 12, 4), Margin = new Thickness(0, 22, 0, 0) };
        column.Children.Add(plate);
        Children.Add(Scroll(column, 460, new Thickness(30, 68, 30, 40)));
    }
    public void Continue()
    {
        error.Visibility = Visibility.Collapsed;
        try { connect(address.Text); }
        catch (Exception failure) { error.Text = failure.Message; error.Visibility = Visibility.Visible; }
    }
}

// Mac ServerInstallationGuide, shown in the shared sheet titled 「サーバーの導入ガイド」.
// Windows has no share sheet: the Mac "share" buttons become "open the repository in the browser" and "copy the guide URL" (and the wash is the Mac BellBackground).
internal sealed class ServerGuideView : ScrollViewer
{
    public static string AiRequest => EmbeddedAsset.ProductUrl("repositoryUrl").AbsoluteUri + "\nこれセットアップしたい";
    private readonly Action<string> copy;
    private readonly Action<Uri> open;
    private readonly Button copyRequest;
    private readonly Button copyGuide;
    private readonly TextBlock failure = MacUi.Text("", 10, MacUi.Red, margin: new Thickness(0, 8, 0, 0));
    public string CopyRequestLabel => (string)System.Windows.Automation.AutomationProperties.GetName(copyRequest);
    public ServerGuideView(Action<string>? copy = null, Action<Uri>? open = null)
    {
        this.copy = copy ?? (text => Clipboard.SetText(text)); this.open = open ?? (address => MacUi.OpenUrl(address, Fail));
        failure.Visibility = Visibility.Collapsed;
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto; HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled;
        Background = StartupBackdrop.Wash();
        var column = new StackPanel { MaxWidth = 720, Margin = new Thickness(24), HorizontalAlignment = HorizontalAlignment.Center };
        // The card: icon tile and caption, then the copy button; Windows has no share sheet, so 「GitHubをブラウザーで開く」 stands where the Mac 「共有」 is.
        var intro = new StackPanel();
        var head = new Grid(); head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); head.ColumnDefinitions.Add(new ColumnDefinition());
        head.Children.Add(SettingsUi.Tile("\u2726", Color.FromRgb(0x61, 0x47, 0xD4), 40, symbol: true));
        var words = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(12, 0, 0, 0) }; Grid.SetColumn(words, 1);
        words.Children.Add(MacUi.Text("AIにセットアップを任せる", 15, MacUi.Ink, FontWeights.Bold)); words.Children.Add(MacUi.Text("GitHubのURLと依頼文を、PCを操作できるAIへ渡します。", 13, MacUi.Muted, margin: new Thickness(0, 2, 0, 0)));
        head.Children.Add(words); intro.Children.Add(head);
        var actions = new Grid { Margin = new Thickness(0, 14, 0, 0) }; actions.ColumnDefinitions.Add(new ColumnDefinition()); actions.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        copyRequest = MacUi.Primary("URLと依頼文をコピー", () => Copy(AiRequest, copyRequest!), "\uE8C8");
        System.Windows.Automation.AutomationProperties.SetAutomationId(copyRequest, "server-ai-request-copy"); actions.Children.Add(copyRequest);
        var repository = MacUi.Bordered("GitHubをブラウザーで開く", () => this.open(EmbeddedAsset.ProductUrl("repositoryUrl")), "\uE8A7"); repository.Margin = new Thickness(10, 0, 0, 0); repository.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(repository, 1); actions.Children.Add(repository);
        intro.Children.Add(actions); column.Children.Add(MacUi.Card(intro, new Thickness(18)));
        column.Children.Add(failure);
        var body = new MarkdownView { FontSize = 18, Source = EmbeddedAsset.Text("server-installation.md"), Margin = new Thickness(0, 22, 0, 0) };
        System.Windows.Automation.AutomationProperties.SetAutomationId(body, "server-installation-content"); column.Children.Add(body);
        var pc = MacUi.Primary("PCで読む手順と配布ファイルを開く", () => this.open(EmbeddedAsset.ProductUrl("serverGuideUrl"))); pc.Margin = new Thickness(0, 22, 0, 0); column.Children.Add(pc);
        copyGuide = MacUi.Bordered("この手順のURLをコピー", () => Copy(EmbeddedAsset.ProductUrl("serverGuideUrl").AbsoluteUri, copyGuide!), "\uE8C8"); copyGuide.Margin = new Thickness(0, 12, 0, 0); column.Children.Add(copyGuide);
        Content = column;
    }
    private void Fail(string message) { failure.Text = message; failure.Visibility = Visibility.Visible; }
    // Mac: the label becomes 「コピーしました」 after the copy. A clipboard that cannot be written is shown, not hidden.
    private void Copy(string text, Button button)
    {
        try { copy(text); failure.Visibility = Visibility.Collapsed; }
        catch (Exception error) { Fail("コピーできませんでした。" + error.Message); return; }
        MacUi.Relabel(button, "コピーしました", "\uE73E");
    }
}

// Mac LoginView.
internal sealed class LoginView : StartupBackdrop
{
    private readonly TextBlock error = MacUi.Text("", 10, MacUi.Red, margin: new Thickness(0, 8, 0, 0));
    public LoginView(Action openLogin)
    {
        error.Visibility = Visibility.Collapsed; error.TextAlignment = TextAlignment.Center;
        var frame = new Grid { MaxWidth = 520, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(30, 40, 30, 40) };
        frame.RowDefinitions.Add(new RowDefinition()); frame.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var middle = new StackPanel { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
        var glow = new Grid { Width = 290, Height = 290, Margin = new Thickness(0, 0, 0, 42) };
        glow.Children.Add(new System.Windows.Shapes.Ellipse { Width = 290, Height = 290, Fill = new SolidColorBrush(Color.FromArgb(41, 0x61, 0x47, 0xD4)), Effect = new BlurEffect { Radius = 45 } });
        var portrait = Portrait(176, 48); portrait.HorizontalAlignment = HorizontalAlignment.Center;
        glow.Children.Add(new Border { Width = 182, Height = 182, CornerRadius = new CornerRadius(51), BorderBrush = Brushes.White, BorderThickness = new Thickness(3), Child = portrait, Effect = new DropShadowEffect { Color = Color.FromRgb(0x61, 0x47, 0xD4), Opacity = 0.22, BlurRadius = 30, ShadowDepth = 17, Direction = 270 } });
        middle.Children.Add(glow);
        var title = MacUi.Text("BellTeam", 48, MacUi.Ink, FontWeights.Bold); title.TextAlignment = TextAlignment.Center; middle.Children.Add(title);
        var tagline = MacUi.Text("いつでも、あなたのチームと。", 17, MacUi.Muted, FontWeights.Medium, new Thickness(0, 12, 0, 0)); tagline.TextAlignment = TextAlignment.Center; middle.Children.Add(tagline);
        frame.Children.Add(middle);
        var bottom = new StackPanel(); Grid.SetRow(bottom, 1);
        var row = new Grid { Height = 60 }; var lockIcon = MacUi.Glyph("", 17, Brushes.White); lockIcon.HorizontalAlignment = HorizontalAlignment.Left;
        var text = MacUi.Text("ログインして始める", 17, Brushes.White, FontWeights.SemiBold); text.Margin = new Thickness(26, 0, 0, 0); text.VerticalAlignment = VerticalAlignment.Center;
        var arrow = MacUi.Glyph("", 15, Brushes.White); arrow.HorizontalAlignment = HorizontalAlignment.Right; row.Children.Add(lockIcon); row.Children.Add(text); row.Children.Add(arrow);
        var fill = new Border { Child = row, Background = MacUi.ProminentFill, CornerRadius = new CornerRadius(20), Padding = new Thickness(23, 0, 23, 0), Effect = new DropShadowEffect { Color = Color.FromRgb(0x61, 0x47, 0xD4), Opacity = 0.22, BlurRadius = 16, ShadowDepth = 8, Direction = 270 } };
        bottom.Children.Add(MacUi.Bare(fill, openLogin, "ログインして始める"));
        var caption = MacUi.Text("Cloudflare Accessで安全に接続します", 10, MacUi.Muted, margin: new Thickness(0, 18, 0, 0)); caption.TextAlignment = TextAlignment.Center; bottom.Children.Add(caption);
        bottom.Children.Add(error); frame.Children.Add(bottom); Children.Add(frame);
    }
    public void ShowError(string message) { error.Text = message; error.Visibility = Visibility.Visible; }
}
