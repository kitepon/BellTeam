using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;

namespace BellTeam.Linux;

// A machine seat's pending question or tool approval, drawn from the chat-log entry (conversation machine-stream.md). Same card as the Mac OwnerQuestionCard:
// one choice of a single question answers at once; several questions or multi-select pick first and send with 「送る」. Other is a free text.
public sealed class MachineRequestCard(LinuxWorkspace workspace, string author) : StackPanel
{
    private MachineEvent? current;
    private string currentAuthor = author;
    private bool sending;
    private readonly List<Control> inputs = [];
    private readonly List<HashSet<int>> picked = [];
    private readonly List<TextBox?> others = [];
    private readonly List<List<(int Index, Button Button)>> optionButtons = [];
    private readonly TextBlock error = SecretCard.CardText("", size: 14, error: true);
    private TextBlock? title;
    private Button? send;
    private MachineRequest Request => current!.Request!;
    private bool Immediate => current is { Request: { } r } && r.AskedOf().Length == 1 && !r.AskedOf()[0].MultiSelect;
    internal static bool IsCard(MachineEvent machine) => machine.Request is not null && machine.View is "question" or "approval";
    internal bool Sending => sending;

    public void Update(MachineEvent machine, string sender)
    {
        if (current?.Request is { } old && machine.Request is { } now && old.Key() == now.Key() && old.Fingerprint() == now.Fingerprint() && current.Tool == machine.Tool)
        {
            current = machine; currentAuthor = sender; title!.Text = Heading; return;
        }
        current = machine; currentAuthor = sender; Children.Clear(); inputs.Clear(); picked.Clear(); others.Clear(); optionButtons.Clear(); send = null;
        var request = Request;
        var header = (StackPanel)SecretCard.CardTitle(RequestIcons.List, Heading); title = (TextBlock)header.Children[1];
        Children.Add(header);
        if (machine.View == "approval") DrawApproval(machine, request); else DrawQuestions(request);
        error.IsVisible = (error.Text ?? "").Length != 0;
        Children.Add(error);
    }
    private string Heading => currentAuthor + (current!.View == "approval" ? LinuxStrings.MachineCards_Heading_1 : LinuxStrings.MachineCards_Heading_2);

    private void DrawApproval(MachineEvent machine, MachineRequest request)
    {
        Children.Add(SecretCard.CardBody(machine.Tool?.Name is { Length: > 0 } name ? name : machine.Title ?? LinuxStrings.MachineCards_DrawApproval_1));
        if (machine.Tool?.Summary is { Length: > 0 } summary) Children.Add(SecretCard.CardText(summary, size: 14, muted: true));
        if (!request.IsPending()) { Closed(request, request.Decision == "allow" ? LinuxStrings.MachineCards_DrawApproval_2 : request.Decision == "deny" ? LinuxStrings.MachineCards_DrawApproval_3 : null); return; }
        var allow = MacUi.Prominent(LinuxStrings.MachineCards_DrawApproval_4, () => _ = AnswerAsync(null, "allow")); var deny = MacUi.Bordered(LinuxStrings.MachineCards_DrawApproval_5, () => _ = AnswerAsync(null, "deny"));
        allow.Margin = new Thickness(0, 0, 8, 0); inputs.Add(allow); inputs.Add(deny);
        Children.Add(new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 12, 0, 0), Children = { allow, deny } });
    }

    private void DrawQuestions(MachineRequest request)
    {
        for (var i = 0; i < request.AskedOf().Length; i++)
        {
            var question = request.AskedOf()[i];
            if (question.Header is { Length: > 0 } head) Children.Add(SecretCard.CardText(head, size: 13, muted: true));
            Children.Add(SecretCard.CardBody(question.Question));
            if (request.IsPending()) DrawChoices(i, question); else if (request.AnswerLine(i) is { Length: > 0 } line) Children.Add(SecretCard.CardStatus(Icons.Check, LinuxStrings.MachineCards_DrawQuestions_1(line), strong: true));
        }
        if (!request.IsPending()) { Closed(request, null); return; }
        if (!Immediate)
        {
            send = MacUi.Prominent(LinuxStrings.MachineCards_DrawQuestions_2, () => _ = AnswerAsync(Collect(), null)); send.Margin = new Thickness(0, 12, 0, 0); send.IsEnabled = false; inputs.Add(send);
            Children.Add(send);
        }
    }

    private void DrawChoices(int i, MachineQuestion question)
    {
        picked.Add([]); optionButtons.Add([]);
        var choices = new WrapPanel { Margin = new Thickness(0, 12, 0, 0) };
        foreach (var option in question.Options)
        {
            var label = new StackPanel { Children = { new TextBlock { Text = option.Label, FontSize = 14, TextWrapping = TextWrapping.Wrap } } };
            if (option.Description is { Length: > 0 } description) label.Children.Add(new TextBlock { Text = description, FontSize = 12, Foreground = BellTheme.Muted, TextWrapping = TextWrapping.Wrap, MaxWidth = 360 });
            var button = new Button { Classes = { "plain" }, Content = label, Padding = new Thickness(14, 6), CornerRadius = new CornerRadius(6), Margin = new Thickness(0, 0, 8, 8), HorizontalContentAlignment = HorizontalAlignment.Left };
            AutomationProperties.SetName(button, option.Label);
            var index = option.Index;
            button.Click += (_, _) => Choose(i, question, index);
            optionButtons[i].Add((index, button)); choices.Children.Add(button); inputs.Add(button);
        }
        Children.Add(choices);
        if (question.AllowOther)
        {
            var other = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MaxHeight = 110, FontSize = 14, Padding = new Thickness(8, 6), PlaceholderText = LinuxStrings.MachineCards_DrawChoices_1, PlaceholderForeground = BellTheme.Muted, Background = Brushes.White, BorderBrush = BellTheme.Line, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8) };
            ScrollViewer.SetVerticalScrollBarVisibility(other, ScrollBarVisibility.Auto);
            other.OnText(() => { if (!question.MultiSelect && !string.IsNullOrWhiteSpace(other.Text)) { picked[i].Clear(); Paint(i); } Refresh(); });
            inputs.Add(other); others.Add(other);
            if (Immediate)
            {
                var sendOther = MacUi.Bordered(LinuxStrings.MachineCards_DrawQuestions_2, () => _ = AnswerAsync(Collect(), null)); sendOther.VerticalAlignment = VerticalAlignment.Bottom; sendOther.IsEnabled = false; sendOther.Margin = new Thickness(8, 0, 0, 0); send = sendOther; inputs.Add(sendOther);
                DockPanel.SetDock(sendOther, Dock.Right);
                Children.Add(new DockPanel { Margin = new Thickness(0, 4, 0, 0), Children = { sendOther, other } });
            }
            else { other.Margin = new Thickness(0, 4, 0, 0); Children.Add(other); }
        }
        else others.Add(null);
        Paint(i);
    }

    // Immediate mode answers at the press; otherwise a press only picks (single: replaces, multi: toggles).
    private void Choose(int i, MachineQuestion question, int index)
    {
        if (sending) return;
        if (Immediate) { picked[i].Clear(); picked[i].Add(index); _ = AnswerAsync(Collect(), null); return; }
        if (!picked[i].Remove(index)) { if (!question.MultiSelect) { picked[i].Clear(); if (others[i] is { } text) text.Text = ""; } picked[i].Add(index); }
        Paint(i); Refresh();
    }
    private void Paint(int i)
    {
        foreach (var (index, button) in optionButtons[i])
        {
            var on = picked[i].Contains(index);
            button.Background = on ? BellTheme.ProminentFill : BellTheme.ButtonFill; button.Foreground = on ? Brushes.White : BellTheme.Ink;
            if (button.Content is StackPanel panel) foreach (var line in panel.Children.OfType<TextBlock>().Skip(1)) line.Foreground = on ? Brushes.White : BellTheme.Muted;
        }
    }
    private bool Ready => picked.Select((set, i) => set.Count != 0 || !string.IsNullOrWhiteSpace(others[i]?.Text)).All(ok => ok);
    private void Refresh() { if (send is not null) send.IsEnabled = !sending && Ready; }
    private MachineAnswer[] Collect() => picked.Select((set, i) => new MachineAnswer { Indexes = set.OrderBy(n => n).ToArray(), Other = string.IsNullOrWhiteSpace(others[i]?.Text) ? null : others[i]!.Text }).ToArray();

    private void Closed(MachineRequest request, string? decision)
    {
        if (request.Status == "answered") Children.Add(SecretCard.CardStatus(Icons.Check, decision is null ? LinuxStrings.MachineCards_Closed_1 : decision, strong: true));
        else Children.Add(SecretCard.CardStatus(Icons.Close, LinuxStrings.MachineCards_Closed_2));
    }

    private async Task AnswerAsync(MachineAnswer[]? answers, string? decision)
    {
        if (sending) return;
        sending = true; foreach (var control in inputs) control.IsEnabled = false; error.Text = ""; error.IsVisible = false;
        try
        {
            var reply = await workspace.AnswerSeatRequestAsync(Request.Key(), answers, decision);
            var done = Request with { Status = reply.Status, Answers = answers ?? [], Decision = decision };
            Update(current! with { Request = done }, currentAuthor);
        }
        catch (BellApiException refused) when (refused.Code is "REQUEST_NOT_PENDING" or "SEAT_REQUEST_CLOSED")
        {
            Update(current! with { Request = Request with { Status = "expired" } }, currentAuthor);
        }
        catch (Exception exception) { error.Text = LinuxStrings.MachineCards_AnswerAsync_1(exception.Message); error.IsVisible = true; }
        finally { sending = false; if (Request.IsPending()) { foreach (var control in inputs) control.IsEnabled = true; Refresh(); } }
    }
}

// What the card needs of a request beyond the Core record (Core owns the shape; the row names it request_id, the answer route id).
internal static class MachineRequestExtensions
{
    public static string Key(this MachineRequest request) => request.RequestId ?? request.Id ?? "";
    public static bool IsPending(this MachineRequest request) => request.Status == "pending";
    // Arrays compare by reference, so the card compares this to know whether the request changed.
    public static string Fingerprint(this MachineRequest request) => string.Join("|", request.Status, request.Decision, string.Join(",", (request.Answers ?? []).Select(a => string.Join("+", a.Indexes) + ":" + a.Other)), string.Join(",", request.AskedOf().Select(q => q.Question)));
    // The labels the Owner chose for question i, then the free text (the card's 「回答」 line).
    public static string AnswerLine(this MachineRequest request, int i) => request.Answers is { } answers && i < answers.Length && i < request.AskedOf().Length
        ? string.Join(LinuxStrings.ApprovalsDetail_Answered_4, answers[i].Indexes.Select(n => request.AskedOf()[i].Options.FirstOrDefault(o => o.Index == n)?.Label).Append(answers[i].Other).Where(label => !string.IsNullOrEmpty(label))) : "";
    public static MachineQuestion[] AskedOf(this MachineRequest request) => request.Questions ?? [];
}

// A machine seat's folded entry or shown tool_use in the chat log (a471; conversation machine-stream.md "Fold view" and "Tool calls fold and the order rule"). Nothing is hidden and nothing leaves its place
// in time: neighbours of one fold_group are one closed line (Timeline.FoldLabel: "tools ×2", "background ×9", or the tool name for one call) that opens to its members in their own order, each a closed line
// that opens to its text. Same look and behaviour as the Windows MachineEntry.
public sealed class MachineEntry(LinuxWorkspace workspace) : Decorator
{
    // Open or closed is the app's own and is not stored; it survives a redraw of the same row.
    private readonly HashSet<string> open = [];
    private readonly Dictionary<string, string> raw = [];
    private TimelineMessage? last;

    internal static bool IsEntry(MachineEvent machine) => !MachineRequestCard.IsCard(machine) && (machine.IsFolded || machine.View == "tool_use");

    public void Update(TimelineMessage message)
    {
        last = message; var entry = message.MachineEvent!;
        Control line = entry.IsFolded ? Fold(message, [message, .. entry.Folded]) : ToolUse(message, entry);
        Child = new CappedRow { Child = line, HorizontalAlignment = HorizontalAlignment.Left };
    }

    private static Control ToolUse(TimelineMessage message, MachineEvent entry)
    {
        var text = entry.Tool?.Name is { Length: > 0 } name ? name + (string.IsNullOrWhiteSpace(entry.Tool.Summary) ? "" : ": " + entry.Tool.Summary) : message.Message ?? "";
        return new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Margin = new Thickness(5, 2), Children = { Icons.Draw(Icons.Branch, 13, BellTheme.Muted, thickness: 1.6), new TextBlock { Text = text, FontSize = 13, Foreground = BellTheme.Muted, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center } } };
    }

    // One closed line; a click opens it and closes it again. The body is built only while open.
    private StackPanel Line(string key, string label, Func<Control> body)
    {
        var isOpen = open.Contains(key);
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Children = { Icons.Draw(isOpen ? Icons.ChevronDown : Icons.ChevronRight, 10, BellTheme.Muted, thickness: 2.4), new TextBlock { Text = label, FontSize = 13, Foreground = BellTheme.Muted, TextTrimming = TextTrimming.CharacterEllipsis, MaxWidth = 700, VerticalAlignment = VerticalAlignment.Center } } };
        var button = new Button { Classes = { "plain" }, Content = line, Background = Brushes.Transparent, Padding = new Thickness(5, 2), HorizontalAlignment = HorizontalAlignment.Left };
        AutomationProperties.SetName(button, label);
        button.Click += (_, _) => { if (!open.Remove(key)) open.Add(key); Update(last!); };
        var panel = new StackPanel { Children = { button } };
        if (isOpen) panel.Children.Add(body());
        return panel;
    }

    // A run of one fold_group is one line; one entry opens to its text, several to a closed line per member.
    private StackPanel Fold(TimelineMessage head, TimelineMessage[] members) => Line(head.Id, Timeline.FoldLabel(members), () =>
    {
        var body = new StackPanel { Margin = new Thickness(26, 0, 8, 6) };
        if (members.Length == 1) body.Children.Add(Opened(members[0]));
        else foreach (var member in members) body.Children.Add(Line("member:" + member.Id, member.Message ?? "", () => Opened(member)));
        return body;
    });

    // The full text of one entry (a tool_use's is its summary); when it was cut, a button reads the whole stored line.
    private Control Opened(TimelineMessage member)
    {
        var entry = member.MachineEvent!; var id = member.Id;
        var text = entry.View == "tool_use" && entry.Tool?.Summary is { Length: > 0 } summary ? summary : entry.Text;
        var panel = new StackPanel { Margin = new Thickness(0, 2, 0, 4) };
        var box = new TextBox { Text = raw.GetValueOrDefault(id) ?? text, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontSize = 13, FontFamily = BellTheme.Mono, Foreground = BellTheme.Ink, BorderThickness = default, Background = new SolidColorBrush(Color.FromArgb(20, 97, 71, 212)), Padding = new Thickness(8, 6), MaxHeight = 320 };
        ScrollViewer.SetVerticalScrollBarVisibility(box, ScrollBarVisibility.Auto);
        panel.Children.Add(box);
        if (entry.Truncated && !raw.ContainsKey(id) && member.Sender?.Id is { } botId)
        {
            var more = MacUi.Bordered(LinuxStrings.MachineCards_Opened_1, () => { });
            var failure = SecretCard.CardText("", size: 12, error: true); failure.IsVisible = false;
            more.Click += async (_, _) =>
            {
                more.IsEnabled = false; failure.IsVisible = false;
                try { raw[id] = box.Text = await workspace.MachineLineAsync(botId, entry.Seq); more.IsVisible = false; }
                catch (Exception error) { failure.Text = LinuxStrings.MachineCards_Opened_2(error.Message); failure.IsVisible = true; more.IsEnabled = true; }
            };
            more.HorizontalAlignment = HorizontalAlignment.Left; more.Margin = new Thickness(0, 4, 0, 0);
            panel.Children.Add(more); panel.Children.Add(failure);
        }
        return panel;
    }
}
