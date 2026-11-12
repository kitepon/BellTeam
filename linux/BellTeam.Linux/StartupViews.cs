using Avalonia.Automation;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Input.Platform;
using Avalonia.Media.Imaging;

namespace BellTeam.Linux;

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
    public static Bitmap Portrait(int pixelWidth) { using var stream = Open("BellPortrait.png"); return Bitmap.DecodeToWidth(stream, pixelWidth); }
}

// Mac catalyst controls and BellTheme pieces used by the full-window screens.
internal static class MacUi
{
    public static TextBlock Text(string text, double size, IBrush? color = null, FontWeight weight = FontWeight.Normal, Thickness? margin = null) => BellTheme.Text(text, size, color, weight, margin);
    private static Control Label(string text, string? icon, IBrush color)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Spacing = 6 };
        if (icon is not null) line.Children.Add(Icons.Draw(icon, 14, color));
        line.Children.Add(new TextBlock { Text = text, FontSize = 13, FontWeight = FontWeight.Normal, Foreground = color, VerticalAlignment = VerticalAlignment.Center });
        return line;
    }
    private static Button Chrome(string text, string? icon, IBrush fill, IBrush foreground, Action click)
    {
        var button = new Button { Classes = { "plain" }, Background = fill, Foreground = foreground, Padding = new Thickness(14, 5), CornerRadius = new CornerRadius(6), HorizontalAlignment = HorizontalAlignment.Left, Content = Label(text, icon, foreground) };
        AutomationProperties.SetName(button, text); button.Click += (_, _) => click(); return button;
    }
    // borderedProminent
    public static Button Prominent(string text, Action click, string? icon = null) => Chrome(text, icon, BellTheme.ProminentFill, Brushes.White, click);
    // the default (bordered) Mac button
    public static Button Bordered(string text, Action click, string? icon = null) => Chrome(text, icon, BellTheme.ButtonFill, BellTheme.Ink, click);
    // A button that only adds the click and the disabled look to its content (the Mac Button { label } form).
    public static Button Bare(Control content, Action click, string name)
    {
        var button = new Button { Classes = { "plain" }, Background = Brushes.Transparent, Padding = default, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Content = content };
        AutomationProperties.SetName(button, name); button.Click += (_, _) => click(); return button;
    }
    // A text link such as the Mac Link.
    public static Button Link(string text, Action click)
    {
        var button = Bare(new TextBlock { Text = text, FontSize = 13, Foreground = BellTheme.Violet }, click, text); button.HorizontalAlignment = HorizontalAlignment.Left; return button;
    }
    // bellCard(): white at 91 %, a 24 pt corner, a faint line and a soft shadow.
    public static Border Card(Control child, Thickness padding) => new()
    {
        Child = child, Padding = padding, CornerRadius = new CornerRadius(24), Background = new SolidColorBrush(Color.FromArgb(0xE8, 255, 255, 255)), BorderBrush = new SolidColorBrush(Color.FromArgb(0xA6, 0xE5, 0xE3, 0xF0)), BorderThickness = new Thickness(1),
        BoxShadow = BoxShadows.Parse("0 8 16 0 #09000000")
    };
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
        Background = new LinearGradientBrush
        {
            StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative), EndPoint = new RelativePoint(1, 1, RelativeUnit.Relative),
            GradientStops = [new GradientStop(Color.FromRgb(0xEC, 0xE6, 0xFE), 0), new GradientStop(Color.FromRgb(0xF8, 0xF8, 0xFB), .5), new GradientStop(Colors.White, 1)]
        };
        Children.Add(new Avalonia.Controls.Shapes.Ellipse { Width = 380, Height = 380, Fill = new SolidColorBrush(Color.FromArgb(20, 0x61, 0x47, 0xD4)), Effect = new BlurEffect { Radius = 65 }, RenderTransform = new TranslateTransform(170, -330), IsHitTestVisible = false });
    }
    protected static ScrollViewer Scroll(StackPanel column, double maxWidth, Thickness margin)
    {
        column.MaxWidth = maxWidth; column.Margin = margin; column.HorizontalAlignment = HorizontalAlignment.Center;
        return new ScrollViewer { VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled, Content = column };
    }
    protected static Border Portrait(double side, double radius) => Round.Clip(new Image { Source = EmbeddedAsset.Portrait((int)(side * 2)), Stretch = Stretch.UniformToFill, Width = side, Height = side }, radius);
}

// Mac RootView .checking.
internal sealed class StartupOpeningView : StartupBackdrop
{
    public StartupOpeningView()
    {
        var stack = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        stack.Children.Add(new Spinner(BellTheme.Secondary, 20) { HorizontalAlignment = HorizontalAlignment.Center });
        stack.Children.Add(MacUi.Text("BellTeamを開いています", 11, BellTheme.Secondary, margin: new Thickness(0, 8, 0, 0)));
        Children.Add(stack);
    }
}

// Mac RootView .failure(message): ContentUnavailableView with 「もう一度試す」. Windows adds 「接続先を変更」 because the saved address may be the problem.
internal sealed class StartupFailureView : StartupBackdrop
{
    public StartupFailureView(string? message, Action retry, Action changeServer)
    {
        var stack = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, MaxWidth = 460, Margin = new Thickness(30) };
        var icon = Icons.Draw(Icons.Warning, 46, BellTheme.Secondary, thickness: 1.5); icon.HorizontalAlignment = HorizontalAlignment.Center; icon.Margin = new Thickness(0, 0, 0, 10); stack.Children.Add(icon);
        var title = MacUi.Text("接続できませんでした", 17, BellTheme.Ink, FontWeight.Bold); title.TextAlignment = TextAlignment.Center; stack.Children.Add(title);
        if (!string.IsNullOrEmpty(message)) { var detail = MacUi.Text(message, 13, BellTheme.Secondary, margin: new Thickness(0, 6, 0, 0)); detail.TextAlignment = TextAlignment.Center; stack.Children.Add(detail); }
        var actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 18, 0, 0), Spacing = 10 };
        actions.Children.Add(MacUi.Prominent("もう一度試す", retry)); actions.Children.Add(MacUi.Bordered("接続先を変更", changeServer));
        stack.Children.Add(actions); Children.Add(stack);
    }
}

// Mac ServerSetupView.
internal sealed class ServerSetupView : StartupBackdrop
{
    private readonly Action<string> connect;
    private readonly TextBox address = new() { Classes = { "bare" }, FontSize = 13, VerticalContentAlignment = VerticalAlignment.Center, PlaceholderText = "BellTeamの接続先URL" };
    private readonly TextBlock error = MacUi.Text("", 10, BellTheme.Red, margin: new Thickness(0, 22, 0, 0));
    public string Address { get => address.Text ?? ""; set => address.Text = value; }
    public string? ErrorText => error.IsVisible ? error.Text : null;
    // connect validates and starts the connection; a thrown error is shown under the field (the Mac errorText).
    public ServerSetupView(Action<string> connect, Action openGuide, string initial = "")
    {
        this.connect = connect; address.Text = initial; error.IsVisible = false;
        var column = new StackPanel();
        var portrait = Portrait(106, 30); portrait.HorizontalAlignment = HorizontalAlignment.Left; portrait.Width = portrait.Height = 106; column.Children.Add(portrait);
        column.Children.Add(MacUi.Text("BellTeamを始める", 37, BellTheme.Ink, FontWeight.Bold, new Thickness(0, 22, 0, 0)));
        column.Children.Add(MacUi.Text("自分のPCやサーバーでBellTeamを動かし、このアプリから接続して使います。", 13, BellTheme.Muted, margin: new Thickness(0, 22, 0, 0)));
        var guide = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto") };
        var box = Icons.Draw(Icons.Book, 22); box.Margin = new Thickness(0, 0, 16, 0); guide.Children.Add(box);
        var words = new StackPanel { VerticalAlignment = VerticalAlignment.Center }; words.Children.Add(MacUi.Text("はじめて使う", 13, BellTheme.Ink, FontWeight.Bold)); words.Children.Add(MacUi.Text("Dockerの準備からアプリへの接続まで", 11, BellTheme.Ink, margin: new Thickness(0, 6, 0, 0)));
        Grid.SetColumn(words, 1); guide.Children.Add(words);
        var chevron = Icons.Draw(Icons.ChevronRight, 16); Grid.SetColumn(chevron, 2); guide.Children.Add(chevron);
        var guideButton = MacUi.Bare(MacUi.Card(guide, new Thickness(20)), openGuide, "はじめて使う"); guideButton.Margin = new Thickness(0, 22, 0, 0);
        guideButton.Name = "server-installation-guide"; column.Children.Add(guideButton);
        column.Children.Add(MacUi.Text("サーバーを用意済みの方", 13, BellTheme.Ink, FontWeight.Bold, new Thickness(0, 30, 0, 0)));
        column.Children.Add(MacUi.Text("同じマシンならhttp://localhost:18891、iPhone・iPadならLAN上のBellTeamのURLを入力してください。外部接続はHTTPSを使います。", 13, BellTheme.Muted, margin: new Thickness(0, 22, 0, 0)));
        AutomationProperties.SetName(address, "BellTeamの接続先URL"); address.Name = "server-address";
        address.KeyDown += (_, args) => { if (args.Key == Key.Enter) { args.Handled = true; Continue(); } };
        var card = MacUi.Card(address, new Thickness(18)); card.Margin = new Thickness(0, 22, 0, 0); column.Children.Add(card);
        column.Children.Add(error);
        var go = new Grid { Height = 60 }; var arrow = Icons.Draw(Icons.ChevronRight, 18, Brushes.White); arrow.HorizontalAlignment = HorizontalAlignment.Right;
        var label = MacUi.Text("続ける", 17, Brushes.White, FontWeight.SemiBold); label.VerticalAlignment = VerticalAlignment.Center; go.Children.Add(label); go.Children.Add(arrow);
        var fill = new Border { Child = go, Background = BellTheme.ProminentFill, CornerRadius = new CornerRadius(20), Padding = new Thickness(23, 0) };
        // The Mac screenshot shows the default button's grey plate behind the custom label.
        var plate = new Border { Child = MacUi.Bare(fill, Continue, "続ける"), Background = BellTheme.ButtonFill, CornerRadius = new CornerRadius(6), Padding = new Thickness(12, 4), Margin = new Thickness(0, 22, 0, 0) };
        column.Children.Add(plate);
        Children.Add(Scroll(column, 460, new Thickness(30, 68, 30, 40)));
    }
    public void Continue()
    {
        error.IsVisible = false;
        try { connect(Address); }
        catch (Exception failure) { error.Text = failure.Message; error.IsVisible = true; }
    }
}

// Mac ServerInstallationGuide, shown in the shared sheet titled 「サーバーの導入ガイド」.
// Windows has no share sheet: the Mac "share" buttons become "open the repository in the browser" and "copy the guide URL".
internal sealed class ServerGuideView : ScrollViewer
{
    public static string AiRequest => EmbeddedAsset.ProductUrl("repositoryUrl").AbsoluteUri + "\nこれセットアップしたい";
    private readonly Func<string, Task> copy;
    private readonly Action<Uri> open;
    private readonly TextBlock failure = MacUi.Text("", 10, BellTheme.Red, margin: new Thickness(0, 8, 0, 0));
    private readonly TextBlock copyRequestLabel = new() { Text = "GitHubのURLと依頼文をコピー", FontSize = 13, Foreground = Brushes.White };
    private readonly TextBlock copyGuideLabel = new() { Text = "この手順のURLをコピー", FontSize = 13, Foreground = BellTheme.Ink };
    public string CopyRequestLabel => copyRequestLabel.Text ?? "";
    public ServerGuideView(Func<string, Task>? copy = null, Action<Uri>? open = null)
    {
        this.copy = copy ?? new Func<string, Task>(text => TopLevel.GetTopLevel(this)?.Clipboard?.SetTextAsync(text) ?? throw new InvalidOperationException("クリップボードを使えません。"));
        this.open = open ?? (address => MacUi.OpenUrl(address, Fail));
        failure.IsVisible = false;
        VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto; HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled;
        var column = new StackPanel { MaxWidth = 720, Margin = new Thickness(24), HorizontalAlignment = HorizontalAlignment.Center };
        column.Children.Add(MacUi.Text("AIにセットアップを任せる", 13, BellTheme.Ink, FontWeight.Bold));
        var copyRequest = MacUi.Prominent("", () => _ = Copy(AiRequest, copyRequestLabel, "GitHubのURLと依頼文をコピー")); copyRequest.Content = copyRequestLabel; copyRequest.Margin = new Thickness(0, 12, 0, 0);
        copyRequest.Name = "server-ai-request-copy"; column.Children.Add(copyRequest);
        var repository = MacUi.Bordered("GitHubをブラウザーで開く", () => this.open(EmbeddedAsset.ProductUrl("repositoryUrl"))); repository.Margin = new Thickness(0, 12, 0, 0); column.Children.Add(repository);
        column.Children.Add(failure);
        var body = new MarkdownView { FontSize = 18, Margin = new Thickness(0, 22, 0, 0) }; body.Source = EmbeddedAsset.Text("server-installation.md");
        body.Name = "server-installation-content"; column.Children.Add(body);
        var pc = MacUi.Prominent("PCで読む手順と配布ファイルを開く", () => this.open(EmbeddedAsset.ProductUrl("serverGuideUrl"))); pc.Margin = new Thickness(0, 22, 0, 0); column.Children.Add(pc);
        var copyGuide = MacUi.Bordered("", () => _ = Copy(EmbeddedAsset.ProductUrl("serverGuideUrl").AbsoluteUri, copyGuideLabel, "この手順のURLをコピー")); copyGuide.Content = copyGuideLabel; copyGuide.Margin = new Thickness(0, 12, 0, 0); column.Children.Add(copyGuide);
        Content = column;
    }
    private void Fail(string message) { failure.Text = message; failure.IsVisible = true; }
    // Mac: the label becomes 「コピーしました」 after the copy. A clipboard that cannot be written is shown, not hidden.
    private async Task Copy(string text, TextBlock label, string original)
    {
        try { await copy(text); failure.IsVisible = false; }
        catch (Exception error) { Fail("コピーできませんでした。" + error.Message); return; }
        label.Text = "コピーしました";
    }
}

// Mac LoginView. The Cloudflare Access browser login is not ported yet, so the button is shown disabled with the reason.
internal sealed class LoginView : StartupBackdrop
{
    public const string NotAvailableText = "ブラウザーでのログインはLinux版ではまだ使えません。";
    public LoginView(Action changeServer)
    {
        var frame = new Grid { MaxWidth = 520, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(30, 40), RowDefinitions = new RowDefinitions("*,Auto") };
        var middle = new StackPanel { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
        var glow = new Grid { Width = 290, Height = 290, Margin = new Thickness(0, 0, 0, 42) };
        glow.Children.Add(new Avalonia.Controls.Shapes.Ellipse { Width = 290, Height = 290, Fill = new SolidColorBrush(Color.FromArgb(41, 0x61, 0x47, 0xD4)), Effect = new BlurEffect { Radius = 45 } });
        var portrait = Portrait(176, 48);
        glow.Children.Add(new Border { Width = 182, Height = 182, CornerRadius = new CornerRadius(51), BorderBrush = Brushes.White, BorderThickness = new Thickness(3), Child = portrait, BoxShadow = BoxShadows.Parse("0 17 30 0 #386147D4") });
        middle.Children.Add(glow);
        var title = MacUi.Text("BellTeam", 48, BellTheme.Ink, FontWeight.Bold); title.TextAlignment = TextAlignment.Center; middle.Children.Add(title);
        var tagline = MacUi.Text("いつでも、あなたのチームと。", 17, BellTheme.Muted, FontWeight.Medium, new Thickness(0, 12, 0, 0)); tagline.TextAlignment = TextAlignment.Center; middle.Children.Add(tagline);
        frame.Children.Add(middle);
        var bottom = new StackPanel(); Grid.SetRow(bottom, 1);
        var row = new Grid { Height = 60 };
        var lockIcon = Icons.Draw(Icons.Lock, 22, Brushes.White); lockIcon.HorizontalAlignment = HorizontalAlignment.Left;
        var text = MacUi.Text("ログインして始める", 17, Brushes.White, FontWeight.SemiBold); text.Margin = new Thickness(32, 0, 0, 0); text.VerticalAlignment = VerticalAlignment.Center;
        var arrow = Icons.Draw(Icons.ChevronRight, 18, Brushes.White); arrow.HorizontalAlignment = HorizontalAlignment.Right; row.Children.Add(lockIcon); row.Children.Add(text); row.Children.Add(arrow);
        var fill = new Border { Child = row, Background = BellTheme.ProminentFill, CornerRadius = new CornerRadius(20), Padding = new Thickness(23, 0), BoxShadow = BoxShadows.Parse("0 8 16 0 #386147D4") };
        var login = MacUi.Bare(fill, () => { }, "ログインして始める"); login.IsEnabled = false; bottom.Children.Add(login);
        var caption = MacUi.Text("Cloudflare Accessで安全に接続します", 10, BellTheme.Muted, margin: new Thickness(0, 18, 0, 0)); caption.TextAlignment = TextAlignment.Center; bottom.Children.Add(caption);
        var notice = MacUi.Text(NotAvailableText, 11, BellTheme.Red, margin: new Thickness(0, 8, 0, 0)); notice.TextAlignment = TextAlignment.Center; bottom.Children.Add(notice);
        var change = MacUi.Bordered("接続先を変更", changeServer); change.HorizontalAlignment = HorizontalAlignment.Center; change.Margin = new Thickness(0, 14, 0, 0); bottom.Children.Add(change);
        frame.Children.Add(bottom); Children.Add(frame);
    }
}

// Placeholder for the first-setup screen (Mac/Windows OnboardingView): it is not ported yet.
internal sealed class OnboardingPlaceholderView : StartupBackdrop
{
    public const string NotAvailableText = "初期設定はLinux版ではまだ使えません。MacかWindowsのアプリで初期設定を済ませてください。";
    public OnboardingPlaceholderView(Action changeServer)
    {
        var stack = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, MaxWidth = 460, Margin = new Thickness(30) };
        var title = MacUi.Text("初期設定", 17, BellTheme.Ink, FontWeight.Bold); title.TextAlignment = TextAlignment.Center; stack.Children.Add(title);
        var detail = MacUi.Text(NotAvailableText, 13, BellTheme.Secondary, margin: new Thickness(0, 6, 0, 0)); detail.TextAlignment = TextAlignment.Center; stack.Children.Add(detail);
        var change = MacUi.Bordered("接続先を変更", changeServer); change.HorizontalAlignment = HorizontalAlignment.Center; change.Margin = new Thickness(0, 18, 0, 0); stack.Children.Add(change);
        Children.Add(stack);
    }
}
