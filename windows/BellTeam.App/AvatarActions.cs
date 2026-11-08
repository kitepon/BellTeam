using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using BellTeam.Core;
using Microsoft.Win32;

namespace BellTeam.App;

// The in-window sheet a sheet host (MainWindow) shows over the conversation; the inspector and the image actions open their sheets through it.
public interface IInspectorHost
{
    void OpenSheet(string title, UIElement content);
    void CloseSheet();
    Window? OwnerWindow { get; }
}

// Mac BotProfileAvatarActions: the 小画像 / 大画像 sheet. 画像変更 picks a file and crops it, 画像調整 re-crops the current (or kept) image;
// the save itself runs in AvatarImageSession and reports in the inspector.
public sealed class AvatarActionsView : Grid, IDisposable
{
    private readonly Workspace workspace;
    private readonly Bot bot;
    private readonly ConversationEntry entry;
    private readonly AvatarVariant variant;
    private readonly AvatarImageSession session;
    private readonly IInspectorHost host;
    private readonly CancellationTokenSource lifetime;
    private AvatarProfile? settings;
    private bool loading, unsupported;
    private string? errorText;
    private BitmapSource? previewImage;
    private bool previewFailed;
    private string? previewKey;
    public event Action? BusyChanged;
    public bool Busy => session.Saving;
    // The first preview (current image or kept selection) has been looked up.
    public Task Ready { get; private set; } = Task.CompletedTask;
    public AvatarActionsView(Workspace workspace, ConversationEntry entry, AvatarVariant variant, AvatarImageSession session, IInspectorHost host)
    {
        this.workspace = workspace; this.entry = entry; bot = entry.Bot ?? throw new ArgumentException("メンバーを選んでください。"); this.variant = variant; this.session = session; this.host = host;
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(workspace.ConnectionToken);
        Background = (Brush)Application.Current.FindResource("ConversationBackground");
        session.Changed += Changed; Rebuild();
    }
    public void Dispose() { session.Changed -= Changed; lifetime.Cancel(); lifetime.Dispose(); }
    private void Changed() { BusyChanged?.Invoke(); Rebuild(); }

    private static readonly Brush Muted = (Brush)Application.Current.FindResource("Muted");
    private static readonly Brush Red = new SolidColorBrush(Color.FromRgb(255, 59, 48));
    private AvatarSelection? Pending => session.Pending(variant);

    private void Rebuild()
    {
        var column = new StackPanel { Width = 340, Margin = new Thickness(24), VerticalAlignment = VerticalAlignment.Top, HorizontalAlignment = HorizontalAlignment.Center, IsEnabled = !session.Saving };
        void Add(UIElement element) { if (column.Children.Count != 0 && element is FrameworkElement item) item.Margin = new Thickness(0, 20, 0, 0); column.Children.Add(element); }
        Add(PreviewBox());
        var pending = Pending;
        var change = InspectorUi.Prominent("画像変更"); change.IsEnabled = !(loading || unsupported || pending is not null); change.Click += async (_, _) => await ChangeAsync();
        System.Windows.Automation.AutomationProperties.SetAutomationId(change, "profile-image-change"); Add(change);
        var adjust = InspectorUi.Bordered("画像調整", wide: true); adjust.IsEnabled = !(loading || unsupported); adjust.Click += async (_, _) => await AdjustAsync();
        System.Windows.Automation.AutomationProperties.SetAutomationId(adjust, "profile-image-adjust"); Add(adjust);
        if (loading) Add(InspectorUi.Progress("画像情報を確認しています…"));
        if (session.Error(variant) is { } status) Add(InspectorUi.Note(status, Red));
        if (pending is not null)
        {
            Add(InspectorUi.Note(BotProfileText.PendingKept, Muted));
            var confirm = InspectorUi.Bordered("保存結果を確認", wide: true); confirm.Click += async (_, _) => { if (await session.ConfirmAsync(workspace.Management, bot.Id, variant, version => workspace.AvatarVersion(bot.Id, version), workspace.RefreshForImageAsync, workspace.ConnectionToken)) host.CloseSheet(); }; Add(confirm);
            var discard = InspectorUi.Bordered("選択を破棄", wide: true, destructive: true); discard.Click += (_, _) => session.Discard(variant); Add(discard);
            Add(InspectorUi.Note(BotProfileText.ChangeBlocked, Muted));
        }
        if (settings is not null && pending is null && settings.AdjustmentImage(variant).Source.Length == 0) Add(InspectorUi.Note(BotProfileText.NoSourceNote, Muted));
        if (settings is null && errorText is not null) { var reload = InspectorUi.Bordered("画像情報を再読込", wide: true); reload.Click += async (_, _) => await LoadSettingsAsync(); Add(reload); }
        if (errorText is not null) Add(InspectorUi.Note(errorText, Red));
        Children.Clear(); Children.Add(new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Content = column });
        var key = pending?.Render ?? "current";
        if (key != previewKey) { previewKey = key; previewImage = null; previewFailed = false; Ready = LoadPreviewAsync(key, pending); }
    }

    private UIElement PreviewBox()
    {
        const double side = 220;
        var radius = variant == AvatarVariant.Small ? side * .31 : 20;
        var accent = BellColors.Accent(bot.Color);
        var box = new Border { Width = side, Height = side, CornerRadius = new CornerRadius(radius), HorizontalAlignment = HorizontalAlignment.Center, Background = new LinearGradientBrush(Color.FromArgb(190, accent.R, accent.G, accent.B), accent, 45) };
        if (previewImage is not null) box.Background = new ImageBrush(previewImage) { Stretch = Stretch.UniformToFill };
        else if (previewFailed) box.Child = new TextBlock { Text = System.Globalization.StringInfo.GetNextTextElement(bot.Name.Length == 0 ? "B" : bot.Name), FontSize = 72, FontWeight = FontWeights.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        System.Windows.Automation.AutomationProperties.SetName(box, previewImage is null ? "画像の表示待ち" : variant == AvatarVariant.Small ? "現在の小画像" : "現在の大画像");
        System.Windows.Automation.AutomationProperties.SetAutomationId(box, "profile-image-preview-" + (variant == AvatarVariant.Small ? "small" : "large"));
        return box;
    }

    private async Task LoadPreviewAsync(string key, AvatarSelection? pending)
    {
        try
        {
            BitmapSource? image = null;
            if (pending is not null) image = await DecodeAsync(pending.Render);
            else
            {
                var url = variant == AvatarVariant.Large && !bot.UsesSmallImage ? entry.LargeAvatarUrl : entry.AvatarUrl;
                if (url is not null) image = await workspace.AvatarAsync(url);
            }
            if (previewKey != key || lifetime.IsCancellationRequested) return;
            previewImage = image; Rebuild();
        }
        catch (Exception) { if (previewKey == key) { previewFailed = true; Rebuild(); } }
    }

    private static async Task<BitmapSource> DecodeAsync(string dataUrl)
    {
        var comma = dataUrl.IndexOf(',');
        if (comma < 0 || !dataUrl.StartsWith("data:image/", StringComparison.Ordinal)) throw new InvalidDataException("画像の形式が一致しません。");
        return await ImageCodec.DecodeAsync(Convert.FromBase64String(dataUrl[(comma + 1)..]));
    }

    // Mac loadSettings: read the stored image fields once; an older server without them cannot edit the two images apart.
    public async Task<bool> LoadSettingsAsync()
    {
        if (session.Saving || lifetime.IsCancellationRequested) return false;
        if (settings is not null) return true;
        if (loading) return false;
        loading = true; Rebuild();
        try
        {
            var profile = await workspace.Management.GetAvatarProfileAsync(bot.Id, lifetime.Token);
            if (session.Saving || lifetime.IsCancellationRequested) return false;
            if (!profile.SupportsIndependentImages) { errorText = BotProfileText.UnsupportedServer; unsupported = true; return false; }
            settings = profile; unsupported = false; errorText = null; return true;
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { return false; }
        catch (BellApiException error) when (error.RequiresLogin) { return false; }
        catch (Exception error) { if (!session.Saving && !lifetime.IsCancellationRequested) errorText = "画像情報を読み込めませんでした。\n" + error.Message; return false; }
        finally { loading = false; if (!lifetime.IsCancellationRequested) Rebuild(); }
    }

    private async Task ChangeAsync()
    {
        if (!await LoadSettingsAsync()) return;
        var dialog = new OpenFileDialog { Filter = "画像|*.png;*.jpg;*.jpeg;*.webp;*.gif", Title = variant.Label() + "を選ぶ" };
        if (dialog.ShowDialog(host.OwnerWindow) != true) return;
        try { Crop((await ImageCodec.ReadAsync(dialog.FileName)).Preview, null); }
        catch (Exception) { errorText = "画像を読み込めませんでした。"; Rebuild(); }
    }

    private async Task AdjustAsync()
    {
        if (!await LoadSettingsAsync() || settings is null) return;
        string data; AvatarCropRect? initial;
        if (Pending is { } kept) { data = kept.Source; initial = kept.Crop; }
        else { var current = settings.AdjustmentImage(variant); data = current.Source.Length == 0 ? current.Render : current.Source; initial = current.Source.Length == 0 ? null : current.Crop; }
        try { Crop(await DecodeAsync(data), initial); }
        catch (Exception) { errorText = Pending is not null ? "保持中の画像を読み込めませんでした。" : "画像を読み込めませんでした。"; Rebuild(); }
    }

    // The crop editor is the existing window; "使用する" closes this sheet and the save reports in the inspector, as on the Mac.
    private void Crop(BitmapSource image, AvatarCropRect? initial)
    {
        var window = new AvatarCropWindow(image, variant, initial, wantsSelection: true) { Owner = host.OwnerWindow };
        if (window.ShowDialog() != true || window.Selection is not { } selection) return;
        host.CloseSheet();
        _ = session.SaveAsync(workspace.Management, bot.Id, variant, selection, version => workspace.AvatarVersion(bot.Id, version), workspace.RefreshForImageAsync, workspace.ConnectionToken);
    }
}
