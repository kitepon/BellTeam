using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using BellTeam.Core;

namespace BellTeam.Linux;

// The in-window sheet a sheet host (MainWindow) shows over the conversation; the inspector and the image actions open their sheets through it.
public interface IInspectorHost
{
    void OpenSheet(string title, Control content);
    void CloseSheet();
    Window? OwnerWindow { get; }
    // Mac: the member editor is a window of its own, the room editor a sheet.
    void EditMember(string id);
    void EditRoom(string id);
    // The crop sheet over whatever is open; null when it is cancelled or the sheet it belongs to goes away.
    Task<AvatarCropOutcome?> CropAsync(Bitmap image, AvatarVariant variant, AvatarCropRect? initialCrop, bool wantsSelection);
}

// Mac BotProfileAvatarActions: the 小画像 / 大画像 sheet. 画像変更 picks a file and crops it, 画像調整 re-crops the current (or kept) image;
// the save itself runs in AvatarImageSession and reports in the inspector.
public sealed class AvatarActionsView : Grid, IDisposable
{
    private readonly LinuxWorkspace workspace;
    private readonly Bot bot;
    private readonly ConversationEntry entry;
    private readonly AvatarVariant variant;
    private readonly AvatarImageSession session;
    private readonly IInspectorHost host;
    private readonly CancellationTokenSource lifetime;
    private AvatarProfile? settings;
    private bool loading, unsupported;
    private string? errorText;
    private Bitmap? previewImage;
    private bool previewFailed;
    private string? previewKey;
    public event Action? BusyChanged;
    public bool Busy => session.Saving;
    // The first preview (current image or kept selection) has been looked up.
    public Task Ready { get; private set; } = Task.CompletedTask;
    public AvatarActionsView(LinuxWorkspace workspace, ConversationEntry entry, AvatarVariant variant, AvatarImageSession session, IInspectorHost host)
    {
        this.workspace = workspace; this.entry = entry; bot = entry.Bot ?? throw new ArgumentException("メンバーを選んでください。"); this.variant = variant; this.session = session; this.host = host;
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(workspace.ConnectionToken);
        Background = BellTheme.ConversationBackground;
        session.Changed += Changed; Rebuild();
    }
    public void Dispose() { session.Changed -= Changed; lifetime.Cancel(); lifetime.Dispose(); }
    private void Changed() { BusyChanged?.Invoke(); Rebuild(); }

    private AvatarSelection? Pending => session.Pending(variant);

    private void Rebuild()
    {
        var column = new StackPanel { Width = 340, Margin = new Thickness(24), VerticalAlignment = VerticalAlignment.Top, HorizontalAlignment = HorizontalAlignment.Center, IsEnabled = !session.Saving };
        void Add(Control element) { if (column.Children.Count != 0) element.Margin = new Thickness(0, 20, 0, 0); column.Children.Add(element); }
        Add(PreviewBox());
        var pending = Pending;
        var change = InspectorUi.Prominent("画像変更"); change.IsEnabled = !(loading || unsupported || pending is not null); change.Click += async (_, _) => await ChangeAsync();
        AutomationProperties.SetAutomationId(change, "profile-image-change"); Add(change);
        var adjust = InspectorUi.Bordered("画像調整", wide: true); adjust.IsEnabled = !(loading || unsupported); adjust.Click += async (_, _) => await AdjustAsync();
        AutomationProperties.SetAutomationId(adjust, "profile-image-adjust"); Add(adjust);
        if (loading) Add(InspectorUi.Progress("画像情報を確認しています…"));
        if (session.Error(variant) is { } status) Add(InspectorUi.Note(status, BellTheme.Red));
        if (pending is not null)
        {
            Add(InspectorUi.Note(BotProfileText.PendingKept, BellTheme.Muted));
            var confirm = InspectorUi.Bordered("保存結果を確認", wide: true); confirm.Click += async (_, _) => { if (await session.ConfirmAsync(workspace.Management, bot.Id, variant, version => workspace.AvatarVersion(bot.Id, version), workspace.RefreshForImageAsync, workspace.ConnectionToken)) host.CloseSheet(); }; Add(confirm);
            var discard = InspectorUi.Bordered("選択を破棄", wide: true, destructive: true); discard.Click += (_, _) => session.Discard(variant); Add(discard);
            Add(InspectorUi.Note(BotProfileText.ChangeBlocked, BellTheme.Muted));
        }
        if (settings is not null && pending is null && settings.AdjustmentImage(variant).Source.Length == 0) Add(InspectorUi.Note(BotProfileText.NoSourceNote, BellTheme.Muted));
        if (settings is null && errorText is not null) { var reload = InspectorUi.Bordered("画像情報を再読込", wide: true); reload.Click += async (_, _) => await LoadSettingsAsync(); Add(reload); }
        if (errorText is not null) Add(InspectorUi.Note(errorText, BellTheme.Red));
        Children.Clear(); Children.Add(new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Content = column });
        var key = pending?.Render ?? "current";
        if (key != previewKey) { previewKey = key; previewImage = null; previewFailed = false; Ready = LoadPreviewAsync(key, pending); }
    }

    private Control PreviewBox()
    {
        const double side = 220;
        var radius = variant == AvatarVariant.Small ? side * .31 : 20;
        var accent = BellColors.Accent(bot.Color);
        var box = new Border { Width = side, Height = side, CornerRadius = new CornerRadius(radius), HorizontalAlignment = HorizontalAlignment.Center, Background = new LinearGradientBrush { StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative), EndPoint = new RelativePoint(1, 1, RelativeUnit.Relative), GradientStops = [new GradientStop(Color.FromArgb(190, accent.R, accent.G, accent.B), 0), new GradientStop(accent, 1)] } };
        if (previewImage is not null) box.Background = new ImageBrush(previewImage) { Stretch = Stretch.UniformToFill };
        else if (previewFailed) box.Child = new TextBlock { Text = System.Globalization.StringInfo.GetNextTextElement(bot.Name.Length == 0 ? "B" : bot.Name), FontSize = 72, FontWeight = FontWeight.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        AutomationProperties.SetName(box, previewImage is null ? "画像の表示待ち" : variant == AvatarVariant.Small ? "現在の小画像" : "現在の大画像");
        AutomationProperties.SetAutomationId(box, "profile-image-preview-" + (variant == AvatarVariant.Small ? "small" : "large"));
        return box;
    }

    private async Task LoadPreviewAsync(string key, AvatarSelection? pending)
    {
        try
        {
            Bitmap? image = null;
            if (pending is not null) image = await AvatarHost.DecodeAsync(pending.Render);
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
        var path = await AvatarHost.PickImageAsync(host.OwnerWindow, variant.Label() + "を選ぶ");
        if (path is null) return;
        try { await CropAsync((await AvaloniaImageCodec.Instance.ReadAsync(path)).Preview, null); }
        catch (Exception) { errorText = "画像を読み込めませんでした。"; Rebuild(); }
    }

    private async Task AdjustAsync()
    {
        if (!await LoadSettingsAsync() || settings is null) return;
        string data; AvatarCropRect? initial;
        if (Pending is { } kept) { data = kept.Source; initial = kept.Crop; }
        else { var current = settings.AdjustmentImage(variant); data = current.Source.Length == 0 ? current.Render : current.Source; initial = current.Source.Length == 0 ? null : current.Crop; }
        try { await CropAsync(await AvatarHost.DecodeAsync(data), initial); }
        catch (Exception) { errorText = Pending is not null ? "保持中の画像を読み込めませんでした。" : "画像を読み込めませんでした。"; Rebuild(); }
    }

    // The crop sheet opens over this one; "使用する" closes this sheet and the save reports in the inspector, as on the Mac.
    private async Task CropAsync(Bitmap image, AvatarCropRect? initial)
    {
        var outcome = await host.CropAsync(image, variant, initial, wantsSelection: true);
        if (outcome?.Selection is not { } selection || lifetime.IsCancellationRequested) return;
        host.CloseSheet();
        _ = session.SaveAsync(workspace.Management, bot.Id, variant, selection, version => workspace.AvatarVersion(bot.Id, version), workspace.RefreshForImageAsync, workspace.ConnectionToken);
    }
}
