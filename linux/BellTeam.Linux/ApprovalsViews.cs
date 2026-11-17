using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Shapes;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using BellTeam.Core;
using static BellTeam.Linux.LatticeLook;

namespace BellTeam.Linux;

// Drawing of the 決裁箱 window: toolbar, list, 詳細, 工程とのつながり and the failure views. Words and decisions come from Core's `Approvals`; nothing here shows an id, a code or a path.
internal sealed partial class ApprovalsWindow
{
    // Glyphs in the Lattice 1.7 stroke style (24 x 24).
    internal const string Inbox = "M4,13 L6.5,5 H17.5 L20,13 V19 H4 Z M4,13 H9 L10,15.5 H14 L15,13 H20", Bolt = "M13,3 L6,13.5 H11.5 L10.5,21 L18,10 H12.5 Z", Pause = "M9,6 V18 M15,6 V18",
        Copy = "M9,9 H19 V20 H9 Z M5,15 V4 H15", Pencil = "M4,20 L5,15 L16,4 L20,8 L9,19 Z M14,6 L18,10", Lock = "M6,11 H18 V20 H6 Z M8.5,11 V8 a3.5,3.5 0 0 1 7,0 V11",
        Globe = "M12,3 a9,9 0 1 0 0.01,0 Z M3,12 H21 M12,3 C8,7 8,17 12,21 M12,3 C16,7 16,17 12,21", Terminal = "M4,5 H20 V19 H4 Z M7,9 L10,12 L7,15 M12,15 H17", XMark = "M6,6 L18,18 M18,6 L6,18",
        Seal = "M12,3 a9,9 0 1 0 0.01,0 Z M7.5,12.5 L10.5,15.5 L16.5,9";
    private static string Glyph(string name) => name switch { "inbox" => Inbox, "bolt" => Bolt, "pause" => Pause, "pencil" => Pencil, "globe" => Globe, "xmark" => XMark, "seal" => Seal, _ => Inbox };
    private static Color Tone(string tone) => tone switch { "vio" => Violet, "ok" => Done, "amb" => Amber, "ind" => Slate, _ => Muted };

    internal Func<string, string, Task<Bitmap>> Avatar
        => (id, version) => workspace.AvatarAsync($"{workspace.Server}api/bots/{Uri.EscapeDataString(id)}/avatar?v={Uri.EscapeDataString(version)}");
    private LatticePerson? Person(ApprovalRequester? member)
    {
        if (member is null) return null;
        var bot = workspace.Bots.FirstOrDefault(item => item.Id == member.BotId);
        return bot is null ? new LatticePerson("", LatticeChart.UnknownMember, null, "", false) : new LatticePerson(bot.Id, bot.DisplayName, bot.Color, bot.AvatarVersion, true);
    }
    // A BellTeam member keeps the roster face; anyone else gets a grey rounded-square tool tile, never a member colour.
    private Control Face(ApprovalOriginView origin, double size)
    {
        if (origin.Member is not null) return new LatticeAvatar(Person(origin.Member), size, Avatar);
        var glyph = origin.Tile switch { "terminal" => Terminal, "chat" => Icons.Chat, _ => Globe };
        return new Border { Width = size, Height = size, CornerRadius = new CornerRadius(size * .28), Background = Brush(Muted, 0x24), VerticalAlignment = VerticalAlignment.Center, Child = Icon(glyph, size * .56, Muted) };
    }
    private static Border Chip(string text, Color tone, string? glyph = null, bool link = false)
    {
        Control mark = link ? Shape(LinkGeometry, 11, tone) : glyph is null ? new Border() : Icon(glyph, 12, tone);
        var content = glyph is null && !link ? Row(Text(text, 11.5, tone, FontWeight.SemiBold)) : Row(mark, Spaced(Text(text, 11.5, tone, FontWeight.SemiBold), 5));
        return Pill(content, tone, 0x1F, new Thickness(9, 3, 10, 3));
    }
    private static Border BadgePill(ApprovalBadge badge) => Chip(badge.Text, Tone(badge.Tone), badge.Glyph.Length > 0 ? Glyph(badge.Glyph) : null);
    private static Control Dashed(Control child, double radius = 16, Color? tone = null) => new Grid { Children = { new Rectangle { Stroke = Brush(tone ?? Muted, 0x70), StrokeThickness = 1.2, StrokeDashArray = [4, 3], RadiusX = radius, RadiusY = radius, IsHitTestVisible = false }, child } };

    // ---- the window
    private void Render()
    {
        // A phone's detail view gives the whole page to the detail: no tabs and counters above it.
        toolbarHost.Content = Compact && Selected is not null && Status == ApprovalFeedStatus.Live ? null : Toolbar();
        body.Content = Status switch
        {
            ApprovalFeedStatus.Old => Gate(Globe, Approvals.Old, [("閉じる", false, Close)]),
            ApprovalFeedStatus.NotEntitled => Gate(Lock, Approvals.NotEntitled, [("契約を確かめる", true, hub.ReadAgain), ("閉じる", false, Close)]),
            ApprovalFeedStatus.Expired => Gate(Lock, Approvals.Expired, [("読み直す", true, hub.ReadAgain), ("閉じる", false, Close)]),
            ApprovalFeedStatus.NoCredential => ConnectGate(),
            ApprovalFeedStatus.LoginRequired => Gate(Lock, "ログインが必要です。ログインし直すと、自動で表示します。", [("読み直す", true, hub.ReadAgain), ("閉じる", false, Close)]),
            _ when open is null && tab != "done" => Loading(),
            _ => Columns()
        };
    }
    private Control Loading() => new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Spacing = 12, Children = { Spinner(22), Text(Approvals.Loading, 14, Muted) } };

    private Control Gate(string glyph, string message, (string Label, bool Primary, Action Click)[] actions)
    {
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 16, 0, 0) };
        foreach (var (label, primary, click) in actions) { var button = Action(label, null, primary); button.Click += (_, _) => click(); buttons.Children.Add(button); }
        var card = Glass(new StackPanel { Spacing = 10, Children = { new Border { Child = Icon(glyph, 26, Violet), HorizontalAlignment = HorizontalAlignment.Center }, Text(message, 14.5, Ink, wrap: true), buttons } }, 22, new Thickness(26, 24));
        card.MaxWidth = 520; card.HorizontalAlignment = HorizontalAlignment.Center; card.VerticalAlignment = VerticalAlignment.Center;
        return card;
    }

    // view 4: not connected → 決裁箱につなぐ; the browser shows Approval Box's own consent page, never BellTeam's.
    private Control ConnectGate()
    {
        var text = connect switch { Connect.Waiting or Connect.Opening => Approvals.Waiting, Connect.Denied => Approvals.Denied, _ => Approvals.NoCredential };
        var stack = new StackPanel { Spacing = 10 };
        stack.Children.Add(new Border { Child = Icon(Lock, 26, Violet), HorizontalAlignment = HorizontalAlignment.Center });
        stack.Children.Add(Text(text, 14.5, Ink, wrap: true));
        if (connect is Connect.Waiting or Connect.Opening) stack.Children.Add(new Border { Child = Spinner(20), HorizontalAlignment = HorizontalAlignment.Center });
        if (connectNote is { Length: > 0 }) stack.Children.Add(Text(connectNote, 13, Amber, wrap: true));
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 0) };
        void Add(string label, bool primary, Action click) { var button = Action(label, null, primary); button.Click += (_, _) => click(); buttons.Children.Add(button); }
        switch (connect)
        {
            case Connect.Waiting: Add("もう一度開く", true, () => { if (connectUrl is { } url && !OpenUrl(url)) { connectNote = "決裁箱の画面が開かなかったようです。「もう一度開く」を押してください。"; Render(); } }); Add("やめる", false, () => _ = StopConnectAsync()); break;
            case Connect.Opening: break;
            case Connect.Denied: Add("もう一度つなぐ", true, () => _ = StartConnectAsync()); break;
            default: Add("決裁箱につなぐ", true, () => _ = StartConnectAsync()); Add("読み直す", false, hub.ReadAgain); break;
        }
        stack.Children.Add(buttons);
        var card = Glass(stack, 22, new Thickness(26, 24)); card.MaxWidth = 520; card.HorizontalAlignment = HorizontalAlignment.Center; card.VerticalAlignment = VerticalAlignment.Center;
        return card;
    }

    // ---- toolbar: title + count, live, 待ち / 保留 / 済み, ring 今日の回答, counters, 読み直す
    private Control Toolbar()
    {
        var counts = Approvals.CountsOf(Summary); var wrap = new WrapPanel { Margin = new Thickness(18, 14, 18, 4) };
        var title = Glass(Row(Icon(Inbox, 18, Violet), Spaced(Text("決裁箱", 18, Ink, FontWeight.Bold), 8), counts.Pending > 0 ? Spaced(Pill(Text(counts.Pending.ToString(), 12, Colors.White, FontWeight.Bold), Violet, 0xFF, new Thickness(8, 1, 8, 1)), 8) : new Border()), 14, new Thickness(14, 8, 16, 8));
        AutomationProperties.SetName(title, counts.Pending > 0 ? $"決裁箱、回答待ち{counts.Pending}件" : "決裁箱");
        wrap.Children.Add(title);
        var dropped = Status == ApprovalFeedStatus.Drop || listProblem is not null;
        if (dropped) wrap.Children.Add(Spaced(Pill(Row(Spinner(13), Spaced(Text(Approvals.Reconnect, 12.5, Ink), 8)), Muted, 0x18, new Thickness(12, 6, 14, 6)), 12));
        else if (Status == ApprovalFeedStatus.Live) wrap.Children.Add(Spaced(Pill(Row(new Ellipse { Width = 7, Height = 7, Fill = Brush(Done) }, Spaced(Text("ライブ", 12.5, Done, FontWeight.SemiBold), 6)), Done, 0x1F, new Thickness(11, 6, 13, 6)), 12));
        wrap.Children.Add(Spaced(Segmented(counts), 16));
        wrap.Children.Add(Spaced(Row(new LatticeRing(counts.Answered, counts.Filed, 40), Spaced(new StackPanel { VerticalAlignment = VerticalAlignment.Center, Children = { Text("今日の回答", 11, Muted), Text($"{counts.Answered} / {counts.Filed}", 14, Ink, FontWeight.SemiBold) } }, 8),
            Counter("待ち", counts.Pending, Violet, 22), Counter("急ぎ", counts.Urgent, Amber, 8), Counter("保留", counts.Held, Muted, 8)), 22));
        var again = Action("読み直す", null); again.Margin = new Thickness(16, 0, 0, 0); again.Click += (_, _) => { hub.ReadAgain(); _ = ReadOpenAsync(); if (tab == "done") _ = ReadDoneAsync(false); }; wrap.Children.Add(again);
        return wrap;
    }
    private Border Counter(string label, int count, Color color, double left)
    {
        var pill = Pill(Row(Text(label, 12.5, Ink), Spaced(Text(count.ToString(), 14, color, FontWeight.Bold), 6)), Colors.White, 0xB3, new Thickness(12, 6, 13, 6));
        pill.BorderBrush = Brush(Colors.White); pill.BorderThickness = new Thickness(1); pill.Margin = new Thickness(left, 0, 0, 0); AutomationProperties.SetName(pill, $"{label} {count}"); return pill;
    }
    private Control Segmented(ApprovalCounts counts)
    {
        var held = open?.Count(item => item.Status == "held") ?? counts.Held; var pending = open?.Count(item => item.Status == "pending") ?? counts.Pending;
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        void Add(string value, string label, int n)
        {
            var on = tab == value;
            var button = Plain(new Border { Padding = new Thickness(16, 7), CornerRadius = new CornerRadius(10), Background = on ? Brushes.White : Brushes.Transparent, Child = Text(n < 0 ? label : $"{label}  {n}", 13, on ? Ink : Muted, on ? FontWeight.SemiBold : FontWeight.Normal) }, n < 0 ? label : $"{label} {n}件");
            button.Click += (_, _) => SetTab(value); row.Children.Add(button);
        }
        Add("pending", "待ち", pending); Add("held", "保留", held); Add("done", "済み", doneRead ? done.Count : -1);
        return new Border { Background = Brush(Muted, 0x1A), CornerRadius = new CornerRadius(12), Padding = new Thickness(3), Child = row };
    }

    // ---- three columns
    private Control Columns()
    {
        if (Compact) return CompactColumns();
        var grid = new Grid { Margin = new Thickness(14, 6, 14, 14) };
        grid.ColumnDefinitions.Add(new ColumnDefinition(new GridLength(500, GridUnitType.Star)) { MinWidth = 360 });
        grid.ColumnDefinitions.Add(new ColumnDefinition(new GridLength(520, GridUnitType.Star)) { MinWidth = 380 });
        grid.ColumnDefinitions.Add(new ColumnDefinition(new GridLength(340, GridUnitType.Star)) { MinWidth = 300 });
        var list = ListColumn(); var detail = DetailColumn(Selected); var chain = ChainColumn(Selected);
        Grid.SetColumn(detail, 1); Grid.SetColumn(chain, 2);
        grid.Children.Add(list); grid.Children.Add(detail); grid.Children.Add(chain);
        grid.Opacity = Status == ApprovalFeedStatus.Drop || listProblem is not null ? .6 : 1;
        return grid;
    }

    // A phone shows one column at a time: the list, and after a pick the detail with the chain under it and a way back to the list.
    internal bool Compact { get; set; }
    private Control CompactColumns()
    {
        if (Selected is not { } decision) return new Border { Margin = new Thickness(10, 6, 10, 10), Child = ListColumn() };
        var back = Action("一覧へ", null); back.HorizontalAlignment = HorizontalAlignment.Left; back.Margin = new Thickness(4, 0, 0, 8); back.Click += (_, _) => { SelectedId = null; ResetStep(); Render(); };
        var detail = DetailColumn(decision); var chain = ChainColumn(decision);
        return new ScrollViewer { VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto, Content = new StackPanel { Margin = new Thickness(14, 6, 14, 14), Spacing = 12, Children = { back, detail, chain } } };
    }

    // ---- list
    private Control ListColumn()
    {
        var stack = new StackPanel { Margin = new Thickness(4, 0, 12, 12), Spacing = 10 };
        var pendingAll = (open ?? []).Where(item => item.Status == "pending").ToList(); var heldAll = (open ?? []).Where(item => item.Status == "held").ToList();
        var baseList = tab == "done" ? done : tab == "held" ? heldAll : pendingAll;
        var counts = Approvals.OriginCounts(tab == "done" ? done : tab == "held" ? heldAll : pendingAll);
        stack.Children.Add(OriginRow(counts));
        if (filter != "all" && (filter == "bellteam" ? counts.External : counts.Bellteam) is > 0 and var hidden)
        {
            var show = Action("すべてを見る", null); show.Margin = new Thickness(10, 0, 0, 0); show.Click += (_, _) => { filter = "all"; Render(); };
            stack.Children.Add(Pill(Row(Icon(Globe, 13, Amber), Spaced(Text(filter == "bellteam" ? $"外部の決裁 {hidden}件を隠しています。" : $"BellTeamの決裁 {hidden}件を隠しています。", 12.5, Amber, FontWeight.SemiBold), 6), show), Amber, 0x1A, new Thickness(12, 4, 6, 4)));
        }
        var shown = Approvals.OriginFilter(baseList, filter);
        if (tab == "done")
        {
            if (!doneRead) stack.Children.Add(Loading());
            else if (shown.Count == 0) stack.Children.Add(Text(Approvals.EmptyDone, 13.5, Muted, wrap: true));
            foreach (var group in Approvals.GroupDone(shown, Now()))
            {
                stack.Children.Add(new TextBlock { Text = group.Heading, FontSize = 12, Foreground = Brush(Muted), FontWeight = FontWeight.SemiBold, Margin = new Thickness(4, 10, 0, 0) });
                foreach (var row in group.Rows) stack.Children.Add(DoneRow(row));
            }
            if (doneCursor is not null) { var more = Action("もっと見る", null); more.Click += (_, _) => _ = ReadDoneAsync(true); stack.Children.Add(more); }
        }
        else
        {
            if (shown.Count == 0)
            {
                stack.Children.Add(Text(baseList.Count > 0 ? "絞り込みに合う決裁はありません。" : tab == "held" ? Approvals.EmptyHeld : Approvals.EmptyPending, 13.5, Muted, wrap: true));
                if (tab == "pending" && baseList.Count == 0) { var seen = Action("済みを見る", null); seen.Click += (_, _) => SetTab("done"); stack.Children.Add(seen); }
            }
            foreach (var item in shown) stack.Children.Add(Card(item));
            if (tab == "pending" && Approvals.OriginFilter(heldAll, filter) is { Count: > 0 } held)
            {
                stack.Children.Add(new Border { BorderBrush = Brush(LatticeLook.Line), BorderThickness = new Thickness(0, 1, 0, 0), Margin = new Thickness(0, 6, 0, 0), Padding = new Thickness(0, 10, 0, 0), Child = Row(Icon(Pause, 13, Muted), Spaced(Text($"保留 {held.Count}", 12.5, Muted, FontWeight.SemiBold), 6)) });
                foreach (var item in held) stack.Children.Add(Card(item));
            }
        }
        return new ScrollViewer { HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled, Content = stack };
    }

    private Control OriginRow(ApprovalOriginCounts counts)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(2, 4, 0, 2) };
        void Add(string value, string label, int n)
        {
            var on = filter == value;
            var button = Plain(Pill(Text($"{label} {n}", 12.5, on ? Colors.White : Ink, FontWeight.SemiBold), on ? Violet : Muted, on ? (byte)0xFF : (byte)0x18, new Thickness(12, 5, 12, 5)), $"{label} {n}件");
            button.Margin = new Thickness(0, 0, 8, 0); button.Click += (_, _) => { filter = value; Render(); }; row.Children.Add(button);
        }
        Add("all", "すべて", counts.All); Add("bellteam", "BellTeam", counts.Bellteam); Add("external", "外部", counts.External);
        return row;
    }

    private Control Card(ViewDecision decision)
    {
        var row = Approvals.CardRow(decision, Now()); var held = decision.Status == "held"; var selected = SelectedId == decision.Id;
        var badges = new WrapPanel { Margin = new Thickness(0, 0, 0, 6) };
        foreach (var badge in row.Badges) { var pill = BadgePill(badge); pill.Margin = new Thickness(0, 0, 6, 4); badges.Children.Add(pill); }
        var age = Text(row.Age, 11.5, Muted); age.VerticalAlignment = VerticalAlignment.Top;
        var top = new DockPanel(); DockPanel.SetDock(age, Dock.Right); top.Children.Add(age); top.Children.Add(badges);
        var who = Row(Face(row.Origin, 22), Spaced(Text(row.Origin.Name, 12.5, Muted), 8)); who.Margin = new Thickness(0, 6, 0, 0);
        var stack = new StackPanel { Children = { top, new TextBlock { Text = row.Title, FontSize = 15, FontWeight = FontWeight.SemiBold, Foreground = Brush(Ink), TextWrapping = TextWrapping.Wrap, MaxLines = 2, TextTrimming = TextTrimming.CharacterEllipsis }, who } };
        var noteColor = row.Note.Tone is "muted" ? Muted : row.Note.Tone == "link" ? Violet : Ink;
        var noteRow = Row(row.Note.Tone == "link" ? Shape(LinkGeometry, 11, Violet) : row.Note.Tone == "muted" ? Shape(LinkGeometry, 11, Muted) : new Border(), Spaced(Text(row.Note.Text, 12.5, noteColor, wrap: true), 6)); noteRow.Margin = new Thickness(0, 6, 0, 0); stack.Children.Add(noteRow);
        if (row.Chips.Count > 0) { var chips = new WrapPanel { Margin = new Thickness(0, 8, 0, 0) }; foreach (var chip in row.Chips) { var pill = Chip(chip, chip.StartsWith("期限", StringComparison.Ordinal) ? Amber : Violet); pill.Margin = new Thickness(0, 0, 6, 0); chips.Children.Add(pill); } stack.Children.Add(chips); }
        var inner = new Border { Padding = new Thickness(row.Urgent ? 18 : 14, 12, 14, 12), Child = stack };
        var frame = new Border
        {
            CornerRadius = new CornerRadius(16), Background = Brush(Colors.White, held ? (byte)0x80 : (byte)0xE6), BorderThickness = new Thickness(selected ? 2 : 1.2), BorderBrush = Brush(held ? Muted : Violet, held ? (byte)0x50 : selected ? (byte)0xFF : (byte)0x90),
            BoxShadow = held ? default : new BoxShadows(new BoxShadow { Blur = 22, Color = Color.FromArgb(row.Urgent ? (byte)0x30 : (byte)0x2A, Violet.R, Violet.G, Violet.B) })
        };
        Control content;
        if (held) content = Dashed(inner);
        else
        {
            frame.Child = row.Urgent ? new Grid { Children = { inner, new Border { Width = 5, Background = Brush(Amber), CornerRadius = new CornerRadius(3), HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(7, 14, 0, 14), IsHitTestVisible = false } } } : inner;
            content = frame;
        }
        var button = Plain(content, row.Label); var id = decision.Id!; button.Click += (_, _) => Pick(id); button.HorizontalAlignment = HorizontalAlignment.Stretch; button.HorizontalContentAlignment = HorizontalAlignment.Stretch;
        return button;
    }

    private Control DoneRow(ApprovalDoneRow row)
    {
        var selected = SelectedId == row.Id;
        var title = new TextBlock { Text = row.Title, FontSize = 14, FontWeight = FontWeight.SemiBold, Foreground = Brush(row.Cancelled ? Muted : Ink), TextWrapping = TextWrapping.Wrap, TextDecorations = row.Cancelled ? TextDecorations.Strikethrough : null };
        var head = Row(Icon(row.Cancelled ? XMark : Seal, 15, row.Cancelled ? Muted : Done), Spaced(new Border { Child = title, MaxWidth = 330 }, 8));
        var tail = new WrapPanel(); if (row.Origin.External) { var external = Chip("外部から", Muted, Globe); external.Margin = new Thickness(0, 0, 6, 0); tail.Children.Add(external); }
        if (row.Delivery is { } delivery) { var pill = BadgePill(delivery); pill.Margin = new Thickness(0, 0, 6, 0); tail.Children.Add(pill); }
        var stack = new StackPanel { Children = { head, Text($"{row.Line}{(row.Time.Length > 0 ? "　" + row.Time : "")}", 12, Muted, wrap: true) } }; ((TextBlock)stack.Children[1]).Margin = new Thickness(23, 3, 0, 0);
        if (tail.Children.Count > 0) { tail.Margin = new Thickness(23, 6, 0, 0); stack.Children.Add(tail); }
        var frame = new Border { CornerRadius = new CornerRadius(14), Background = Brush(Colors.White, 0xB0), BorderBrush = Brush(selected ? Violet : LatticeLook.Line), BorderThickness = new Thickness(selected ? 2 : 1), Padding = new Thickness(12, 10), Child = stack };
        var button = Plain(frame, $"{(row.Cancelled ? "取り下げ" : "回答済み")}、{row.Title}、{row.Line}"); var id = row.Id; button.Click += (_, _) => Pick(id); button.HorizontalContentAlignment = HorizontalAlignment.Stretch;
        return button;
    }
}
