using System.ComponentModel;
using System.Net;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using BellTeam.Core;
using Shapes = Avalonia.Controls.Shapes;

namespace BellTeam.Linux;

// Small controls of the inspector and its image sheet, in the Mac look (plain tap targets, bordered and prominent buttons).
internal static class InspectorUi
{
    // A tap target with no chrome (Mac .buttonStyle(.plain)).
    public static Button Plain(Control content, string name)
    {
        if (content is Panel panel) panel.Background ??= Brushes.Transparent;
        var button = new Button { Classes = { "plain" }, Content = content, Padding = default, CornerRadius = default, Background = Brushes.Transparent, HorizontalAlignment = HorizontalAlignment.Stretch, VerticalAlignment = VerticalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };
        AutomationProperties.SetName(button, name); return button;
    }
    private static Control Label(string text, string? icon, IBrush foreground, double size)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Spacing = 6 };
        if (icon is not null) line.Children.Add(Icons.Draw(icon, size + 1, foreground, thickness: 1.7));
        line.Children.Add(new TextBlock { Text = text, FontSize = size, Foreground = foreground, FontWeight = FontWeight.Normal, VerticalAlignment = VerticalAlignment.Center });
        return line;
    }
    // Mac .buttonStyle(.bordered): a light tint with coloured text.
    public static Button Bordered(string text, string? icon = null, bool wide = false, bool destructive = false, double size = 13)
    {
        var tint = destructive ? Color.FromArgb(0x1F, 255, 59, 48) : Color.FromArgb(0x1F, 0x61, 0x47, 0xD4);
        var button = new Button { Classes = { "plain" }, Content = Label(text, icon, destructive ? BellTheme.Red : BellTheme.Violet, size), CornerRadius = new CornerRadius(7), Background = new SolidColorBrush(tint), Padding = wide ? new Thickness(12, 7) : new Thickness(12, 5), HorizontalAlignment = wide ? HorizontalAlignment.Stretch : HorizontalAlignment.Left };
        AutomationProperties.SetName(button, text); return button;
    }
    // Mac .buttonStyle(.borderedProminent).
    public static Button Prominent(string text, string? icon = null, double size = 14)
    {
        var button = new Button { Classes = { "plain" }, Content = Label(text, icon, Brushes.White, size), CornerRadius = new CornerRadius(7), Background = BellTheme.Violet, Padding = new Thickness(16, 7), HorizontalAlignment = HorizontalAlignment.Stretch };
        AutomationProperties.SetName(button, text); return button;
    }
    // Changes the text of a button made by Bordered (its label is the last child of the content panel).
    public static void Relabel(Button button, string text) { ((TextBlock)((Panel)button.Content!).Children[^1]).Text = text; AutomationProperties.SetName(button, text); }
    public static TextBlock Note(string text, IBrush color) => new() { Text = text, FontSize = 13, Foreground = color, TextWrapping = TextWrapping.Wrap };
    public static Control Progress(string text)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        line.Children.Add(new Spinner(BellTheme.Muted, 16));
        line.Children.Add(new TextBlock { Text = text, FontSize = 13, Foreground = BellTheme.Muted, VerticalAlignment = VerticalAlignment.Center });
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
    private readonly LinuxWorkspace workspace;
    // Where the image sheet and the editors open; unset in tests that only read the content.
    public IInspectorHost? Host { get; set; }
    // The large hero image has been looked up (the render waits for it).
    public Task LoadTask { get; private set; } = Task.CompletedTask;
    private string? rendered;
    private int epoch;
    private bool largeError;
    private StackPanel? status;
    private AvatarImageSession? session;
    private (string Id, string Small, string? Large)? versions;
    private Border? largeImage;
    private Button[] heroButtons = [];
    public ProfileView(LinuxWorkspace workspace)
    {
        this.workspace = workspace; Margin = new Thickness(23);
        workspace.PropertyChanged += Updated;
        Render();
    }
    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e) { if (session is not null) session.Changed -= SessionChanged; base.OnDetachedFromVisualTree(e); }
    private void Updated(object? sender, PropertyChangedEventArgs args)
    {
        if (args.PropertyName is not (nameof(LinuxWorkspace.Selected) or nameof(LinuxWorkspace.Profile))) return;
        if (Dispatcher.UIThread.CheckAccess()) Render(); else Dispatcher.UIThread.Post(Render);
    }

    private static string Key(LinuxWorkspace workspace, ConversationEntry entry)
    {
        var parts = new List<string?> { entry.Target.ToString(), entry.Origin };
        if (entry.Bot is { } bot) parts.AddRange([bot.Name, bot.DisplayName, bot.Online.ToString(), bot.Harness, bot.Model, bot.ReasoningEffort, bot.Color, bot.AvatarVersion, bot.AvatarLargeVersion, bot.Position, bot.ProfileText, bot.Personality, bot.SpeechStyle, bot.Role, bot.Account?.Harness, bot.Account?.Slot]);
        if (entry.Room is { } room) { parts.AddRange([room.Name, room.Purpose, room.AvatarVersion]); foreach (var id in room.MemberIds) { var member = workspace.MemberEntry(id); parts.AddRange([id, member?.Name, member?.Bot?.AvatarVersion, member?.Bot?.Color]); } }
        return string.Join('\u0001', parts);
    }

    private void Render()
    {
        var entry = workspace.Selected;
        var key = entry is null ? "" : Key(workspace, entry);
        if (rendered == key) return;
        rendered = key; Children.Clear(); status = null; epoch++; largeError = false; LoadTask = Task.CompletedTask;
        if (session is not null) session.Changed -= SessionChanged;
        session = null;
        if (entry is null) { versions = null; Children.Add(new TextBlock { Text = "メンバーやルームを選ぶと、ここに詳細を表示します。", FontSize = 16, Foreground = Brushes.Gray, TextWrapping = TextWrapping.Wrap }); return; }
        if (entry.Bot is { } bot)
        {
            session = workspace.ImageSession(bot.Id); session.Changed += SessionChanged;
            // A newer image in the roster answers an earlier "saved, but the display did not update".
            if (versions is { } before && before.Id == bot.Id) { if (before.Small != bot.AvatarVersion) session.VersionChanged(AvatarVariant.Small); if (before.Large != bot.AvatarLargeVersion) session.VersionChanged(AvatarVariant.Large); }
            versions = (bot.Id, bot.AvatarVersion, bot.AvatarLargeVersion);
            AddBlock(Hero(entry, bot));
            AddBlock(Divider());
            AddBlock(AiCard(entry, bot));
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
            header.Children.Add(new TextBlock { Text = entry.Name, FontSize = 20, FontWeight = FontWeight.Bold, Foreground = BellTheme.Ink, TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center, Margin = new Thickness(0, 13, 0, 0) });
            AddBlock(header, first: true);
            AddBlock(Divider());
            AddBlock(Heading("この部屋で共有する仕事"));
            AddBlock(Body(room.Purpose.Length == 0 ? "未設定" : room.Purpose, BellTheme.Ink, "この部屋で共有する仕事"));
            AddBlock(Heading("参加メンバー"));
            foreach (var id in room.MemberIds)
            {
                if (workspace.MemberEntry(id) is not { } member) continue;
                var row = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*") };
                row.Children.Add(new AvatarTile { Entry = member, Workspace = workspace, Width = 30, Height = 30, VerticalAlignment = VerticalAlignment.Center });
                // member.Name is the display name (name and position), as on the Mac.
                var name = new TextBlock { Text = member.Name, FontSize = 16, Foreground = BellTheme.Ink, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(8, 0, 0, 0) }; Grid.SetColumn(name, 1); row.Children.Add(name);
                var button = InspectorUi.Plain(row, member.Name); button.Click += async (_, _) => await workspace.SelectAsync(member); AddBlock(button);
            }
        }
        AddBlock(EditButton(entry));
        if (entry.Bot is not null) { RenderStatus(); LoadTask = LoadLargeAsync(entry, epoch); }
    }
    private void AddBlock(Control item, bool first = false) { item.Margin = new Thickness(item.Margin.Left, Children.Count == 0 || first ? item.Margin.Top : item.Margin.Top + 22, item.Margin.Right, item.Margin.Bottom); Children.Add(item); }
    private static Border Divider() => new() { Height = 1, Background = new SolidColorBrush(Color.FromRgb(229, 227, 240)) };
    private static TextBlock Heading(string text) => new() { Text = text, FontSize = 14, FontWeight = FontWeight.Bold, Foreground = BellTheme.Muted };

    private Control Hero(ConversationEntry entry, Bot bot)
    {
        var hero = new StackPanel();
        var accent = BellColors.Accent(bot.Color);
        var area = new SquareGrid();
        var large = new Border { CornerRadius = new CornerRadius(20), Background = new LinearGradientBrush { StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative), EndPoint = new RelativePoint(1, 1, RelativeUnit.Relative), GradientStops = [new GradientStop(Color.FromArgb(190, accent.R, accent.G, accent.B), 0), new GradientStop(accent, 1)] } };
        largeImage = large;
        var largeButton = InspectorUi.Plain(large, "大画像の操作"); largeButton.Click += (_, _) => OpenActions(AvatarVariant.Large);
        AutomationProperties.SetAutomationId(largeButton, "profile-large-avatar"); area.Children.Add(largeButton);
        var small = new AvatarTile { Entry = entry, Workspace = workspace, Width = 152, Height = 152, BorderBrush = Brushes.White, BorderThickness = new Thickness(2) };
        var smallButton = InspectorUi.Plain(small, "小画像の操作"); smallButton.HorizontalAlignment = HorizontalAlignment.Left; smallButton.VerticalAlignment = VerticalAlignment.Top; smallButton.Margin = new Thickness(16); smallButton.Click += (_, _) => OpenActions(AvatarVariant.Small);
        AutomationProperties.SetAutomationId(smallButton, "profile-small-avatar"); area.Children.Add(smallButton);
        heroButtons = [largeButton, smallButton];
        hero.Children.Add(area);
        status = new StackPanel(); hero.Children.Add(status);
        hero.Children.Add(new TextBlock { Text = bot.DisplayName, FontSize = 20, FontWeight = FontWeight.Bold, Foreground = BellTheme.Ink, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 10, 0, 0) });
        var presence = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 0) };
        var color = bot.Online ? BellTheme.Mint : BellTheme.Muted;
        presence.Children.Add(new Shapes.Ellipse { Width = 11, Height = 11, Fill = color, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 7, 0) });
        presence.Children.Add(new TextBlock { Text = bot.Online ? "オンライン" : "オフライン", FontSize = 14, Foreground = color, VerticalAlignment = VerticalAlignment.Center });
        hero.Children.Add(presence);
        return hero;
    }

    // The messages under the hero image (Mac BotProfileHero): the large-image failure, saving, the last result, and per image the error and the kept selection.
    private void SessionChanged() { if (Dispatcher.UIThread.CheckAccess()) RenderStatus(); else Dispatcher.UIThread.Post(RenderStatus); }
    private void RenderStatus()
    {
        if (status is null || session is null || workspace.Selected?.Bot is not { } bot) return;
        status.Children.Clear();
        void Add(Control element) { element.Margin = new Thickness(0, 10, 0, 0); status.Children.Add(element); }
        if (largeError) Add(InspectorUi.Note("大画像を読み込めませんでした。", BellTheme.Red));
        if (session.Saving) Add(InspectorUi.Progress("画像を保存しています…"));
        if (session.Message is { } message) Add(InspectorUi.Note(message, BellTheme.Mint));
        foreach (var variant in new[] { AvatarVariant.Small, AvatarVariant.Large })
        {
            if (session.Error(variant) is { } error) Add(InspectorUi.Note(BotProfileText.Failed(variant, error), BellTheme.Red));
            if (session.Pending(variant) is null) continue;
            var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, IsEnabled = !session.Saving };
            var confirm = InspectorUi.Bordered(variant.Label() + "の保存結果を確認");
            var current = variant;
            confirm.Click += async (_, _) => await session.ConfirmAsync(workspace.Management, bot.Id, current, kind => workspace.AvatarVersion(bot.Id, kind), workspace.RefreshForImageAsync, workspace.ConnectionToken);
            var discard = InspectorUi.Bordered(variant.Label() + "の選択を破棄", destructive: true); discard.Click += (_, _) => session.Discard(current);
            line.Children.Add(confirm); line.Children.Add(discard); Add(line);
        }
        foreach (var button in heroButtons) button.IsEnabled = !session.Saving;
    }

    private async Task LoadLargeAsync(ConversationEntry entry, int generation)
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
        if (Host is null || workspace.Selected is not { Bot: not null } entry || session is null || session.Saving) return null;
        if (!session.OpenActions()) return null;
        var view = new AvatarActionsView(workspace, entry, variant, session, Host);
        Host.OpenSheet(variant.Label(), view);
        return view;
    }
    // Render seam: opens the image sheet like a tap on the hero image would.
    internal AvatarActionsView? OpenActionsForRender(AvatarVariant variant) => OpenActions(variant);

    private Control AiCard(ConversationEntry entry, Bot bot)
    {
        var card = new StackPanel();
        card.Children.Add(new TextBlock { Text = "AIと操作", FontSize = 14, FontWeight = FontWeight.Bold, Foreground = BellTheme.Muted });
        // The seat's Claude account slot; no row when the server sends none (older body, null, another harness).
        var rows = new List<(string, string)> { ("ハーネス", bot.Harness), ("希望モデル", BotProfileText.OrDefault(bot.Model)), ("希望エフォート", BotProfileText.OrDefault(bot.ReasoningEffort)) };
        if (AccountText.SeatText(bot.Account) is { } slotText) rows.Add(("アカウント", slotText));
        foreach (var (label, value) in rows)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 12, 0, 0), Spacing = 10 };
            row.Children.Add(new TextBlock { Text = label, FontSize = 14, Foreground = BellTheme.Ink }); row.Children.Add(new TextBlock { Text = value, FontSize = 14, Foreground = BellTheme.Ink, TextWrapping = TextWrapping.Wrap });
            AutomationProperties.SetName(row, label + "　" + value); card.Children.Add(row);
        }
        var screen = InspectorUi.Bordered("Botの画面を見る", InspectorIcons.Terminal); screen.Margin = new Thickness(0, 12, 0, 0); screen.Click += async (_, _) => await workspace.OpenScreenAsync(); card.Children.Add(screen);
        restartButton = InspectorUi.Bordered("会話セッションを再起動"); restartButton.Margin = new Thickness(0, 12, 0, 0); card.Children.Add(restartButton);
        restartNote = InspectorUi.Note("", BellTheme.Muted); restartNote.Margin = new Thickness(0, 12, 0, 0); card.Children.Add(restartNote);
        restartError = InspectorUi.Note("", BellTheme.Red); restartError.Margin = new Thickness(0, 12, 0, 0); card.Children.Add(restartError);
        var id = entry.Target.Id; restartButton.Click += async (_, _) => await RestartAsync(id);
        RenderRestart(id);
        var frame = FormUi.Card(card); frame.Padding = new Thickness(16); return frame;
    }

    // Mac BotProfileAISection.onRestart: one POST that the server answers after the new seat is up (180 s). Meanwhile the button reads 「再起動しています…」 and is off;
    // a success is one line, a failure keeps the server's message. Never sent again, and the state belongs to the member it was started for.
    private sealed record RestartState(string Id, bool Busy = false, string? Note = null, string? Error = null);
    private RestartState? restart;
    private Button? restartButton;
    private TextBlock? restartNote, restartError;
    internal async Task RestartAsync(string id)
    {
        if (restart is { Busy: true } && restart.Id == id) return;
        var token = workspace.ConnectionToken; restart = new(id, Busy: true); RenderRestart(id);
        try { await workspace.Management.RestartBotAsync(id, token); await workspace.RefreshManagementAsync(); restart = new(id, Note: "会話を再起動しました。"); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { restart = null; }
        catch (Exception failure) { restart = new(id, Error: failure.Message); }
        RenderRestart(id);
    }
    private void RenderRestart(string id)
    {
        if (restartButton is null || workspace.Selected?.Target.Id != id) return;
        var state = restart is { } current && current.Id == id ? current : null;
        InspectorUi.Relabel(restartButton, state?.Busy == true ? "再起動しています…" : "会話セッションを再起動"); restartButton.IsEnabled = state?.Busy != true;
        restartNote!.Text = state?.Note ?? ""; restartNote.IsVisible = state?.Note is not null;
        restartError!.Text = state?.Error ?? ""; restartError.IsVisible = state?.Error is not null;
    }
    // Render seam: the in-progress and success states of the restart, which would need a POST the mock never answers.
    internal void SetRestartForRender(string id, bool busy) { restart = busy ? new(id, Busy: true) : new(id, Note: "会話を再起動しました。"); RenderRestart(id); }

    private Control EditButton(ConversationEntry entry)
    {
        var edit = InspectorUi.Prominent(entry.Target.IsRoom ? "ルームを編集" : "メンバーを編集", InspectorIcons.Pencil); edit.HorizontalAlignment = HorizontalAlignment.Left; edit.Margin = new Thickness(0);
        edit.Click += (_, _) => { if (entry.Target.IsRoom) Host?.EditRoom(entry.Target.Id); else Host?.EditMember(entry.Target.Id); };
        return edit;
    }
    private static Control Detail(string title, string value, bool spaced)
    {
        var item = new StackPanel { Margin = new Thickness(0, spaced ? 18 : 0, 0, 0) };
        var heading = Heading(title); heading.Margin = new Thickness(0, 0, 0, 6); item.Children.Add(heading);
        item.Children.Add(Body(value.Length == 0 ? "未設定" : value, value.Length == 0 ? BellTheme.Muted : BellTheme.Ink, title));
        return item;
    }
    // Selectable, read-only text (Windows SelectableBody).
    private static TextBox Body(string text, IBrush color, string name)
    {
        var body = new TextBox { Classes = { "bare" }, Text = text, Foreground = color, IsReadOnly = true, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, FontSize = 18, Margin = new Thickness(-2, 0, 0, 0) };
        AutomationProperties.SetName(body, name); return body;
    }
}
