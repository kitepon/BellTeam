using System.Diagnostics;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using BellTeam.Core;
using static BellTeam.App.SettingsUi;

namespace BellTeam.App;

// Settings 「端末」 (Mac TerminalsView.swift): the list and the detail are drawn from the TerminalsModel; the editor and the host-key sheet are in-window sheets.
internal static class TerminalParts
{
    public static readonly Brush Mint = Frozen(0x2E, 0xB3, 0x9E), Grey = Frozen(0xE5, 0xE5, 0xEA);
    private static Brush Frozen(byte r, byte g, byte b) { var brush = new SolidColorBrush(Color.FromRgb(r, g, b)); brush.Freeze(); return brush; }

    // Segoe Fluent Icons for the SF Symbols the Mac uses.
    public const string Check = "\uEC61", Ring = "\uEA3A", Waiting = "\uE823", Bolt = "\uE945", ShieldOk = "\uE83D", ShieldWarn = "\uEA18", KeyGlyph = "\uE8D7", Remove = "\uE738", Trash = "\uE74D", Plus = "\uE710", Info = "\uE946", Chevron = "\uE76C", Laptop = "\uE7F8", Gear = "\uE713";

    // An older body (Unsupported) still reports configured / missing.
    public static (string Text, string Glyph, Brush Color) KeyLook(TerminalKeyState state, bool configured) => state.Status switch
    {
        TerminalKeyStatus.Pending => (state.Text, Waiting, Orange),
        TerminalKeyStatus.Configured => (state.Text, Check, Mint),
        TerminalKeyStatus.Missing => (state.Text, Ring, Orange),
        _ => configured ? ("設定済み", Check, Mint) : ("未設定", Ring, Orange)
    };

    // 16c: the Mac's 「共有設定を開く」. The settings page opens through the shell; a failure is said, not hidden.
    public static Button OptionalFeaturesButton(Workspace workspace)
    {
        var button = Bordered(Gear, "オプション機能を開く", () =>
        {
            try { Process.Start(new ProcessStartInfo(ThisPcFacts.OptionalFeaturesUri) { UseShellExecute = true }); }
            catch (Exception) { workspace.ReportActionError("設定を開けませんでした。Windowsの「設定 > システム > オプション機能」を開いてください。"); }
        });
        button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 8, 0, 0); return button;
    }

    // Mac BellDate.short.
    public static string ShortTime(string? iso) => DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? Timeline.ShortTime(at, DateTimeOffset.Now) : "";

    public static StackPanel IconLabel(string glyph, string text, Brush color, double size = 13, FontWeight? weight = null)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal };
        line.Children.Add(Glyph(glyph, size, color)); line.Children.Add(Text(text, size, color, weight, new Thickness(6, 0, 0, 0))); return line;
    }

    // One calm line for a BellTeam without the feature; never a red banner.
    public static UIElement Calm(string text)
    {
        var line = new Grid(); line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(24) }); line.ColumnDefinitions.Add(new ColumnDefinition());
        var mark = Glyph(Info, 14, Secondary); line.Children.Add(mark);
        var words = Text(text, 14, Secondary); Grid.SetColumn(words, 1); line.Children.Add(words); return line;
    }

    // The shared icon row answers the pointer only; this one also takes the keyboard (Tab, then Enter or Space). No click means a row that cannot be used now.
    public static Grid IconRow(string glyph, string label, Brush color, Action? click)
    {
        var row = IconButtonRow(glyph, label, color, click);
        if (click is null) return row;
        row.Focusable = true; row.KeyDown += (_, args) => { if (args.Key is Key.Enter or Key.Space) { click(); args.Handled = true; } };
        return row;
    }

    // The Mac .bordered small button: a grey capsule with an icon and a label.
    public static Button Bordered(string glyph, string label, Action click, bool destructive = false, bool enabled = true)
    {
        var button = Capsule(label, Grey, destructive ? Red : Ink, 6, 13, new Thickness(12, 5, 12, 5)); button.FontWeight = FontWeights.Normal; button.IsEnabled = enabled;
        var content = new StackPanel { Orientation = Orientation.Horizontal };
        content.Children.Add(Glyph(glyph, 13, destructive ? Red : Ink)); content.Children.Add(Text(label, 13, destructive ? Red : Ink, null, new Thickness(8, 0, 0, 0)));
        button.Content = content; System.Windows.Automation.AutomationProperties.SetName(button, label);
        button.Click += (_, _) => click(); return button;
    }

    // A row of a grouped list that opens something: the whole row answers the pointer and Enter / Space.
    public static Border Clickable(UIElement content, string name, Action click)
    {
        var row = Row(content); row.Focusable = true; row.Cursor = Cursors.Hand; row.Background = Brushes.Transparent;
        System.Windows.Automation.AutomationProperties.SetName(row, name);
        row.MouseLeftButtonUp += (_, _) => click();
        row.KeyDown += (_, args) => { if (args.Key is Key.Enter or Key.Space) { click(); args.Handled = true; } };
        return row;
    }

    // The Mac DisclosureGroup: the chevron before the label, the body shown when open.
    public static Expander Disclosure(string title, UIElement body, bool open, Action<bool> changed)
    {
        var expander = new Expander { Header = title, Content = body, IsExpanded = open, Template = (ControlTemplate)XamlReader.Parse(
            """
            <ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="Expander">
              <StackPanel>
                <ToggleButton IsChecked="{Binding IsExpanded, RelativeSource={RelativeSource TemplatedParent}, Mode=TwoWay}" Cursor="Hand" Focusable="True">
                  <ToggleButton.Template><ControlTemplate TargetType="ToggleButton"><Grid Background="Transparent"><Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition/></Grid.ColumnDefinitions>
                    <TextBlock x:Name="Chevron" Text="&#xE76C;" FontFamily="Segoe Fluent Icons, Segoe MDL2 Assets" FontSize="11" Foreground="#8A8A8E" VerticalAlignment="Center" Margin="0,0,8,0"/>
                    <ContentPresenter Grid.Column="1" Content="{Binding Header, RelativeSource={RelativeSource AncestorType=Expander}}" VerticalAlignment="Center"/></Grid>
                    <ControlTemplate.Triggers><Trigger Property="IsChecked" Value="True"><Setter TargetName="Chevron" Property="Text" Value="&#xE70D;"/></Trigger></ControlTemplate.Triggers></ControlTemplate></ToggleButton.Template>
                </ToggleButton>
                <ContentPresenter x:Name="Body" Visibility="Collapsed" Margin="19,8,0,0"/>
              </StackPanel>
              <ControlTemplate.Triggers><Trigger Property="IsExpanded" Value="True"><Setter TargetName="Body" Property="Visibility" Value="Visible"/></Trigger></ControlTemplate.Triggers>
            </ControlTemplate>
            """), FontSize = 13, Foreground = Ink };
        expander.Expanded += (_, _) => changed(true); expander.Collapsed += (_, _) => changed(false);
        return expander;
    }

    // A text field with its label on the left and its value on the right, and the problem (red) under it.
    public static (Border Row, TextBox Box, TextBlock Problem) TextRow(string label, string prompt, string value)
    {
        var (field, box) = Field(prompt, value); box.TextAlignment = TextAlignment.Right; box.FontSize = 13;
        ((TextBlock)field.Children[1]).HorizontalAlignment = HorizontalAlignment.Right;
        System.Windows.Automation.AutomationProperties.SetName(box, label);
        var line = new Grid(); line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(110) }); line.ColumnDefinitions.Add(new ColumnDefinition());
        var caption = Text(label, 13); caption.VerticalAlignment = VerticalAlignment.Center; line.Children.Add(caption); Grid.SetColumn(field, 1); line.Children.Add(field);
        var problem = Text("", 12, Red, null, new Thickness(0, 4, 0, 0)); problem.Visibility = Visibility.Collapsed;
        return (Row(new StackPanel { Children = { line, problem } }), box, problem);
    }
}

// The registry in the settings pane: one row per terminal, 「端末を追加」, and the older-body / failure lines.
internal sealed class TerminalListView : StackPanel
{
    private readonly TerminalsModel model;
    private readonly Action<string> open;
    private readonly Action add;
    public TerminalListView(TerminalsModel model, Action<string> open, Action add) { this.model = model; this.open = open; this.add = add; Render(); }
    public void Render()
    {
        Children.Clear();
        switch (model.State)
        {
            case TerminalListState.NotLoaded: Children.Add(Text("端末の一覧を読み込んでいます…", 13, Secondary, null, new Thickness(20, 14, 0, 0))); break;
            case TerminalListState.Unsupported: Children.Add(FormSection(null, new GroupCard(Row(TerminalParts.Calm("このBellTeamはまだ端末の登録に対応していません"))))); break;
            case TerminalListState.Failed:
                var retry = EditorFormView.LinkButton("もう一度読み込む", () => _ = model.RefreshAsync(), enabled: !model.Loading);
                Children.Add(FormSection(null, new GroupCard(Row(Banner(model.FailedMessage ?? "")), Row(retry)))); break;
            default:
                var group = new GroupCard();
                if (model.Terminals.Length == 0) group.Add(Row(Text("まだ端末がありません。メンバーの席を動かすMac・Windows PC・Linuxマシンを登録します。", 14, Secondary)));
                foreach (var terminal in model.Terminals) group.Add(TerminalRow(terminal));
                group.Add(Row(TerminalParts.IconRow(TerminalParts.Plus, "端末を追加", Violet, add)));
                Children.Add(FormSection("登録した端末", group, "メンバーの席を、BellTeamの外のMac・Windows PC・Linuxマシンで動かす時に使います。鍵は状態だけを表示し、中身は表示しません。"));
                if (model.ReadError is { } error) Children.Add(FormSection(null, new GroupCard(Row(Banner("最新の一覧を読み込めませんでした。前に読んだ一覧を表示しています。")), Row(Text(error, 12, Secondary)))));
                break;
        }
    }

    private UIElement TerminalRow(Terminal terminal)
    {
        var grid = new Grid(); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(30) }); grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var tile = Tile(SettingsPage.Terminals, 30); tile.VerticalAlignment = VerticalAlignment.Top; tile.Margin = new Thickness(0, 3, 0, 0); grid.Children.Add(tile);
        var lines = new StackPanel { Margin = new Thickness(12, 0, 8, 0) };
        lines.Children.Add(Text(terminal.TerminalId, 16, Ink, FontWeights.Medium));
        lines.Children.Add(Text($"{terminal.Address} · {terminal.OsLabel} · {terminal.OwnerLabel}", 14, Secondary, null, new Thickness(0, 3, 0, 0)));
        var badges = new WrapPanel { Margin = new Thickness(0, 3, 0, 0) };
        void Badge(string glyph, string text, Brush color) { var badge = TerminalParts.IconLabel(glyph, text, color, 12); badge.Margin = new Thickness(0, 0, 14, 0); badges.Children.Add(badge); }
        var ssh = TerminalParts.KeyLook(terminal.Key(TerminalKeyKind.Ssh), terminal.SshKeyConfigured); Badge(ssh.Glyph, $"{TerminalKeyKind.Ssh.Title()} {ssh.Text}", ssh.Color);
        if (terminal.SudoKeyConfigured || terminal.SudoKeyPending) { var sudo = TerminalParts.KeyLook(terminal.Key(TerminalKeyKind.Sudo), terminal.SudoKeyConfigured); Badge(sudo.Glyph, $"{TerminalKeyKind.Sudo.Title()} {sudo.Text}", sudo.Color); }
        if (model.Checks.TryGetValue(terminal.TerminalId, out var check)) Badge(TerminalParts.Bolt, check.Summary, check.Reachable ? TerminalParts.Mint : Red);
        lines.Children.Add(badges); Grid.SetColumn(lines, 1); grid.Children.Add(lines);
        var chevron = Glyph(TerminalParts.Chevron, 12, Secondary); Grid.SetColumn(chevron, 2); grid.Children.Add(chevron);
        return TerminalParts.Clickable(grid, terminal.TerminalId, () => open(terminal.TerminalId));
    }
}

// One terminal: where it connects, whether it can be reached, its host key, its keys and the last Claude Code upkeep.
internal sealed class TerminalDetailView : Grid, IDisposable
{
    private readonly Workspace workspace;
    private readonly TerminalsModel model;
    private readonly string id;
    private readonly CancellationToken token;
    private readonly Action<SecretRequest, Action<SecretRequest>> openSecret;
    private readonly StackPanel body = new() { Margin = new Thickness(20, 28, 20, 24), MaxWidth = 720 };
    private readonly Grid alertLayer = new() { Background = new SolidColorBrush(Color.FromArgb(0x59, 0, 0, 0)), Visibility = Visibility.Collapsed };
    private string? errorText;
    private bool working, keysRouteMissing, otherWaysOpen, disposed, ownsPc;
    private CancellationTokenSource? awaiting;
    public Button EditButton { get; }
    // Render seams.
    internal bool OtherWaysOpen { get => otherWaysOpen; set { otherWaysOpen = value; Render(); } }

    // openSecret opens the secret input window for a request and calls the callback when it was submitted or declined; the default is the modal window.
    public TerminalDetailView(Workspace workspace, string id, CancellationToken token, Action<SecretRequest, Action<SecretRequest>>? openSecret = null)
    {
        this.workspace = workspace; model = workspace.Terminals; this.id = id; this.token = token;
        this.openSecret = openSecret ?? ((request, completed) => new SecretInputWindow(request, submission => workspace.FinishSecretAsync(request.Id, submission), () => workspace.SecretKeysAsync(request.Id), completed) { Owner = Window.GetWindow(this) }.ShowDialog());
        EditButton = Capsule("編集", Brushes.White, Ink, 16, 13, new Thickness(14, 6, 14, 6)); System.Windows.Automation.AutomationProperties.SetName(EditButton, "編集");
        EditButton.Click += (_, _) => { if (model.Find(id) is { } terminal) OpenSheet("端末を編集", new TerminalEditorView(workspace, model, terminal)); };
        var scroller = new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
        Children.Add(scroller); Children.Add(alertLayer); Panel.SetZIndex(alertLayer, 5);
        model.Changed += Render; token.Register(Dispose); Render();
    }
    public ScrollViewer Scroller => (ScrollViewer)Children[0];

    // Leaving the page stops the wait for a key authorization and forgets it, as the Mac does when the detail disappears.
    public void Dispose()
    {
        if (disposed) return;
        disposed = true; model.Changed -= Render; awaiting?.Cancel();
        if (model.Authorizations.TryGetValue(id, out var state) && state is AuthorizeState.Waiting) model.Authorizations.Remove(id);
    }

    private Terminal? Current => model.Find(id);
    private TerminalCheck? Check => model.Checks.GetValueOrDefault(id);
    private bool Checking => model.Checking.Contains(id);
    // The server accepts a terminal's first host key by itself; only a check that reports a host-trust reason asks the Owner for the manual fingerprint.
    private bool HostKeyReported => Check?.Problem == TerminalCheck.ProblemKind.HostKey;

    private void OpenSheet(string title, EditorFormView view)
    {
        if (AvatarHost.Of(this) is not { } host) { view.Dispose(); workspace.ReportActionError("この画面では開けません。"); return; }
        view.Closer = host.CloseSheet; host.OpenSheet(title, view);
    }

    private void Render()
    {
        if (disposed) return;
        EditButton.IsEnabled = Current is not null && !working;
        body.Children.Clear();
        if (Current is not { } terminal) { body.Children.Add(FormSection(null, new GroupCard(Row(TerminalParts.Calm("この端末の登録が見つかりません。一覧へ戻って読み直してください。"))))); return; }
        ownsPc = model.OwnsHost(terminal);
        body.Children.Add(FormSection("接続先", new GroupCard(Row(LabeledRow("ホスト", terminal.Host)), Row(LabeledRow("ユーザー", terminal.User)), Row(LabeledRow("ポート", terminal.Port.ToString(CultureInfo.InvariantCulture))), Row(LabeledRow("OS", terminal.OsLabel)), Row(LabeledRow("持ち主", terminal.OwnerLabel)))));
        body.Children.Add(FormSection("つながるか", ReachabilityGroup(terminal), "SSHで一度だけつないで、すぐに閉じます。メンバーの席は起動しません。"));
        body.Children.Add(FormSection("ホスト鍵", HostKeyGroup(terminal), "ホスト鍵は、つなぐ相手が本当にこの端末かを見分ける印です。端末で読んだ指紋と同じ時だけ信用します。"));
        body.Children.Add(FormSection("鍵", KeyGroup(terminal), terminal.KeysRouteAvailable && !keysRouteMissing ? "鍵は専用の入力欄だけに入れます。1Passwordの参照を先に選べます。中身や参照は、この画面にも会話にも出しません。" : null));
        if (terminal.Maintenance is { } maintenance)
        {
            var group = new GroupCard(Row(Text(maintenance.Text, 13, maintenance.Outcome == "failed" ? Orange : Ink)));
            if (maintenance.ObservedAt is { } at) group.Add(Row(LabeledRow("確かめた日時", TerminalParts.ShortTime(at))));
            body.Children.Add(FormSection("Claude Codeの更新", group));
        }
        body.Children.Add(FormSection(null, new GroupCard(Row(TerminalParts.IconRow(TerminalParts.Trash, "端末の登録を消す", Red, working ? null : AskRemove)))));
        if (errorText is not null) body.Children.Add(FormSection(null, new GroupCard(Row(Banner(errorText)))));
    }

    private GroupCard ReachabilityGroup(Terminal terminal)
    {
        var group = new GroupCard(); var check = Check;
        var block = new StackPanel();
        var head = new Grid(); head.ColumnDefinitions.Add(new ColumnDefinition()); head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        if (check is not null) head.Children.Add(TerminalParts.IconLabel(TerminalParts.Bolt, check.Summary, check.Reachable ? TerminalParts.Mint : Red, 14, FontWeights.SemiBold));
        else head.Children.Add(Text("まだ確かめていません", 14, Secondary));
        if (check?.ObservedAt is { } observed) { var time = Text(TerminalParts.ShortTime(observed), 12, Secondary); time.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(time, 1); head.Children.Add(time); }
        block.Children.Add(head);
        if (check?.Explanation(terminal.Os) is { } explanation) block.Children.Add(Text(explanation, 14, Ink, null, new Thickness(0, 6, 0, 0)));
        if (check?.ExtraAction is { } extra) block.Children.Add(Text("サーバーの案内: " + extra, 12, Secondary, null, new Thickness(0, 4, 0, 0)));
        System.Windows.Automation.AutomationProperties.SetName(block, "つながるか: " + (check?.Summary ?? "まだ確かめていません"));
        group.Add(Row(block));
        // Evidence is not a diagnosis, so each reason offers its likely fix as a button; the check below stays available.
        if (ownsPc && check?.Problem == TerminalCheck.ProblemKind.Refused) group.Add(Row(TerminalParts.OptionalFeaturesButton(workspace)));
        model.Authorizations.TryGetValue(id, out var state);
        switch (state)
        {
            case AuthorizeState.Waiting waiting: group.Add(Row(Text(waiting.ReadFailed ? TerminalAuthorize.ReadFailedText : TerminalAuthorize.WaitingText(terminal.Os), 14, Ink))); break;
            case AuthorizeState.Shown shown: group.Add(Row(Text(shown.Note.Text, 14, Ink))); break;
        }
        if ((state is null && check?.OffersAuthorize == true) || state?.Retry == true)
            group.Add(Row(TerminalParts.IconRow(TerminalParts.KeyGlyph, $"この{TerminalOS.Machine(terminal.Os)}にこの鍵を入れる", Violet, working || Checking ? null : () => _ = AuthorizeKeyAsync())));
        var press = TerminalParts.IconRow(TerminalParts.Bolt, "つながるか確かめる", Violet, Checking || working ? null : () => _ = RunCheckAsync());
        if (Checking) { var busy = Text("確かめています…", 12, Secondary); busy.HorizontalAlignment = HorizontalAlignment.Right; Grid.SetColumn(busy, 1); press.Children.Add(busy); }
        group.Add(Row(press));
        return group;
    }

    private GroupCard HostKeyGroup(Terminal terminal)
    {
        var group = new GroupCard();
        var status = HostKeyReported ? terminal.HostTrusted ? "変わりました" : "まだ確かめていません" : terminal.HostTrusted ? "信用しています" : "まだ確かめていません";
        var warn = !terminal.HostTrusted || HostKeyReported;
        var line = new Grid(); line.ColumnDefinitions.Add(new ColumnDefinition()); line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        line.Children.Add(Text("ホスト鍵", 13));
        var value = TerminalParts.IconLabel(warn ? TerminalParts.ShieldWarn : TerminalParts.ShieldOk, status, warn ? Orange : TerminalParts.Mint); Grid.SetColumn(value, 1); line.Children.Add(value);
        group.Add(Row(line));
        // 16c S2: the terminal is this PC, so this app can read the host key itself. For another PC the server's own action (under 「つながるか」) says to open the app there.
        model.TrustNotes.TryGetValue(id, out var note);
        if (ownsPc)
        {
            var attest = TerminalParts.IconRow(TerminalParts.ShieldOk, "このPCを確かめる", Violet, model.Attesting.Contains(id) || working ? null : () => _ = model.AttestAsync(id));
            if (model.Attesting.Contains(id)) { var busy = Text("確かめています…", 12, Secondary); busy.HorizontalAlignment = HorizontalAlignment.Right; Grid.SetColumn(busy, 1); attest.Children.Add(busy); }
            group.Add(Row(attest));
        }
        if (note is not null)
        {
            var lines = new StackPanel { Children = { Text(note.Text, 14, Ink) } };
            if (note.OffersOptionalFeatures) lines.Children.Add(TerminalParts.OptionalFeaturesButton(workspace));
            System.Windows.Automation.AutomationProperties.SetName(lines, note.Text);
            group.Add(Row(lines));
        }
        if (HostKeyReported || note?.OffersOtherWays == true)
        {
            var other = new StackPanel();
            other.Children.Add(Text($"その{TerminalOS.Machine(terminal.Os)}にBellTeamアプリが無い時や、うまく確かめられない時は、端末で読んだ指紋を入れて確かめます。", 14, Secondary));
            var confirm = TerminalParts.Bordered(TerminalParts.KeyGlyph, "ホスト鍵を確かめる", () => OpenSheet("ホスト鍵", new HostKeyView(workspace, model, terminal, Check)), enabled: !working); confirm.HorizontalAlignment = HorizontalAlignment.Left; confirm.Margin = new Thickness(0, 10, 0, 0);
            other.Children.Add(confirm);
            group.Add(Row(TerminalParts.Disclosure("ほかの方法", other, otherWaysOpen, open => otherWaysOpen = open)));
        }
        return group;
    }

    private GroupCard KeyGroup(Terminal terminal)
    {
        var group = new GroupCard();
        foreach (var kind in TerminalOS.UsesSudoKey(terminal.Os) ? new[] { TerminalKeyKind.Ssh, TerminalKeyKind.Sudo } : [TerminalKeyKind.Ssh]) group.Add(Row(KeyRow(kind, terminal)));
        if (keysRouteMissing || !terminal.KeysRouteAvailable) group.Add(Row(TerminalParts.Calm(TerminalKeyState.Unsupported.Text)));
        return group;
    }

    private UIElement KeyRow(TerminalKeyKind kind, Terminal terminal)
    {
        var state = keysRouteMissing ? TerminalKeyState.Unsupported : terminal.Key(kind);
        var look = TerminalParts.KeyLook(state, kind == TerminalKeyKind.Ssh ? terminal.SshKeyConfigured : terminal.SudoKeyConfigured);
        var stack = new StackPanel();
        var head = new Grid(); head.ColumnDefinitions.Add(new ColumnDefinition()); head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var names = new StackPanel(); names.Children.Add(Text(kind.Title(), 13));
        names.Children.Add(Text(kind == TerminalKeyKind.Ssh ? "必須。これが無いと端末につなげません。" : "任意。自分の端末では不要です。", 11, Secondary, null, new Thickness(0, 2, 0, 0)));
        head.Children.Add(names);
        var right = new StackPanel { HorizontalAlignment = HorizontalAlignment.Right }; right.Children.Add(TerminalParts.IconLabel(look.Glyph, look.Text, look.Color, 14));
        if (state.SourceText is { } source) right.Children.Add(Right(Text(source, 11, Secondary, null, new Thickness(0, 3, 0, 0))));
        Grid.SetColumn(right, 1); head.Children.Add(right); stack.Children.Add(head);
        System.Windows.Automation.AutomationProperties.SetName(head, $"{kind.Title()}: {look.Text}{(state.SourceText is null ? "" : "、" + state.SourceText)}");
        if (state.Status == TerminalKeyStatus.Pending) stack.Children.Add(Text($"入力を待っています。入力欄を閉じた時は「{state.SetTitle}」でもう一度開けます。", 11, Secondary, null, new Thickness(0, 8, 0, 0)));
        if (state.Status != TerminalKeyStatus.Unsupported)
        {
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 2) };
            var set = TerminalParts.Bordered(TerminalParts.KeyGlyph, state.SetTitle, () => _ = SetKeyAsync(kind), enabled: !working); set.Margin = new Thickness(0, 0, 10, 0); buttons.Children.Add(set);
            if (state.Removable) buttons.Children.Add(TerminalParts.Bordered(TerminalParts.Remove, "外す", () => AskRemoveKey(kind), destructive: true, enabled: !working));
            stack.Children.Add(buttons);
        }
        return stack;
    }
    private static TextBlock Right(TextBlock text) { text.HorizontalAlignment = HorizontalAlignment.Right; text.TextAlignment = TextAlignment.Right; return text; }

    // ---- actions: each sends once and shows the reason; nothing is resent ----
    private bool Stale => token.IsCancellationRequested || disposed;

    internal async Task RunCheckAsync()
    {
        errorText = null; model.ClearNote(id);
        try { await model.CheckAsync(id, token); }
        catch (Exception error) when (!Stale) { errorText = TerminalErrorText.Message(error); }
        catch (Exception) { return; }
        Render();
    }

    // The key itself goes only into the secret card; this sends an empty POST and opens the card the server returns.
    internal async Task SetKeyAsync(TerminalKeyKind kind)
    {
        working = true; errorText = null; Render();
        try
        {
            var request = await model.RequestKeyAsync(id, kind, token);
            openSecret(request, _ => { });
            await model.RefreshAsync(token);
        }
        catch (Exception error) when (!Stale) { if (TerminalErrorText.IsKeysUnsupported(error)) keysRouteMissing = true; else errorText = TerminalErrorText.Message(error); }
        catch (Exception) { return; }
        finally { working = false; }
        Render();
    }

    internal async Task RemoveKeyAsync(TerminalKeyKind kind)
    {
        working = true; errorText = null; Render();
        try { await model.RemoveKeyAsync(id, kind, token); }
        catch (Exception error) when (!Stale) { if (TerminalErrorText.IsKeysUnsupported(error)) keysRouteMissing = true; else errorText = TerminalErrorText.Message(error); }
        catch (Exception) { return; }
        finally { working = false; }
        Render();
    }

    // Step 4: 「この鍵を入れる」. The login password goes only into the terminal.login card; once it was submitted the terminal is read until the outcome is in.
    internal async Task AuthorizeKeyAsync()
    {
        working = true; errorText = null; Render();
        try
        {
            if (await model.RequestKeyAuthorizationAsync(id, token) is { } request)
                openSecret(request, result => { if (result.Status == "submitted") WaitForOutcome(result.Id); });
        }
        catch (Exception error) when (!Stale) { errorText = TerminalErrorText.Message(error); }
        catch (Exception) { return; }
        finally { working = false; }
        Render();
    }
    private void WaitForOutcome(string requestId)
    {
        awaiting?.Cancel(); awaiting = CancellationTokenSource.CreateLinkedTokenSource(token);
        _ = model.AwaitKeyAuthorizationAsync(id, requestId, null, awaiting.Token);
    }

    private async Task RemoveAsync()
    {
        working = true; errorText = null; Render();
        try { await model.RemoveAsync(id, token); }
        catch (Exception error) when (!Stale) { errorText = TerminalErrorText.Message(error); }
        catch (Exception) { return; }
        finally { working = false; }
        Render();
    }

    private void Ask(string title, string message, string accept, Action act)
    {
        alertLayer.Children.Clear();
        alertLayer.Children.Add(EditorFormView.AlertFrame(title, message, () => alertLayer.Visibility = Visibility.Collapsed, new AlertChoice(accept, act, Destructive: true), new AlertChoice("キャンセル", Bold: true)));
        alertLayer.Visibility = Visibility.Visible;
    }
    internal void AskRemoveKey(TerminalKeyKind kind) => Ask($"「{id}」の{kind.Title()}を外しますか？",
        kind == TerminalKeyKind.Ssh ? "外すと、鍵を設定し直すまでこの端末につなげません。設定待ちの入力欄も取り消します。" : "外すと、sudoが要る作業は鍵を設定し直すまで止まります。設定待ちの入力欄も取り消します。", "外す", () => _ = RemoveKeyAsync(kind));
    internal void AskRemove() => Ask($"「{id}」の登録を消しますか？", "この端末を使うメンバーの設定と、届いていないメッセージは残ります。メンバーの「端末とフォルダ」は、あとで選び直してください。", "登録を消す", () => _ = RemoveAsync());
}

// Mac TerminalEditor: 端末を追加 / 端末を編集. The fields are checked the way the server checks them; keys are never part of it.
internal sealed class TerminalEditorView : EditorFormView
{
    private readonly TerminalsModel model;
    private readonly Terminal? initial;
    private readonly TerminalDraft draft;
    private readonly Dictionary<TerminalField, (TextBox Box, TextBlock Problem)> fields = [];
    private readonly TextBlock precondition = Text("", 14, Secondary), keysNote = Text("", 14, Secondary);
    // The owner footer follows the OS and the owner choice.
    private readonly TextBlock ownerFooter;
    private readonly StackPanel errorHost = new();
    private bool attempted;
    // 16c S1 「このPCを追加」: what the fill and the loopback answer said, and the owner choices it sets.
    private readonly StackPanel thisPcLines = new();
    private readonly Workspace app;
    private readonly Dictionary<string, RadioButton> ownerChoices = [];
    private Border? thisPcRow;
    private StackPanel? preconditionSection;
    private OpenSshState? openSsh;
    private bool addressMissing, domainAccount, pcAdded;

    public TerminalEditorView(Workspace workspace, TerminalsModel model, Terminal? initial) : base(workspace)
    {
        app = workspace; this.model = model; this.initial = initial; draft = initial is null ? new TerminalDraft() : new TerminalDraft(initial);
        // Step 1 off this PC: the one precondition nobody can see from here, said before the form (per OS).
        if (initial is null && model.Pc is not null)
        {
            thisPcRow = Row(thisPcLines); thisPcRow.Visibility = Visibility.Collapsed;
            Form.Children.Add(FormSection(null, new GroupCard(Row(TerminalParts.IconRow(TerminalParts.Laptop, "このPCを追加", Violet, () => _ = AddThisPcAsync())), thisPcRow), "このPCのアドレスとユーザー名を入れます。入れたあとも直せます。"));
        }
        if (initial is null)
        {
            var line = new Grid(); line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(26) }); line.ColumnDefinitions.Add(new ColumnDefinition());
            line.Children.Add(Glyph(TerminalParts.Info, 16, Secondary)); Grid.SetColumn(precondition, 1); line.Children.Add(precondition);
            Form.Children.Add(preconditionSection = FormSection(null, new GroupCard(Row(line))));
        }
        if (initial is null)
        {
            var id = TerminalParts.TextRow("端末ID", "owner-macbook", draft.TerminalId); Track(TerminalField.TerminalId, id, text => draft.TerminalId = text);
            Form.Children.Add(FormSection("端末", new GroupCard(id.Row), "あとから変えられない名前です。英小文字・数字・ハイフンで付けます。"));
        }
        else Form.Children.Add(FormSection("端末", new GroupCard(Row(LabeledRow("端末ID", draft.TerminalId))), "端末IDは変えられません。"));
        var host = TerminalParts.TextRow("ホスト", "192.168.1.12", draft.Host); Track(TerminalField.Host, host, text => draft.Host = text);
        var user = TerminalParts.TextRow("ユーザー", "kite", draft.User); Track(TerminalField.User, user, text => draft.User = text);
        var port = TerminalParts.TextRow("ポート", "22", draft.Port); Track(TerminalField.Port, port, text => draft.Port = text);
        var options = TerminalOS.All.Select(os => new FormOption(os, TerminalOS.Label(os))).ToList();
        if (!TerminalOS.All.Contains(draft.Os)) options.Add(new(draft.Os, draft.Os));
        var picker = OsPicker = Popup("OS", options, draft.Os);
        picker.SelectionChanged += (_, _) => { if (picker.SelectedValue is string os) { draft.Os = os; Sync(); } };
        Form.Children.Add(FormSection("SSHの接続先", new GroupCard(host.Row, user.Row, port.Row, Labeled("OS", picker)), "端末のOSを選びます。フォルダのパスの形と、つなぐための案内がOSで変わります。"));
        var owner = new GroupCard();
        foreach (var (value, label) in new[] { ("owner", "自分の端末"), ("terminal-owner", "その端末の持ち主") })
        {
            var choice = SecretInputWindow.ChoiceButton(); choice.GroupName = "terminal-owner"; choice.FontSize = 13; choice.Content = label; choice.IsChecked = draft.AccountOwner == value;
            System.Windows.Automation.AutomationProperties.SetName(choice, label);
            choice.Checked += (_, _) => { draft.AccountOwner = value; Sync(); }; owner.Add(choice); ownerChoices[value] = choice;
        }
        var ownerSection = FormSection("持ち主", owner, "-"); ownerFooter = (TextBlock)ownerSection.Children[^1];
        Form.Children.Add(ownerSection);
        Form.Children.Add(FormSection(null, new GroupCard(Row(keysNote))));
        Form.Children.Add(errorHost);
        Sync(); Ready = true; Notify();
    }

    private void Track(TerminalField field, (Border Row, TextBox Box, TextBlock Problem) row, Action<string> set)
    {
        fields[field] = (row.Box, row.Problem);
        row.Box.TextChanged += (_, _) => { set(row.Box.Text); ShowProblems(); };
    }
    internal TextBox Box(TerminalField field) => fields[field].Box;
    internal ComboBox OsPicker { get; }

    // The texts that name the OS follow it.
    private void Sync()
    {
        var machine = TerminalOS.Machine(draft.Os);
        precondition.Text = $"{TerminalOS.SshStep(draft.Os)}BellTeamがSSHでつなぐのに必要です。";
        // Once this PC was added, the section below says the same step when it is needed.
        if (preconditionSection is not null) preconditionSection.Visibility = pcAdded && draft.Os == TerminalOS.Windows ? Visibility.Collapsed : Visibility.Visible;
        ownerFooter.Text = draft.AccountOwner == "owner" ? $"あなた自身の{machine}です。メンバーはあなたのClaudeアカウントを使えます。" : $"ほかの人の{machine}です。その端末のClaudeログインを使い、あなたのアカウントは渡りません。";
        keysNote.Text = TerminalOS.UsesSudoKey(draft.Os) ? "SSH鍵とsudo鍵は、登録した後に端末の画面で設定します。鍵の中身はここに入れません。" : "SSH鍵は、登録した後に端末の画面で設定します。Windowsはsudo鍵を使いません。鍵の中身はここに入れません。";
    }

    private void ShowProblems()
    {
        var problems = draft.Problems(initial is null);
        foreach (var (field, (box, caption)) in fields)
        {
            var shown = problems.TryGetValue(field, out var text) && (attempted || box.Text.Length != 0);
            caption.Text = shown ? text! : ""; caption.Visibility = shown ? Visibility.Visible : Visibility.Collapsed;
        }
    }
    // S1: fills this PC's facts into the form (still editable) and says whether OpenSSH Server answers on loopback. A loopback answer does not prove LAN reach (the firewall); the reachability check is the proof.
    internal async Task AddThisPcAsync()
    {
        var pc = model.Pc!;
        var host = ThisPcFacts.PrimaryIPv4(pc.Interfaces()); addressMissing = host is null;
        var user = ThisPcFacts.SshUser(pc); domainAccount = user.Length == 0;
        pcAdded = true; OsPicker.SelectedValue = TerminalOS.Windows;
        if (host is not null) Box(TerminalField.Host).Text = host;
        Box(TerminalField.User).Text = user; Box(TerminalField.Port).Text = "22"; ownerChoices["owner"].IsChecked = true;
        openSsh = null; ShowPc(); Sync();
        try { openSsh = await pc.OpenSshAsync(22, Token); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { return; }
        ShowPc();
    }

    private void ShowPc()
    {
        thisPcLines.Children.Clear();
        void Line(string text, Brush? color = null) => thisPcLines.Children.Add(Text(text, 14, color ?? Ink, null, new Thickness(0, thisPcLines.Children.Count == 0 ? 0 : 6, 0, 0)));
        if (addressMissing) Line(ThisPcFacts.AddressMissingText);
        if (domainAccount) Line(ThisPcFacts.DomainUserText);
        switch (openSsh)
        {
            case OpenSshState.Off: Line(ThisPcFacts.OpenSshOffText); Line(ThisPcFacts.OpenSshOffStep, Secondary); thisPcLines.Children.Add(TerminalParts.OptionalFeaturesButton(app)); break;
            case OpenSshState.Unknown: Line(ThisPcFacts.OpenSshUnknownText, Secondary); break;
        }
        thisPcRow!.Visibility = thisPcLines.Children.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
    }

    private void SetError(string? message)
    {
        errorHost.Children.Clear();
        if (message is not null) errorHost.Children.Add(FormSection(null, new GroupCard(Row(Banner(message)))));
    }

    public override Task SaveAsync() => !CanSave ? Task.CompletedTask : RunAsync(async () =>
    {
        attempted = true; SetError(null); ShowProblems();
        if (draft.Problems(initial is null).Count != 0) { SetError("赤字の欄を直してください。"); return; }
        Terminal saved;
        try { saved = await model.SaveAsync(draft.TerminalId, draft, Token); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception error) { SetError(TerminalErrorText.Message(error)); return; }
        // S2 once right after a new terminal was saved; the model attests only an untrusted terminal whose host is this PC.
        if (initial is null) _ = model.AttestOnce(saved);
        Close();
    });
}

// Mac HostKeyConfirmSheet: the Owner reads the fingerprint on the terminal and types it; the server scans once and trusts only an equal one.
internal sealed class HostKeyView : EditorFormView
{
    private readonly TerminalsModel model;
    private readonly Terminal terminal;
    private readonly TextBox input;
    private readonly TextBlock problem = Text("", 12, Red), answer = Text("", 13, Red), match = Text("", 13);
    private readonly TerminalCheck? check;
    private readonly StackPanel matchHost = new();
    private string entered = "";

    public HostKeyView(Workspace workspace, TerminalsModel model, Terminal terminal, TerminalCheck? check) : base(workspace)
    {
        this.model = model; this.terminal = terminal; this.check = check;
        var mono = new FontFamily("Consolas, Yu Gothic UI");
        var how = Text($"つなぐ相手が本当に「{terminal.TerminalId}」かを、指紋で確かめます。その端末で次のコマンドを実行し、表示された「SHA256:」で始まる指紋を入れてください。", 14, Ink);
        // The Mac sheet always names the POSIX path; the host key of a Windows OpenSSH server is under ProgramData (terminals README S2).
        var command = terminal.Os == TerminalOS.Windows ? @"ssh-keygen -lf C:\ProgramData\ssh\ssh_host_ed25519_key.pub" : "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub";
        var code = Text(command, 12, Ink); code.FontFamily = mono;
        Form.Children.Add(FormSection("確かめ方", new GroupCard(Row(how), Row(code))));
        if (check?.ReportedFingerprint is { } reported)
        {
            var seen = Text(reported, 12, Ink); seen.FontFamily = mono;
            matchHost.Children.Add(seen); matchHost.Children.Add(match);
            Form.Children.Add(FormSection("サーバーが見た指紋", new GroupCard(Row(matchHost))));
        }
        var (field, box) = Field("SHA256:…", "", multiline: true, minHeight: 20); input = box; input.FontFamily = mono; input.FontSize = 14; ((TextBlock)field.Children[1]).FontFamily = mono; ((TextBlock)field.Children[1]).FontSize = 14;
        System.Windows.Automation.AutomationProperties.SetName(input, "端末で読んだ指紋");
        var typed = new StackPanel { Children = { field, problem, answer } };
        Form.Children.Add(FormSection("端末で読んだ指紋", new GroupCard(Row(typed)), "BellTeamは端末の鍵をもう一度読み、入れた指紋と同じ時だけ信用し直します。違う時は何も変えません。"));
        if (!terminal.SshKeyConfigured) Form.Children.Add(FormSection(null, new GroupCard(Row(Banner("先にSSH鍵を設定してください。鍵が無いと、BellTeamは端末のホスト鍵を読みに行けません。")))));
        input.TextChanged += (_, _) => { entered = input.Text.Trim(); Show(); Notify(); };
        Show(); Ready = true; Notify();
    }
    public override string SaveLabel => "信用する";
    protected override bool SaveBlocked => HostKeyFingerprint.Problem(entered) is not null || !terminal.SshKeyConfigured;
    internal TextBox Input => input;

    private void Show()
    {
        var found = HostKeyFingerprint.Problem(entered);
        problem.Text = entered.Length != 0 && found is not null ? found : ""; problem.Visibility = problem.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        if (check?.ReportedFingerprint is { } reported && found is null)
        {
            var same = entered == reported;
            match.Text = same ? "入れた指紋と一致しています" : "入れた指紋と一致しません"; match.Foreground = same ? TerminalParts.Mint : Red; match.Margin = new Thickness(0, 8, 0, 0); match.Visibility = Visibility.Visible;
        }
        else match.Visibility = Visibility.Collapsed;
    }

    public override Task SaveAsync() => !CanSave ? Task.CompletedTask : RunAsync(async () =>
    {
        answer.Text = "";
        try { await model.ConfirmHostKeyAsync(terminal.TerminalId, entered, Token); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception error) { answer.Text = TerminalErrorText.Message(error); return; }
        Close();
    });
}
