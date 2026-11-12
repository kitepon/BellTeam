using System.Globalization;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Linux;

// Settings 「端末」 (Mac TerminalsView.swift): the list and the detail are drawn from the TerminalsModel; the editor and the host-key sheet are in-window sheets.
// 「このPCを追加」 and 「このPCを確かめる」 (16c) are not offered: ThisPc reads the Windows OpenSSH host-key path.
internal static class TerminalParts
{
    public static readonly IBrush Mint = BellTheme.Mint, Grey = new Avalonia.Media.Immutable.ImmutableSolidColorBrush(Color.FromRgb(0xE5, 0xE5, 0xEA));

    // An older body (Unsupported) still reports configured / missing.
    public static (string Text, string Glyph, IBrush Color) KeyLook(TerminalKeyState state, bool configured) => state.Status switch
    {
        TerminalKeyStatus.Pending => (state.Text, SettingsIcons.Waiting, Orange),
        TerminalKeyStatus.Configured => (state.Text, Icons.Check, Mint),
        TerminalKeyStatus.Missing => (state.Text, SettingsIcons.Ring, Orange),
        _ => configured ? ("設定済み", Icons.Check, Mint) : ("未設定", SettingsIcons.Ring, Orange)
    };

    // Mac BellDate.short.
    public static string ShortTime(string? iso) => DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? Timeline.ShortTime(at, DateTimeOffset.Now) : "";

    public static StackPanel IconLabel(string glyph, string text, IBrush color, double size = 13, FontWeight? weight = null)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        line.Children.Add(Glyph(glyph, size + 2, color)); var label = Text(text, size, color, weight); label.VerticalAlignment = VerticalAlignment.Center; line.Children.Add(label); return line;
    }

    // One calm line for a BellTeam without the feature; never a red banner.
    public static Control Calm(string text)
    {
        var line = new Grid { ColumnDefinitions = new ColumnDefinitions("24,*") };
        var mark = Glyph(SettingsIcons.Info, 16, Secondary); mark.HorizontalAlignment = HorizontalAlignment.Left; mark.VerticalAlignment = VerticalAlignment.Top; mark.Margin = new Thickness(0, 2, 0, 0); line.Children.Add(mark);
        var words = Text(text, 14, Secondary); Grid.SetColumn(words, 1); line.Children.Add(words); return line;
    }

    // The shared icon row answers the pointer only; this one also takes the keyboard (Tab, then Enter or Space). No click means a row that cannot be used now.
    public static Grid IconRow(string glyph, string label, IBrush color, Action? click)
    {
        var row = IconButtonRow(glyph, label, color, click);
        if (click is null) return row;
        row.Focusable = true; row.KeyDown += (_, args) => { if (args.Key is Key.Enter or Key.Space) { click(); args.Handled = true; } };
        return row;
    }

    // The Mac .bordered small button: a grey capsule with an icon and a label.
    public static Button Bordered(string glyph, string label, Action click, bool destructive = false, bool enabled = true)
    {
        var color = destructive ? Red : Ink;
        var button = Capsule(label, Grey, color, 6, 13, new Thickness(12, 5)); button.FontWeight = FontWeight.Normal; button.IsEnabled = enabled;
        var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        content.Children.Add(Glyph(glyph, 15, color)); var text = Text(label, 13, color); text.VerticalAlignment = VerticalAlignment.Center; content.Children.Add(text);
        button.Content = content; button.Click += (_, _) => click(); return button;
    }

    // A row of a grouped list that opens something: the whole row answers the pointer and Enter / Space.
    public static Border Clickable(Control content, string name, Action click)
    {
        var row = Row(content); row.Focusable = true; row.Cursor = Hand; row.Background = Brushes.Transparent;
        AutomationProperties.SetName(row, name);
        row.PointerReleased += (_, args) => { if (args.InitialPressMouseButton == MouseButton.Left) click(); };
        row.KeyDown += (_, args) => { if (args.Key is Key.Enter or Key.Space) { click(); args.Handled = true; } };
        return row;
    }

    // The Mac DisclosureGroup: the chevron before the label, the body shown when open.
    public static Control Disclosure(string title, Control body, bool open, Action<bool> changed)
    {
        var chevron = Glyph(Icons.ChevronRight, 12, Secondary); chevron.Margin = new Thickness(0, 0, 8, 0); chevron.RenderTransformOrigin = RelativePoint.Center;
        var head = new StackPanel { Orientation = Orientation.Horizontal, Background = Brushes.Transparent, Cursor = Hand, Focusable = true, Children = { chevron, Text(title, 13) } };
        ((TextBlock)head.Children[1]).VerticalAlignment = VerticalAlignment.Center;
        body.Margin = new Thickness(19, 8, 0, 0);
        void Show() { body.IsVisible = open; chevron.RenderTransform = new RotateTransform(open ? 90 : 0); }
        void Toggle() { open = !open; Show(); changed(open); }
        head.PointerReleased += (_, args) => { if (args.InitialPressMouseButton == MouseButton.Left) Toggle(); };
        head.KeyDown += (_, args) => { if (args.Key is Key.Enter or Key.Space) { Toggle(); args.Handled = true; } };
        AutomationProperties.SetName(head, title); Show();
        return new StackPanel { Children = { head, body } };
    }

    // A text field with its label on the left and its value on the right, and the problem (red) under it.
    public static (Border Row, TextBox Box, TextBlock Problem) TextRow(string label, string prompt, string value)
    {
        var (field, box) = Field(prompt, value); box.TextAlignment = TextAlignment.Right; box.FontSize = 13;
        AutomationProperties.SetName(box, label);
        var line = new Grid { ColumnDefinitions = new ColumnDefinitions("110,*") };
        var caption = Text(label, 13); caption.VerticalAlignment = VerticalAlignment.Center; line.Children.Add(caption); Grid.SetColumn(field, 1); line.Children.Add(field);
        var problem = Text("", 12, Red, null, new Thickness(0, 4, 0, 0)); problem.IsVisible = false;
        return (Row(new StackPanel { Children = { line, problem } }), box, problem);
    }

    public static string? Value(ComboBox combo) => (combo.SelectedItem as FormOption)?.Id;
    public static void Select(ComboBox combo, string id) => combo.SelectedItem = ((IEnumerable<FormOption>)combo.ItemsSource!).First(item => item.Id == id);
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
                group.Add(Row(TerminalParts.IconRow(Icons.PlusCircle, "端末を追加", Violet, add)));
                Children.Add(FormSection("登録した端末", group, "メンバーの席を、BellTeamの外のMac・Windows PC・Linuxマシンで動かす時に使います。鍵は状態だけを表示し、中身は表示しません。"));
                if (model.ReadError is { } error) Children.Add(FormSection(null, new GroupCard(Row(Banner("最新の一覧を読み込めませんでした。前に読んだ一覧を表示しています。")), Row(Text(error, 12, Secondary)))));
                break;
        }
    }

    private Control TerminalRow(Terminal terminal)
    {
        var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("30,*,Auto") };
        var tile = Tile(SettingsPage.Terminals, 30); tile.VerticalAlignment = VerticalAlignment.Top; tile.Margin = new Thickness(0, 3, 0, 0); grid.Children.Add(tile);
        var lines = new StackPanel { Margin = new Thickness(12, 0, 8, 0) };
        lines.Children.Add(Text(terminal.TerminalId, 16, Ink, FontWeight.Medium));
        lines.Children.Add(Text($"{terminal.Address} · {terminal.OsLabel} · {terminal.OwnerLabel}", 14, Secondary, null, new Thickness(0, 3, 0, 0)));
        var badges = new WrapPanel { Margin = new Thickness(0, 3, 0, 0) };
        void Badge(string glyph, string text, IBrush color) { var badge = TerminalParts.IconLabel(glyph, text, color, 12); badge.Margin = new Thickness(0, 0, 14, 0); badges.Children.Add(badge); }
        var ssh = TerminalParts.KeyLook(terminal.Key(TerminalKeyKind.Ssh), terminal.SshKeyConfigured); Badge(ssh.Glyph, $"{TerminalKeyKind.Ssh.Title()} {ssh.Text}", ssh.Color);
        if (terminal.SudoKeyConfigured || terminal.SudoKeyPending) { var sudo = TerminalParts.KeyLook(terminal.Key(TerminalKeyKind.Sudo), terminal.SudoKeyConfigured); Badge(sudo.Glyph, $"{TerminalKeyKind.Sudo.Title()} {sudo.Text}", sudo.Color); }
        if (model.Checks.TryGetValue(terminal.TerminalId, out var check)) Badge(SettingsIcons.Bolt, check.Summary, check.Reachable ? TerminalParts.Mint : Red);
        lines.Children.Add(badges); Grid.SetColumn(lines, 1); grid.Children.Add(lines);
        var chevron = Glyph(Icons.ChevronRight, 14, Secondary); chevron.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(chevron, 2); grid.Children.Add(chevron);
        return TerminalParts.Clickable(grid, terminal.TerminalId, () => open(terminal.TerminalId));
    }
}

// One terminal: where it connects, whether it can be reached, its host key, its keys and the last Claude Code upkeep.
internal sealed class TerminalDetailView : Grid, IDisposable
{
    private readonly LinuxWorkspace workspace;
    private readonly TerminalsModel model;
    private readonly string id;
    private readonly CancellationToken token;
    // Opens the secret input window for a request and completes when it was closed; the callback gets the request when it was submitted or declined.
    private readonly Func<SecretRequest, Action<SecretRequest>, Task> openSecret;
    private readonly StackPanel body = new() { Margin = new Thickness(20, 28, 20, 24), MaxWidth = 720 };
    private readonly Grid alertLayer = new() { Background = new SolidColorBrush(Color.FromArgb(0x59, 0, 0, 0)), IsVisible = false, ZIndex = 5 };
    private string? errorText;
    private bool working, keysRouteMissing, otherWaysOpen, disposed;
    private CancellationTokenSource? awaiting;
    public Button EditButton { get; }
    // Render seams.
    internal bool OtherWaysOpen { get => otherWaysOpen; set { otherWaysOpen = value; Render(); } }

    public TerminalDetailView(LinuxWorkspace workspace, string id, CancellationToken token, Func<SecretRequest, Action<SecretRequest>, Task>? openSecret = null)
    {
        this.workspace = workspace; model = workspace.Terminals; this.id = id; this.token = token;
        this.openSecret = openSecret ?? ((request, completed) => TopLevel.GetTopLevel(this) is Window owner ? SecretInputWindow.ShowAsync(owner, request, submission => workspace.FinishSecretAsync(request.Id, submission), () => workspace.SecretKeysAsync(request.Id), completed) : throw new InvalidOperationException("入力欄を開く窓がありません。"));
        EditButton = Capsule("編集", Brushes.White, Ink, 16, 13, new Thickness(14, 6)); AutomationProperties.SetName(EditButton, "編集");
        EditButton.Click += (_, _) => { if (model.Find(id) is { } terminal) OpenSheet("端末を編集", new TerminalEditorView(workspace, model, terminal)); };
        var scroller = new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
        Children.Add(scroller); Children.Add(alertLayer);
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
        if (TopLevel.GetTopLevel(this) is not ISheetHost host) { view.Dispose(); workspace.ReportActionError("この画面では開けません。"); return; }
        view.Closer = host.CloseSheet; host.OpenSheet(title, view);
    }

    private void Render()
    {
        if (disposed) return;
        EditButton.IsEnabled = Current is not null && !working;
        body.Children.Clear();
        if (Current is not { } terminal) { body.Children.Add(FormSection(null, new GroupCard(Row(TerminalParts.Calm("この端末の登録が見つかりません。一覧へ戻って読み直してください。"))))); return; }
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
        body.Children.Add(FormSection(null, new GroupCard(Row(TerminalParts.IconRow(SettingsIcons.Trash, "端末の登録を消す", Red, working ? null : AskRemove)))));
        if (errorText is not null) body.Children.Add(FormSection(null, new GroupCard(Row(Banner(errorText)))));
    }

    private GroupCard ReachabilityGroup(Terminal terminal)
    {
        var group = new GroupCard(); var check = Check;
        var block = new StackPanel();
        var head = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        if (check is not null) head.Children.Add(TerminalParts.IconLabel(SettingsIcons.Bolt, check.Summary, check.Reachable ? TerminalParts.Mint : Red, 14, FontWeight.SemiBold));
        else head.Children.Add(Text("まだ確かめていません", 14, Secondary));
        if (check?.ObservedAt is { } observed) { var time = Text(TerminalParts.ShortTime(observed), 12, Secondary); time.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(time, 1); head.Children.Add(time); }
        block.Children.Add(head);
        if (check?.Explanation(terminal.Os) is { } explanation) block.Children.Add(Text(explanation, 14, Ink, null, new Thickness(0, 6, 0, 0)));
        if (check?.ExtraAction is { } extra) block.Children.Add(Text("サーバーの案内: " + extra, 12, Secondary, null, new Thickness(0, 4, 0, 0)));
        AutomationProperties.SetName(block, "つながるか: " + (check?.Summary ?? "まだ確かめていません"));
        group.Add(Row(block));
        model.Authorizations.TryGetValue(id, out var state);
        switch (state)
        {
            case AuthorizeState.Waiting waiting: group.Add(Row(Text(waiting.ReadFailed ? TerminalAuthorize.ReadFailedText : TerminalAuthorize.WaitingText(terminal.Os), 14, Ink))); break;
            case AuthorizeState.Shown shown: group.Add(Row(Text(shown.Note.Text, 14, Ink))); break;
        }
        if ((state is null && check?.OffersAuthorize == true) || state?.Retry == true)
            group.Add(Row(TerminalParts.IconRow(SettingsIcons.Key, $"この{TerminalOS.Machine(terminal.Os)}にこの鍵を入れる", Violet, working || Checking ? null : () => _ = AuthorizeKeyAsync())));
        var press = TerminalParts.IconRow(SettingsIcons.Bolt, "つながるか確かめる", Violet, Checking || working ? null : () => _ = RunCheckAsync());
        if (Checking) { var busy = Text("確かめています…", 12, Secondary); busy.HorizontalAlignment = HorizontalAlignment.Right; busy.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(busy, 1); press.Children.Add(busy); }
        group.Add(Row(press));
        return group;
    }

    private GroupCard HostKeyGroup(Terminal terminal)
    {
        var group = new GroupCard();
        var status = HostKeyReported ? terminal.HostTrusted ? "変わりました" : "まだ確かめていません" : terminal.HostTrusted ? "信用しています" : "まだ確かめていません";
        var warn = !terminal.HostTrusted || HostKeyReported;
        var line = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        line.Children.Add(Text("ホスト鍵", 13));
        var value = TerminalParts.IconLabel(warn ? SettingsIcons.ShieldWarn : SettingsIcons.ShieldOk, status, warn ? Orange : TerminalParts.Mint); Grid.SetColumn(value, 1); line.Children.Add(value);
        group.Add(Row(line));
        if (HostKeyReported)
        {
            var other = new StackPanel();
            other.Children.Add(Text($"その{TerminalOS.Machine(terminal.Os)}にBellTeamアプリが無い時や、うまく確かめられない時は、端末で読んだ指紋を入れて確かめます。", 14, Secondary));
            var confirm = TerminalParts.Bordered(SettingsIcons.Key, "ホスト鍵を確かめる", () => OpenSheet("ホスト鍵", new HostKeyView(workspace, model, terminal, Check)), enabled: !working); confirm.HorizontalAlignment = HorizontalAlignment.Left; confirm.Margin = new Thickness(0, 10, 0, 0);
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

    private Control KeyRow(TerminalKeyKind kind, Terminal terminal)
    {
        var state = keysRouteMissing ? TerminalKeyState.Unsupported : terminal.Key(kind);
        var look = TerminalParts.KeyLook(state, kind == TerminalKeyKind.Ssh ? terminal.SshKeyConfigured : terminal.SudoKeyConfigured);
        var stack = new StackPanel();
        var head = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        var names = new StackPanel(); names.Children.Add(Text(kind.Title(), 13));
        names.Children.Add(Text(kind == TerminalKeyKind.Ssh ? "必須。これが無いと端末につなげません。" : "任意。自分の端末では不要です。", 11, Secondary, null, new Thickness(0, 2, 0, 0)));
        head.Children.Add(names);
        var right = new StackPanel { HorizontalAlignment = HorizontalAlignment.Right }; right.Children.Add(TerminalParts.IconLabel(look.Glyph, look.Text, look.Color, 14));
        if (state.SourceText is { } source) right.Children.Add(Right(Text(source, 11, Secondary, null, new Thickness(0, 3, 0, 0))));
        Grid.SetColumn(right, 1); head.Children.Add(right); stack.Children.Add(head);
        AutomationProperties.SetName(head, $"{kind.Title()}: {look.Text}{(state.SourceText is null ? "" : "、" + state.SourceText)}");
        if (state.Status == TerminalKeyStatus.Pending) stack.Children.Add(Text($"入力を待っています。入力欄を閉じた時は「{state.SetTitle}」でもう一度開けます。", 11, Secondary, null, new Thickness(0, 8, 0, 0)));
        if (state.Status != TerminalKeyStatus.Unsupported)
        {
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 2) };
            var set = TerminalParts.Bordered(SettingsIcons.Key, state.SetTitle, () => _ = SetKeyAsync(kind), enabled: !working); set.Margin = new Thickness(0, 0, 10, 0); buttons.Children.Add(set);
            if (state.Removable) buttons.Children.Add(TerminalParts.Bordered(SettingsIcons.Remove, "外す", () => AskRemoveKey(kind), destructive: true, enabled: !working));
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
            await openSecret(request, _ => { });
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
                await openSecret(request, result => { if (result.Status == "submitted") WaitForOutcome(result.Id); });
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
        alertLayer.Children.Add(EditorFormView.AlertFrame(title, message, () => alertLayer.IsVisible = false, new AlertChoice(accept, act, Destructive: true), new AlertChoice("キャンセル", Bold: true)));
        alertLayer.IsVisible = true;
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

    public TerminalEditorView(LinuxWorkspace workspace, TerminalsModel model, Terminal? initial) : base(workspace)
    {
        this.model = model; this.initial = initial; draft = initial is null ? new TerminalDraft() : new TerminalDraft(initial);
        // Step 1: the one precondition nobody can see from here, said before the form (per OS).
        if (initial is null)
        {
            var line = new Grid { ColumnDefinitions = new ColumnDefinitions("26,*") };
            var info = Glyph(SettingsIcons.Info, 18, Secondary); info.HorizontalAlignment = HorizontalAlignment.Left; info.VerticalAlignment = VerticalAlignment.Top; line.Children.Add(info); Grid.SetColumn(precondition, 1); line.Children.Add(precondition);
            Form.Children.Add(FormSection(null, new GroupCard(Row(line))));
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
        picker.SelectionChanged += (_, _) => { if (TerminalParts.Value(picker) is { } os) { draft.Os = os; Sync(); } };
        Form.Children.Add(FormSection("SSHの接続先", new GroupCard(host.Row, user.Row, port.Row, Labeled("OS", picker)), "端末のOSを選びます。フォルダのパスの形と、つなぐための案内がOSで変わります。"));
        var owner = new GroupCard();
        foreach (var (value, label) in new[] { ("owner", "自分の端末"), ("terminal-owner", "その端末の持ち主") })
        {
            var choice = Violeted(new RadioButton { GroupName = "terminal-owner", FontSize = 13, Content = label, IsChecked = draft.AccountOwner == value });
            AutomationProperties.SetName(choice, label);
            choice.IsCheckedChanged += (_, _) => { if (choice.IsChecked == true) { draft.AccountOwner = value; Sync(); } };
            owner.Add(Row(choice));
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
        row.Box.TextChanged += (_, _) => { set(row.Box.Text ?? ""); ShowProblems(); };
    }
    internal TextBox Box(TerminalField field) => fields[field].Box;
    internal ComboBox OsPicker { get; }

    // The texts that name the OS follow it.
    private void Sync()
    {
        var machine = TerminalOS.Machine(draft.Os);
        precondition.Text = $"{TerminalOS.SshStep(draft.Os)}BellTeamがSSHでつなぐのに必要です。";
        ownerFooter.Text = draft.AccountOwner == "owner" ? $"あなた自身の{machine}です。メンバーはあなたのClaudeアカウントを使えます。" : $"ほかの人の{machine}です。その端末のClaudeログインを使い、あなたのアカウントは渡りません。";
        keysNote.Text = TerminalOS.UsesSudoKey(draft.Os) ? "SSH鍵とsudo鍵は、登録した後に端末の画面で設定します。鍵の中身はここに入れません。" : "SSH鍵は、登録した後に端末の画面で設定します。Windowsはsudo鍵を使いません。鍵の中身はここに入れません。";
    }

    private void ShowProblems()
    {
        var problems = draft.Problems(initial is null);
        foreach (var (field, (box, caption)) in fields)
        {
            var shown = problems.TryGetValue(field, out var text) && (attempted || (box.Text ?? "").Length != 0);
            caption.Text = shown ? text! : ""; caption.IsVisible = shown;
        }
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
        try { await model.SaveAsync(draft.TerminalId, draft, Token); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception error) { SetError(TerminalErrorText.Message(error)); return; }
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

    public HostKeyView(LinuxWorkspace workspace, TerminalsModel model, Terminal terminal, TerminalCheck? check) : base(workspace)
    {
        this.model = model; this.terminal = terminal; this.check = check;
        var mono = BellTheme.Mono;
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
        var (field, box) = Field("SHA256:…", "", multiline: true, minHeight: 20); input = box; input.FontFamily = mono; input.FontSize = 14;
        AutomationProperties.SetName(input, "端末で読んだ指紋");
        var typed = new StackPanel { Children = { field, problem, answer } };
        Form.Children.Add(FormSection("端末で読んだ指紋", new GroupCard(Row(typed)), "BellTeamは端末の鍵をもう一度読み、入れた指紋と同じ時だけ信用し直します。違う時は何も変えません。"));
        if (!terminal.SshKeyConfigured) Form.Children.Add(FormSection(null, new GroupCard(Row(Banner("先にSSH鍵を設定してください。鍵が無いと、BellTeamは端末のホスト鍵を読みに行けません。")))));
        input.TextChanged += (_, _) => { entered = (input.Text ?? "").Trim(); Show(); Notify(); };
        Show(); Ready = true; Notify();
    }
    public override string SaveLabel => "信用する";
    protected override bool SaveBlocked => HostKeyFingerprint.Problem(entered) is not null || !terminal.SshKeyConfigured;
    internal TextBox Input => input;

    private void Show()
    {
        var found = HostKeyFingerprint.Problem(entered);
        problem.Text = entered.Length != 0 && found is not null ? found : ""; problem.IsVisible = problem.Text.Length != 0;
        if (check?.ReportedFingerprint is { } reported && found is null)
        {
            var same = entered == reported;
            match.Text = same ? "入れた指紋と一致しています" : "入れた指紋と一致しません"; match.Foreground = same ? TerminalParts.Mint : Red; match.Margin = new Thickness(0, 8, 0, 0); match.IsVisible = true;
        }
        else match.IsVisible = false;
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
