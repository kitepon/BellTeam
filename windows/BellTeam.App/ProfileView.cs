using System.ComponentModel;
using System.Net;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using BellTeam.Core;

namespace BellTeam.App;

// Small controls of the inspector and its image sheet, in the Mac look (plain tap targets, bordered and prominent buttons).
internal static class InspectorUi
{
    public static Brush Ink => Palette.Ink;
    public static Brush Muted => Palette.Muted;
    public static Brush Mint => Palette.Get("Mint");
    public static Brush Red => Palette.Get("Red");
    public static Brush Violet => Palette.Get("Violet");
    private static ControlTemplate Template(double radius)
    {
        var chrome = new FrameworkElementFactory(typeof(Border)) { Name = "Chrome" };
        chrome.SetValue(Border.CornerRadiusProperty, new CornerRadius(radius));
        chrome.SetValue(Border.BackgroundProperty, new TemplateBindingExtension(Control.BackgroundProperty));
        chrome.SetValue(Border.PaddingProperty, new TemplateBindingExtension(Control.PaddingProperty));
        var content = new FrameworkElementFactory(typeof(ContentPresenter)); content.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center); content.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
        chrome.AppendChild(content);
        var template = new ControlTemplate(typeof(Button)) { VisualTree = chrome };
        template.Triggers.Add(new Trigger { Property = UIElement.IsEnabledProperty, Value = false, Setters = { new Setter(UIElement.OpacityProperty, 0.45, "Chrome") } });
        return template;
    }
    // Built per use: a template is owned by the thread that first touched it, so a shared static fails for a second UI thread (tests).
    private static ControlTemplate PlainTemplate()
    {
        var content = new FrameworkElementFactory(typeof(ContentPresenter));
        return new ControlTemplate(typeof(Button)) { VisualTree = content };
    }
    // A tap target with no chrome (Mac .buttonStyle(.plain)).
    public static Button Plain(UIElement content, string name) { if (content is Panel panel) panel.Background ??= Brushes.Transparent; var button = new Button { Content = content, Template = PlainTemplate(), Padding = new Thickness(0), Background = Brushes.Transparent, HorizontalContentAlignment = HorizontalAlignment.Stretch, Cursor = System.Windows.Input.Cursors.Hand }; System.Windows.Automation.AutomationProperties.SetName(button, name); return button; }
    private static UIElement Label(string text, string? glyph, Brush foreground, double size)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        if (glyph is not null) line.Children.Add(new TextBlock { Text = glyph, FontFamily = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"), FontSize = size, Foreground = foreground, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 6, 0) });
        line.Children.Add(new TextBlock { Text = text, FontSize = size, Foreground = foreground, VerticalAlignment = VerticalAlignment.Center });
        return line;
    }
    // Mac .buttonStyle(.bordered): a light tint with coloured text.
    public static Button Bordered(string text, string? glyph = null, bool wide = false, bool destructive = false, double size = 13)
    {
        var tint = destructive ? Color.FromArgb(0x1F, 255, 59, 48) : Color.FromArgb(0x1F, 0x61, 0x47, 0xD4);
        var button = new Button { Content = Label(text, glyph, destructive ? Red : Violet, size), Template = Template(7), Background = new SolidColorBrush(tint), Padding = wide ? new Thickness(12, 7, 12, 7) : new Thickness(12, 5, 12, 5), HorizontalAlignment = wide ? HorizontalAlignment.Stretch : HorizontalAlignment.Left, Cursor = System.Windows.Input.Cursors.Hand };
        System.Windows.Automation.AutomationProperties.SetName(button, text); return button;
    }
    // Mac .buttonStyle(.borderedProminent).
    public static Button Prominent(string text, string? glyph = null, double size = 14)
    {
        var button = new Button { Content = Label(text, glyph, Brushes.White, size), Template = Template(7), Background = Violet, Padding = new Thickness(16, 7, 16, 7), HorizontalAlignment = HorizontalAlignment.Stretch, Cursor = System.Windows.Input.Cursors.Hand };
        System.Windows.Automation.AutomationProperties.SetName(button, text); return button;
    }
    public static TextBlock Note(string text, Brush color) => new() { Text = text, FontSize = 13, Foreground = color, TextWrapping = TextWrapping.Wrap };
    public static UIElement Progress(string text)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal };
        line.Children.Add(new Spinner { Width = 16, Height = 16, Stroke = Muted, Margin = new Thickness(0, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center });
        line.Children.Add(new TextBlock { Text = text, FontSize = 13, Foreground = Muted, VerticalAlignment = VerticalAlignment.Center });
        return line;
    }
}

// A cell as tall as it is wide (the Mac hero image: aspectRatio(1, .fit)).
internal sealed class SquareGrid : Grid
{
    protected override Size MeasureOverride(Size available) { var side = double.IsInfinity(available.Width) ? 320 : available.Width; base.MeasureOverride(new Size(side, side)); return new Size(side, side); }
    protected override Size ArrangeOverride(Size finalSize) { base.ArrangeOverride(new Size(finalSize.Width, finalSize.Width)); return new Size(finalSize.Width, finalSize.Width); }
}

// Mac DesktopInspector: BotProfileHero, 「AIと操作」, 「プロフィール」 and the edit button for a member; the room's work, members and edit button for a room.
public sealed class ProfileView : StackPanel
{
    public static readonly DependencyProperty WorkspaceProperty = DependencyProperty.Register(nameof(Workspace), typeof(Workspace), typeof(ProfileView), new PropertyMetadata(null, Changed));
    public Workspace? Workspace { get => (Workspace?)GetValue(WorkspaceProperty); set => SetValue(WorkspaceProperty, value); }
    // Where the image sheet and the editors open; unset in tests that only read the content.
    public IInspectorHost? Host { get; set; }
    // The large hero image has been looked up (the render waits for it).
    public Task LoadTask { get; private set; } = Task.CompletedTask;
    private string? rendered;
    private int epoch;
    private bool largeError;
    private string? restartError;
    private StackPanel? status;
    private AvatarImageSession? session;
    private (string Id, string Small, string? Large)? versions;
    public ProfileView() { Margin = new Thickness(23); }
    private static void Changed(DependencyObject target, DependencyPropertyChangedEventArgs args)
    {
        var view = (ProfileView)target;
        if (args.OldValue is Workspace old) old.PropertyChanged -= view.Updated;
        if (args.NewValue is Workspace next) next.PropertyChanged += view.Updated;
        view.Render();
    }
    private void Updated(object? sender, PropertyChangedEventArgs args) { if (args.PropertyName is nameof(BellTeam.App.Workspace.Selected) or nameof(BellTeam.App.Workspace.Profile)) Render(); }

    private static string Key(Workspace workspace, ConversationEntry entry)
    {
        var parts = new List<string?> { entry.Target.ToString(), entry.Origin };
        if (entry.Bot is { } bot) parts.AddRange([bot.Name, bot.DisplayName, bot.Online.ToString(), bot.Harness, bot.Model, bot.ReasoningEffort, bot.Color, bot.AvatarVersion, bot.AvatarLargeVersion, bot.Position, bot.ProfileText, bot.Personality, bot.SpeechStyle, bot.Role, bot.Account?.Harness, bot.Account?.Slot, bot.Account?.PreferredSlot]);
        if (entry.Room is { } room) { parts.AddRange([room.Name, room.Purpose, room.AvatarVersion]); foreach (var id in room.MemberIds) { var member = workspace.MemberEntry(id); parts.AddRange([id, member?.Name, member?.Bot?.AvatarVersion, member?.Bot?.Color]); } }
        return string.Join('\u0001', parts);
    }

    private void Render()
    {
        if (Workspace is not { } workspace) return;
        var entry = workspace.Selected;
        var key = entry is null ? "" : Key(workspace, entry);
        if (rendered == key) return;
        var previousBot = versions?.Id;
        rendered = key; Children.Clear(); status = null; epoch++; largeError = false; LoadTask = Task.CompletedTask;
        if (session is not null) session.Changed -= SessionChanged;
        session = null;
        if (entry is null) { versions = null; Children.Add(new TextBlock { Text = "メンバーやルームを選ぶと、ここに詳細を表示します。", FontSize = 16, Foreground = Palette.Get("Gray"), TextWrapping = TextWrapping.Wrap }); return; }
        if (entry.Bot is { } bot)
        {
            session = workspace.ImageSession(bot.Id); session.Changed += SessionChanged;
            // A newer image in the roster answers an earlier "saved, but the display did not update".
            if (versions is { } before && before.Id == bot.Id) { if (before.Small != bot.AvatarVersion) session.VersionChanged(AvatarVariant.Small); if (before.Large != bot.AvatarLargeVersion) session.VersionChanged(AvatarVariant.Large); }
            versions = (bot.Id, bot.AvatarVersion, bot.AvatarLargeVersion);
            AddBlock(Hero(workspace, entry, bot));
            AddBlock(Divider());
            AddBlock(AiCard(workspace, entry, bot));
            AddBlock(Heading("プロフィール"));
            var details = new StackPanel();
            foreach (var (title, value) in new[] { ("役職", bot.Position), ("背景・見た目・関係性", bot.ProfileText), ("性格・考え方", bot.Personality), ("口調", bot.SpeechStyle), ("担当する仕事", bot.Role) }) details.Children.Add(Detail(title, value, details.Children.Count != 0));
            AddBlock(details);
        }
        else if (entry.Room is { } room)
        {
            versions = null;
            var header = new StackPanel { HorizontalAlignment = HorizontalAlignment.Stretch, Margin = new Thickness(0, 12, 0, 12) };
            header.Children.Add(new AvatarTile { Entry = entry, Workspace = workspace, Width = 76, Height = 76, HorizontalAlignment = HorizontalAlignment.Center });
            header.Children.Add(new TextBlock { Text = entry.Name, FontSize = 20, FontWeight = FontWeights.Bold, Foreground = InspectorUi.Ink, TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center, Margin = new Thickness(0, 13, 0, 0) });
            AddBlock(header, first: true);
            AddBlock(Divider());
            AddBlock(Heading("この部屋で共有する仕事"));
            AddBlock(Body(room.Purpose.Length == 0 ? "未設定" : room.Purpose, InspectorUi.Ink, "この部屋で共有する仕事"));
            AddBlock(Heading("参加メンバー"));
            foreach (var id in room.MemberIds)
            {
                if (workspace.MemberEntry(id) is not { } member) continue;
                var row = new Grid(); row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); row.ColumnDefinitions.Add(new ColumnDefinition());
                row.Children.Add(new AvatarTile { Entry = member, Workspace = workspace, Width = 30, Height = 30, VerticalAlignment = VerticalAlignment.Center });
                // member.Name is the display name (name and position), as on the Mac.
                var name = new TextBlock { Text = member.Name, FontSize = 16, Foreground = InspectorUi.Ink, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(8, 0, 0, 0) }; Grid.SetColumn(name, 1); row.Children.Add(name);
                var button = InspectorUi.Plain(row, member.Name); button.Click += async (_, _) => await workspace.SelectAsync(member); AddBlock(button);
            }
        }
        AddBlock(EditButton(workspace, entry));
        if (entry.Bot is not null) { RenderStatus(); LoadTask = LoadLargeAsync(workspace, entry, epoch); }
    }
    private void AddBlock(UIElement element, bool first = false) { if (element is FrameworkElement item) item.Margin = new Thickness(item.Margin.Left, Children.Count == 0 || first ? item.Margin.Top : item.Margin.Top + 22, item.Margin.Right, item.Margin.Bottom); Children.Add(element); }
    private static Border Divider() => new() { Height = 1, Background = Palette.Get("Line") };
    private static TextBlock Heading(string text) => new() { Text = text, FontSize = 14, FontWeight = FontWeights.Bold, Foreground = InspectorUi.Muted };

    private UIElement Hero(Workspace workspace, ConversationEntry entry, Bot bot)
    {
        var hero = new StackPanel();
        var accent = BellColors.Accent(bot.Color);
        var area = new SquareGrid();
        var large = new Border { CornerRadius = new CornerRadius(20), Background = new LinearGradientBrush(Color.FromArgb(190, accent.R, accent.G, accent.B), accent, 45) };
        largeImage = large;
        var largeButton = InspectorUi.Plain(large, "大画像の操作"); largeButton.Click += (_, _) => OpenActions(AvatarVariant.Large);
        System.Windows.Automation.AutomationProperties.SetAutomationId(largeButton, "profile-large-avatar"); area.Children.Add(largeButton);
        var small = new AvatarTile { Entry = entry, Workspace = workspace, Width = 152, Height = 152, BorderBrush = Brushes.White, BorderThickness = new Thickness(2) };
        var smallButton = InspectorUi.Plain(small, "小画像の操作"); smallButton.HorizontalAlignment = HorizontalAlignment.Left; smallButton.VerticalAlignment = VerticalAlignment.Top; smallButton.Margin = new Thickness(16); smallButton.Click += (_, _) => OpenActions(AvatarVariant.Small);
        System.Windows.Automation.AutomationProperties.SetAutomationId(smallButton, "profile-small-avatar"); area.Children.Add(smallButton);
        heroButtons = [largeButton, smallButton];
        hero.Children.Add(area);
        status = new StackPanel(); hero.Children.Add(status);
        hero.Children.Add(new TextBlock { Text = bot.DisplayName, FontSize = 20, FontWeight = FontWeights.Bold, Foreground = InspectorUi.Ink, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 10, 0, 0) });
        var presence = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 0) };
        var color = bot.Online ? InspectorUi.Mint : InspectorUi.Muted;
        presence.Children.Add(new System.Windows.Shapes.Ellipse { Width = 11, Height = 11, Fill = color, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 7, 0) });
        presence.Children.Add(new TextBlock { Text = bot.Online ? "オンライン" : "オフライン", FontSize = 14, Foreground = color, VerticalAlignment = VerticalAlignment.Center });
        hero.Children.Add(presence);
        return hero;
    }
    private Border? largeImage;
    private Button[] heroButtons = [];

    // The messages under the hero image (Mac BotProfileHero): the large-image failure, saving, the last result, and per image the error and the kept selection.
    private void SessionChanged() => RenderStatus();
    private void RenderStatus()
    {
        if (status is null || session is null || Workspace?.Selected?.Bot is not { } bot) return;
        status.Children.Clear();
        void Add(UIElement element) { if (element is FrameworkElement item) item.Margin = new Thickness(0, 10, 0, 0); status.Children.Add(element); }
        if (largeError) Add(InspectorUi.Note("大画像を読み込めませんでした。", InspectorUi.Red));
        if (session.Saving) Add(InspectorUi.Progress("画像を保存しています…"));
        if (session.Message is { } message) Add(InspectorUi.Note(message, InspectorUi.Mint));
        foreach (var variant in new[] { AvatarVariant.Small, AvatarVariant.Large })
        {
            if (session.Error(variant) is { } error) Add(InspectorUi.Note(BotProfileText.Failed(variant, error), InspectorUi.Red));
            if (session.Pending(variant) is null) continue;
            var line = new StackPanel { Orientation = Orientation.Horizontal, IsEnabled = !session.Saving };
            var confirm = InspectorUi.Bordered(variant.Label() + "の保存結果を確認"); confirm.Margin = new Thickness(0, 0, 8, 0);
            confirm.Click += async (_, _) => { if (Workspace is { } workspace) await session.ConfirmAsync(workspace.Management, bot.Id, variant, kind => workspace.AvatarVersion(bot.Id, kind), workspace.RefreshForImageAsync, workspace.ConnectionToken); };
            var discard = InspectorUi.Bordered(variant.Label() + "の選択を破棄", destructive: true); discard.Click += (_, _) => session.Discard(variant);
            line.Children.Add(confirm); line.Children.Add(discard); Add(line);
        }
        foreach (var button in heroButtons) button.IsEnabled = !session.Saving;
    }

    private async Task LoadLargeAsync(Workspace workspace, ConversationEntry entry, int generation)
    {
        var bot = entry.Bot!;
        var url = bot.UsesSmallImage ? entry.AvatarUrl : entry.LargeAvatarUrl;
        if (url is null || largeImage is not { } target) return;
        try
        {
            var image = await workspace.AvatarAsync(url);
            if (generation == epoch) target.Background = new ImageBrush(image) { Stretch = Stretch.UniformToFill };
        }
        // A missing image is the plain gradient, not a failure (Mac: AVATAR_NOT_FOUND returns an empty image).
        catch (BellApiException error) when (error.Status == HttpStatusCode.NotFound) { }
        catch (OperationCanceledException) { }
        catch (Exception) { if (generation == epoch && !bot.UsesSmallImage) { largeError = true; RenderStatus(); } }
    }

    private AvatarActionsView? OpenActions(AvatarVariant variant)
    {
        if (Host is null || Workspace is not { Selected: { Bot: not null } entry } workspace || session is null || session.Saving) return null;
        if (!session.OpenActions()) return null;
        var view = new AvatarActionsView(workspace, entry, variant, session, Host);
        Host.OpenSheet(variant.Label(), view);
        return view;
    }
    // Render seam: opens the image sheet like a tap on the hero image would.
    internal AvatarActionsView? OpenActionsForRender(AvatarVariant variant) => OpenActions(variant);

    private UIElement AiCard(Workspace workspace, ConversationEntry entry, Bot bot)
    {
        var card = new StackPanel();
        card.Children.Add(new TextBlock { Text = "AIと操作", FontSize = 14, FontWeight = FontWeights.Bold, Foreground = InspectorUi.Muted });
        // The seat's Claude account slot; no row when the server sends none (older body, null, another harness).
        var rows = new List<(string, string)> { ("ハーネス", bot.Harness), ("希望モデル", BotProfileText.OrDefault(bot.Model)), ("希望エフォート", BotProfileText.OrDefault(bot.ReasoningEffort)) };
        if (AccountText.SeatText(bot.Account) is { } slotText) rows.Add(("アカウント", slotText));
        foreach (var (label, value) in rows)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 12, 0, 0) };
            row.Children.Add(new TextBlock { Text = label, FontSize = 14, Foreground = InspectorUi.Ink }); row.Children.Add(new TextBlock { Text = value, FontSize = 14, Foreground = InspectorUi.Ink, Margin = new Thickness(10, 0, 0, 0), TextWrapping = TextWrapping.Wrap });
            System.Windows.Automation.AutomationProperties.SetName(row, label + "　" + value); card.Children.Add(row);
            // Like the Web tooltip: say so when the seat runs on the other slot than its rule prefers.
            if (label == "アカウント" && AccountText.SlotTitle(bot.Account?.PreferredSlot) is { } preferred && bot.Account?.PreferredSlot != bot.Account?.Slot) row.ToolTip = "通常は" + preferred;
        }
        var screen = InspectorUi.Bordered("Botの画面を見る", ""); screen.Margin = new Thickness(0, 12, 0, 0); screen.Click += async (_, _) => await workspace.OpenScreenAsync(); card.Children.Add(screen);
        var restart = InspectorUi.Bordered("会話セッションを再起動"); restart.Margin = new Thickness(0, 12, 0, 0); card.Children.Add(restart);
        var error = InspectorUi.Note(restartError ?? "", InspectorUi.Red); error.Margin = new Thickness(0, 12, 0, 0); error.Visibility = restartError is null ? Visibility.Collapsed : Visibility.Visible; card.Children.Add(error);
        restart.Click += async (_, _) =>
        {
            restart.IsEnabled = false; var token = workspace.ConnectionToken; restartError = null; error.Visibility = Visibility.Collapsed;
            try { await workspace.Management.RestartBotAsync(entry.Target.Id, token); await workspace.RefreshManagementAsync(); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { }
            catch (Exception failure) { restartError = failure.Message; error.Text = failure.Message; error.Visibility = Visibility.Visible; }
            finally { restart.IsEnabled = true; }
        };
        var frame = SettingsUi.Card(card); frame.Padding = new Thickness(16); return frame;
    }

    private UIElement EditButton(Workspace workspace, ConversationEntry entry)
    {
        var edit = InspectorUi.Prominent(entry.Target.IsRoom ? "ルームを編集" : "メンバーを編集", ""); edit.HorizontalAlignment = HorizontalAlignment.Left; edit.Margin = new Thickness(0);
        edit.Click += (_, _) => { if (entry.Target.IsRoom) Host?.EditRoom(entry.Target.Id); else Host?.EditMember(entry.Target.Id); };
        return edit;
    }
    private static UIElement Detail(string title, string value, bool spaced)
    {
        var item = new StackPanel { Margin = new Thickness(0, spaced ? 18 : 0, 0, 0) };
        var heading = Heading(title); heading.Margin = new Thickness(0, 0, 0, 6); item.Children.Add(heading);
        item.Children.Add(Body(value.Length == 0 ? "未設定" : value, value.Length == 0 ? InspectorUi.Muted : InspectorUi.Ink, title));
        return item;
    }
    private static TextBox Body(string text, Brush color, string name)
    {
        var body = new TextBox { Text = text, Foreground = color, Margin = new Thickness(-2, 0, 0, 0) }; body.SetResourceReference(StyleProperty, "SelectableBody");
        System.Windows.Automation.AutomationProperties.SetName(body, name); return body;
    }
}
