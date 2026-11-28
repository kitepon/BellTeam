using System.IO;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using BellTeam.Core;
using static BellTeam.Linux.LatticeLook;

namespace BellTeam.Linux;

// 詳細 and 工程とのつながり of the 決裁箱 window, and the answer step in place (option → confirm → 答える; or 指示を書いて返す → confirm → 答える).
internal sealed partial class ApprovalsWindow
{
    private readonly Dictionary<string, Bitmap?> pictures = [];

    private static Border Sheet(Control child) => Glass(child, 22, new Thickness(20, 18, 20, 16), 0xD9);
    private Control Heading(string text) { var label = Text(text, 12, Muted, FontWeight.SemiBold); label.Margin = new Thickness(0, 18, 0, 6); return label; }

    private Control DetailColumn(ViewDecision? decision)
    {
        var sheet = new Border { Margin = new Thickness(0, 0, 12, 0) };
        if (decision is null) { sheet.Child = Sheet(new StackPanel { VerticalAlignment = VerticalAlignment.Center, Spacing = 10, Children = { Text(LinuxStrings.ApprovalsDetail_DetailColumn_1, 14, Muted, wrap: true) } }); return sheet; }
        var origin = Approvals.OriginOf(decision); var open = decision.Status is "pending" or "held"; var stack = new StackPanel();
        var badges = new WrapPanel { Margin = new Thickness(0, 0, 0, 8) };
        foreach (var badge in Approvals.BadgesOf(decision)) { var pill = BadgePill(badge); pill.Margin = new Thickness(0, 0, 6, 4); badges.Children.Add(pill); }
        stack.Children.Add(badges);
        stack.Children.Add(new TextBlock { Text = decision.Title ?? "", FontSize = 19, FontWeight = FontWeight.Bold, Foreground = Brush(Ink), TextWrapping = TextWrapping.Wrap });
        var meta = Row(Face(origin, 26), Spaced(Text(origin.Name, 13, Muted), 8));
        var times = new List<string> { LinuxStrings.ApprovalsDetail_DetailColumn_2(Approvals.AgeText(decision.CreatedAt, Now())) };
        if (open && DateTimeOffset.TryParse(decision.Deadline, out _)) times.Add(LinuxStrings.ApprovalsDetail_DetailColumn_3(LatticeStops.StopTime(decision.Deadline, Now())));
        meta.Children.Add(Spaced(Text(LinuxStrings.ApprovalsDetail_DetailColumn_5(string.Join(LinuxStrings.ApprovalsDetail_DetailColumn_4, times.Where(item => item.Length > 3))), 12.5, Muted), 4)); meta.Margin = new Thickness(0, 10, 0, 0); stack.Children.Add(meta);
        if (banner is { Length: > 0 }) stack.Children.Add(Banner(banner, Violet));
        if (origin.External) stack.Children.Add(ExternalBlock(origin));

        stack.Children.Add(Heading(LinuxStrings.ApprovalsDetail_DetailColumn_6));
        stack.Children.Add(new SelectableTextBlock { Text = decision.Context ?? "", FontSize = 14, Foreground = Brush(Ink), TextWrapping = TextWrapping.Wrap, LineHeight = 21 });
        foreach (Match match in Regex.Matches(decision.Context ?? "", @"https?://[^\s)）」』]+").Cast<Match>().DistinctBy(match => match.Value).ToArray())
        { var url = match.Value; var link = Action(url.Length > 46 ? url[..46] + "…" : url, null); link.Margin = new Thickness(0, 6, 0, 0); link.Click += (_, _) => OpenWebLink(url); AutomationProperties.SetName(link, LinuxStrings.ApprovalsDetail_DetailColumn_8); stack.Children.Add(link); }
        if (decision.RequestAttachments is { Length: > 0 } attachments) { stack.Children.Add(Heading(LinuxStrings.ApprovalsDetail_DetailColumn_9)); stack.Children.Add(Pictures(decision, attachments)); }
        if (decision.Options?.FirstOrDefault(item => item.Recommended) is { } recommended) stack.Children.Add(Gap(Text(LinuxStrings.ApprovalsDetail_DetailColumn_10(recommended.Label), 13.5, Violet, FontWeight.SemiBold), 0, 12));

        if (open) stack.Children.Add(Answering(decision));
        else stack.Children.Add(Answered(decision));
        stack.Children.Add(History(decision));
        sheet.Child = Sheet(new ScrollViewer { HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled, Content = stack });
        return sheet;
    }
    private static T Gap<T>(T element, double left, double top) where T : Control { element.Margin = new Thickness(left, top, 0, 0); return element; }

    private static Border Banner(string text, Color tone)
    {
        var mark = Icon(Pencil, 15, tone); mark.VerticalAlignment = VerticalAlignment.Top; mark.Margin = new Thickness(0, 2, 8, 0); DockPanel.SetDock(mark, Dock.Left);
        var border = Pill(new DockPanel { Children = { mark, Text(text, 13, Ink, wrap: true) } }, tone, 0x1A, new Thickness(12, 8, 12, 8)); border.Margin = new Thickness(0, 12, 0, 0); border.CornerRadius = new CornerRadius(12); return border;
    }
    private Control ExternalBlock(ApprovalOriginView origin)
    {
        var lines = new StackPanel { Children = { Text(LinuxStrings.ApprovalsDetail_ExternalBlock_1, 13.5, Ink, FontWeight.SemiBold), Text($"{origin.Tool}{(origin.Via.Length > 0 ? LinuxStrings.ApprovalsDetail_DetailColumn_5(origin.Via) : "")}{(origin.Session.Length > 0 ? LinuxStrings.ApprovalsDetail_DetailColumn_5(origin.Session) : "")}", 12.5, Muted, wrap: true) } };
        var block = new Border { CornerRadius = new CornerRadius(14), Background = Brush(Muted, 0x12), Padding = new Thickness(12, 10), Margin = new Thickness(0, 12, 0, 0), Child = Row(Face(origin, 30), Spaced(lines, 10)) };
        return block;
    }

    // ---- attachments: thumbnails, tap opens large; size and sha256 checked against the body
    private Control Pictures(ViewDecision decision, ApprovalAttachment[] attachments)
    {
        var row = new WrapPanel();
        foreach (var attachment in attachments.Where(item => item.Id is not null))
        {
            var id = $"{decision.Id}/{attachment.Id}"; var image = new Image { Width = 120, Height = 84, Stretch = Stretch.UniformToFill };
            if (pictures.TryGetValue(id, out var bitmap) && bitmap is not null) image.Source = bitmap; else if (!pictures.ContainsKey(id)) { pictures[id] = null; _ = LoadPictureAsync(decision.Id!, attachment, id); }
            var frame = new Border { Width = 120, Height = 84, CornerRadius = new CornerRadius(10), ClipToBounds = true, Background = Brush(Muted, 0x18), Child = image };
            var button = Plain(frame, LinuxStrings.ApprovalsDetail_Pictures_1(attachment.Name)); button.Margin = new Thickness(0, 0, 8, 8);
            button.Click += (_, _) => { if (pictures.GetValueOrDefault(id) is { } large) ShowLarge(large, attachment.Name ?? ""); };
            row.Children.Add(button);
        }
        return row;
    }
    private async Task LoadPictureAsync(string decisionId, ApprovalAttachment attachment, string id)
    {
        try
        {
            var bytes = Device is { } device ? await device.AttachmentAsync(decisionId, attachment.Id!) ?? throw new InvalidOperationException("no image held") : throw new InvalidOperationException("no device");
            if (attachment.Size > 0 && bytes.LongLength != attachment.Size) return;
            if (attachment.Sha256 is { Length: 64 } sha && !string.Equals(Convert.ToHexString(SHA256.HashData(bytes)), sha, StringComparison.OrdinalIgnoreCase)) return;
            using var stream = new MemoryStream(bytes); pictures[id] = new Bitmap(stream); Render();
        }
        catch (Exception) { }
    }
    private void ShowLarge(Bitmap bitmap, string name)
    {
        var window = new Window { Title = name.Length > 0 ? name : LinuxStrings.ApprovalsDetail_ShowLarge_1, Width = Math.Min(1100, bitmap.Size.Width + 40), Height = Math.Min(800, bitmap.Size.Height + 60), Background = BellTheme.ConversationBackground, Content = new ScrollViewer { Content = new Image { Source = bitmap, Stretch = Stretch.None } } };
        window.KeyDown += (_, e) => { if (e.Key == Avalonia.Input.Key.Escape) window.Close(); };
        window.Show(this);
    }

    // ---- the answer, in place
    private Control Answering(ViewDecision decision)
    {
        var stack = new StackPanel { Margin = new Thickness(0, 6, 0, 0) };
        if (decision.Status == "held") stack.Children.Add(Text(LinuxStrings.ApprovalsDetail_Answering_1, 13.5, Muted, wrap: true));
        else switch (step)
        {
            case Step.Sending:
                stack.Children.Add(Heading(LinuxStrings.ApprovalsDetail_Answering_2)); stack.Children.Add(new Border { Child = Spinner(20), HorizontalAlignment = HorizontalAlignment.Left }); break;
            case Step.Choose or Step.Confirm:
                stack.Children.Add(Heading(LinuxStrings.ApprovalsDetail_Answering_3));
                stack.Children.Add(Text(step == Step.Confirm ? Approvals.ConfirmText(decision, text: writeText ?? "") : Approvals.ConfirmText(decision, chosenLabel ?? ""), 14, Ink, wrap: true));
                var go = Action(LinuxStrings.ApprovalsDetail_Answering_4, null, primary: true); go.Margin = new Thickness(0, 10, 8, 0); go.Click += (_, _) => _ = SendAsync(decision);
                var cancel = Action(LinuxStrings.ApprovalsDetail_Answering_5, null); cancel.Margin = new Thickness(0, 10, 0, 0); cancel.Click += (_, _) => { ResetStep(); Render(); };
                stack.Children.Add(Row(go, cancel));
                if (stepMessage is { Length: > 0 }) stack.Children.Add(Gap(Text(stepMessage, 13, Amber, wrap: true), 0, 8));
                break;
            case Step.Writing:
                stack.Children.Add(Heading(LinuxStrings.ApprovalsDetail_Answering_6));
                var box = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 96, Text = writeText, PlaceholderText = LinuxStrings.ApprovalsDetail_Answering_7 };
                var send = Action(LinuxStrings.ApprovalsDetail_Answering_8, null, primary: true); send.Margin = new Thickness(0, 10, 8, 0); send.IsEnabled = !string.IsNullOrWhiteSpace(writeText);
                box.TextChanged += (_, _) => { writeText = box.Text ?? ""; send.IsEnabled = !string.IsNullOrWhiteSpace(writeText); };
                send.Click += (_, _) => ConfirmWriting();
                var stop = Action(LinuxStrings.ApprovalsDetail_Answering_5, null); stop.Margin = new Thickness(0, 10, 0, 0); stop.Click += (_, _) => { ResetStep(); Render(); };
                AutomationProperties.SetName(box, LinuxStrings.ApprovalsDetail_Answering_10);
                stack.Children.Add(box); stack.Children.Add(Row(send, stop)); break;
            default:
                stack.Children.Add(Heading(LinuxStrings.ApprovalsDetail_Answering_3));
                foreach (var option in decision.Options ?? []) stack.Children.Add(OptionButton(decision, option));
                var write = Action(LinuxStrings.ApprovalsDetail_Answering_12, Pencil); write.Margin = new Thickness(0, 6, 0, 0); write.Click += (_, _) => StartWriting(); stack.Children.Add(write);
                break;
        }
        var actions = new WrapPanel { Margin = new Thickness(0, 14, 0, 0) };
        var hold = Action(decision.Status == "held" ? LinuxStrings.ApprovalsDetail_Answering_13 : LinuxStrings.ApprovalsDetail_Answering_14, Pause); hold.Click += (_, _) => _ = ToggleHoldAsync(decision); actions.Children.Add(hold);
        if (decision.Link?.Chart?.ProjectId is { Length: > 0 } project && decision.Link.Task?.CardId is { Length: > 0 } card) { var chart = Action(LinuxStrings.ApprovalsDetail_Answering_15, ForwardGlyph); chart.Click += (_, _) => openCard(project, card); actions.Children.Add(chart); }
        stack.Children.Add(actions);
        if (stepMessage is { Length: > 0 } && step is Step.None) stack.Children.Add(Gap(Text(stepMessage, 13, Amber, wrap: true), 0, 6));
        return stack;
    }

    private Control OptionButton(ViewDecision decision, ApprovalOption option)
    {
        var accent = option.Recommended;
        var label = Row(Text(option.Label ?? "", 14.5, accent ? Colors.White : Ink, FontWeight.SemiBold, wrap: true));
        if (accent) label.Children.Add(Spaced(Pill(Text(LinuxStrings.ApprovalsDetail_OptionButton_1, 11.5, Violet, FontWeight.Bold), Colors.White, 0xFF, new Thickness(8, 1, 8, 1)), 10));
        var frame = new Border { CornerRadius = new CornerRadius(14), Padding = new Thickness(16, 11), Margin = new Thickness(0, 0, 0, 8), Background = accent ? Brush(Violet) : Brush(Colors.White, 0xCC), BorderBrush = Brush(accent ? Violet : Line), BorderThickness = new Thickness(1), Child = label };
        var button = Plain(frame, $"{option.Label}{(accent ? LinuxStrings.ApprovalsDetail_OptionButton_2 : "")}"); button.HorizontalContentAlignment = HorizontalAlignment.Stretch; button.Click += (_, _) => ChooseOption(decision, option);
        return button;
    }

    private Control Answered(ViewDecision decision)
    {
        var stack = new StackPanel { Margin = new Thickness(0, 6, 0, 0) };
        if (decision.Status == "cancelled") { stack.Children.Add(Heading(LinuxStrings.ApprovalsDetail_Answered_1)); stack.Children.Add(Text(decision.CancelReason is { Length: > 0 } reason ? reason : LinuxStrings.ApprovalsDetail_Answered_2(Approvals.OriginOf(decision).Who), 14, Muted, wrap: true)); return stack; }
        stack.Children.Add(Heading(LinuxStrings.ApprovalsDetail_Answered_3)); stack.Children.Add(Text(Approvals.AnswerText(decision), 14.5, Ink, FontWeight.SemiBold, wrap: true));
        if (decision.Answer?.Attachments is { Length: > 0 } files) stack.Children.Add(Gap(Text(LinuxStrings.ApprovalsDetail_Answered_5(string.Join(LinuxStrings.ApprovalsDetail_Answered_4, files.Select(file => file.Name))), 12.5, Muted, wrap: true), 0, 6));
        var delivery = Approvals.DeliveryNote(decision); var fresh = noteFor == decision.Id && note is not null;
        var tone = Tone(delivery.Tone);
        var noteIcon = Icon(delivery.Tone == "amb" ? Pencil : Seal, 15, tone); noteIcon.VerticalAlignment = VerticalAlignment.Top; noteIcon.Margin = new Thickness(0, 2, 8, 0); DockPanel.SetDock(noteIcon, Dock.Left);
        stack.Children.Add(Gap(Pill(new DockPanel { Children = { noteIcon, Text(delivery.Text, 13, Ink, wrap: true) } }, tone, 0x1A, new Thickness(12, 9, 12, 9)), 0, 12));
        if (delivery.Copy) { var copy = Action(copied ? LinuxStrings.ApprovalsDetail_Answered_6 : LinuxStrings.ApprovalsDetail_Answered_7, Copy); copy.Margin = new Thickness(0, 8, 0, 0); copy.Click += (_, _) => _ = CopyResumeAsync(decision); stack.Children.Add(copy); }
        _ = fresh;
        return stack;
    }

    private Control History(ViewDecision decision)
    {
        var stack = new StackPanel(); var rows = Approvals.HistoryRows(decision, Now());
        if (rows.Count == 0) return stack;
        stack.Children.Add(Heading(LinuxStrings.ApprovalsDetail_History_1));
        foreach (var row in rows) stack.Children.Add(Gap(Row(Text(row.Time, 12, Muted), Spaced(Text(row.Text, 13, row.Amended ? Violet : Ink, wrap: true), 12)), 0, 4));
        return stack;
    }

    // ---- 工程とのつながり
    private Control ChainColumn(ViewDecision? decision)
    {
        var stack = new StackPanel { Spacing = 8 };
        stack.Children.Add(Row(Shape(LinkGeometry, 14, Violet), Spaced(Text(LinuxStrings.ApprovalsDetail_ChainColumn_1, 16, Ink, FontWeight.Bold), 8)));
        if (decision is not null)
        {
            var panel = Approvals.LinkPanel(decision);
            switch (panel.Kind)
            {
                case "linked":   // ids and state only (by-decision): the words come from the state, the button opens the task on its chart
                    stack.Children.Add(Text(LinkSentence(decision), 13, Ink, wrap: true));
                    if (panel.Ids is { } ids) { var go = Action(LinuxStrings.ApprovalsDetail_ChainColumn_2, ForwardGlyph); go.Click += (_, _) => openCard(ids.ProjectId, ids.CardId); stack.Children.Add(go); }
                    break;
                case "connecting":
                    stack.Children.Add(Dashed(new Border { Padding = new Thickness(14, 12), Child = Text(panel.Title, 13.5, Muted, wrap: true) }, 14));
                    break;
                default:
                    var lines = new StackPanel { Spacing = 6, Children = { Text(panel.Title, 14, Ink, FontWeight.SemiBold) } };
                    foreach (var line in panel.Lines) lines.Children.Add(Text(line, 12.5, Muted, wrap: true));
                    stack.Children.Add(Dashed(new Border { Padding = new Thickness(14, 12), Child = lines }, 14));
                    break;
            }
        }
        else stack.Children.Add(Text(LinuxStrings.ApprovalsDetail_ChainColumn_3, 13, Muted, wrap: true));
        return new Border { Child = Glass(new ScrollViewer { Content = stack }, 22, new Thickness(16, 16, 16, 12), 0xC7), [Grid.ColumnProperty] = 2 };
    }

    private static string LinkSentence(ViewDecision decision) => decision.Link?.State switch
    {
        "answered" or "closed" => LinuxStrings.ApprovalsDetail_LinkSentence_1,
        "diverged" => LinuxStrings.ApprovalsDetail_LinkSentence_2,
        _ => decision.Status == "answered" ? LinuxStrings.ApprovalsDetail_LinkSentence_1 : LinuxStrings.ApprovalsDetail_LinkSentence_4
    };
}
