using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

// A machine seat's stream entry in the chat log (a471; conversation machine-stream.md). Drawn by `view` and `display`, never from the raw line.
// question / approval = a card the Owner answers while the request is pending; a folded entry = one collapsed line that opens to its text; everything else = a small note.
public sealed class MachineEntry(Workspace workspace) : ContentControl
{
    private static readonly Brush Muted = SecretCard.Frozen(Color.FromRgb(120, 125, 145)), Red = SecretCard.Frozen(Color.FromRgb(255, 59, 48)), Ink = SecretCard.Frozen(Color.FromRgb(33, 41, 61));
    private static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");
    private MachineRequestCard? card;
    private string? shape;
    // Open or closed is the app's own and is not stored; it survives a redraw of the same row.
    private readonly HashSet<string> open = [];
    private readonly Dictionary<string, string> raw = [];
    public void Update(TimelineMessage message, string sender)
    {
        var entry = message.MachineEvent!;
        var kind = entry is { Request: not null, View: "question" or "approval" } ? entry.View : "line";
        if (shape != kind)
        {
            shape = kind; card = null;
            if (kind != "line")
            {
                card = new MachineRequestCard(workspace);
                Content = new CappedRow { Child = new Border { Background = new SolidColorBrush(Color.FromArgb(230, 255, 255, 255)), CornerRadius = new CornerRadius(20), BorderBrush = new SolidColorBrush(Color.FromArgb(51, 97, 71, 212)), BorderThickness = new Thickness(1), Padding = new Thickness(20), Child = card }, HorizontalAlignment = HorizontalAlignment.Left };
            }
        }
        if (card is not null) { card.Update(entry, sender); return; }
        var stack = new StackPanel();
        if (entry.IsFolded) stack.Children.Add(Fold(message, [message, .. entry.Folded]));
        else stack.Children.Add(Note(message, entry));
        Content = new CappedRow { Child = stack, HorizontalAlignment = HorizontalAlignment.Left };
    }

    private static string FirstLine(string text) => text.Split('\n')[0];
    private static TextBlock Glyph(string glyph, double size) => new() { Text = glyph, FontFamily = Icons, FontSize = size, Foreground = Muted, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 6, 0) };

    // A shown entry: its words in full (thinking lighter and slanted); a tool_use is its one line. An error is red.
    private static FrameworkElement Note(TimelineMessage message, MachineEvent entry)
    {
        // Only failures stay shown (the rest of these views fold), so a shown result is red.
        var error = entry.View is "result" or "tool_result" || entry.View == "system" && entry.Title?.Contains("error", StringComparison.OrdinalIgnoreCase) == true;
        var text = entry.View == "tool_use" && entry.Tool?.Name is { Length: > 0 } name ? name + (string.IsNullOrWhiteSpace(entry.Tool.Summary) ? "" : ": " + entry.Tool.Summary) : string.IsNullOrEmpty(entry.Text) || entry.View == "tool_use" ? message.Message ?? "" : entry.Text;
        var panel = new StackPanel { Margin = new Thickness(8, 2, 8, 2) };
        if (!string.IsNullOrWhiteSpace(entry.Title) && entry.View is not ("words" or "thinking" or "tool_use") && !string.IsNullOrEmpty(entry.Text))
            panel.Children.Add(new TextBlock { Text = entry.Title, FontSize = 12, FontWeight = FontWeights.SemiBold, Foreground = error ? Red : Muted });
        var body = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, FontSize = entry.View == "tool_use" ? 13 : 15, Foreground = error ? Red : entry.View is "thinking" or "tool_use" ? Muted : Ink, FontStyle = entry.View == "thinking" ? FontStyles.Italic : FontStyles.Normal };
        if (entry.View == "tool_use") { var row = new StackPanel { Orientation = Orientation.Horizontal }; row.Children.Add(Glyph("\uE713", 12)); row.Children.Add(body); panel.Children.Add(row); }
        else panel.Children.Add(body);
        return panel;
    }

    // One collapsed line (a run of one fold_group is one line "group ×n"); a tap or click opens it to the full text and closes it again.
    private FrameworkElement Fold(TimelineMessage head, TimelineMessage[] members)
    {
        var key = head.Id; var isOpen = open.Contains(key);
        var entry = head.MachineEvent!;
        var label = Timeline.FoldLabel(members);
        var line = new StackPanel { Orientation = Orientation.Horizontal };
        var chevron = Glyph(isOpen ? "\uE70D" : "\uE76C", 10);
        line.Children.Add(chevron); line.Children.Add(new TextBlock { Text = label, FontSize = 13, Foreground = Muted, TextTrimming = TextTrimming.CharacterEllipsis, MaxWidth = 700, VerticalAlignment = VerticalAlignment.Center });
        var button = new Button { Content = line, HorizontalContentAlignment = HorizontalAlignment.Left, Padding = new Thickness(8, 2, 8, 2), Margin = new Thickness(0), Cursor = System.Windows.Input.Cursors.Hand, HorizontalAlignment = HorizontalAlignment.Left };
        button.SetResourceReference(StyleProperty, "QuietButton"); button.Padding = new Thickness(8, 2, 8, 2); button.Margin = new Thickness(0);
        System.Windows.Automation.AutomationProperties.SetName(button, label);
        var body = new StackPanel { Margin = new Thickness(26, 0, 8, 6), Visibility = isOpen ? Visibility.Visible : Visibility.Collapsed };
        foreach (var member in members) body.Children.Add(members.Length > 1 ? Fold(member, [member]) : Opened(member, false)); // a run opens to its members, each a closed line
        button.Click += (_, _) =>
        {
            var now = body.Visibility != Visibility.Visible;
            body.Visibility = now ? Visibility.Visible : Visibility.Collapsed; ((TextBlock)line.Children[0]).Text = now ? "\uE70D" : "\uE76C";
            if (now) open.Add(key); else open.Remove(key);
        };
        return new StackPanel { Children = { button, body } };
    }

    // The full text of one folded entry; when it was cut, a button reads the whole stored line.
    private FrameworkElement Opened(TimelineMessage member, bool titled)
    {
        var entry = member.MachineEvent!; var id = member.Id;
        var text = raw.GetValueOrDefault(id) ?? (entry.Text.Length == 0 && entry.View == "tool_use" ? entry.Tool?.Summary ?? "" : entry.Text);
        var panel = new StackPanel { Margin = new Thickness(0, 2, 0, 4) };
        if (titled && !string.IsNullOrWhiteSpace(entry.Title)) panel.Children.Add(new TextBlock { Text = entry.Title, FontSize = 12, FontWeight = FontWeights.SemiBold, Foreground = Muted });
        var box = new TextBox { Text = text, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontSize = 13, Foreground = Ink, BorderThickness = new Thickness(0), Background = new SolidColorBrush(Color.FromArgb(20, 97, 71, 212)), Padding = new Thickness(8, 6, 8, 6), MaxHeight = 320, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        panel.Children.Add(box);
        var botId = member.Sender?.Id;
        if (entry.Truncated && !raw.ContainsKey(id) && botId is not null)
        {
            var more = new Button { Content = "全文を読み込む", Padding = new Thickness(10, 3, 10, 3), HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 4, 0, 0) };
            var failure = new TextBlock { FontSize = 12, Foreground = Red, TextWrapping = TextWrapping.Wrap, Visibility = Visibility.Collapsed };
            more.Click += async (_, _) =>
            {
                more.IsEnabled = false; failure.Visibility = Visibility.Collapsed;
                try { raw[id] = box.Text = await workspace.MachineLineAsync(botId, entry.Seq); more.Visibility = Visibility.Collapsed; }
                catch (Exception error) { failure.Text = "全文を読み込めませんでした。" + error.Message; failure.Visibility = Visibility.Visible; more.IsEnabled = true; }
            };
            panel.Children.Add(more); panel.Children.Add(failure);
        }
        return panel;
    }
}

public sealed class MachineRequestCard(Workspace workspace) : StackPanel
{
    private static readonly Brush Violet = SecretCard.Frozen(Color.FromRgb(97, 71, 212)), Ink = SecretCard.Frozen(Color.FromRgb(33, 41, 61)), Muted = SecretCard.Frozen(Color.FromRgb(120, 125, 145)), Red = SecretCard.Frozen(Color.FromRgb(255, 59, 48));
    private MachineEvent? current;
    private string signature = "";
    private string sender = "";
    private bool sending;
    private TextBlock? title;
    private List<HashSet<int>> picked = [];
    private List<TextBox> others = [];
    private readonly List<Control> inputs = [];
    private Button? send;
    private readonly TextBlock error = new() { TextWrapping = TextWrapping.Wrap, FontSize = 14, Foreground = Red, Margin = new Thickness(0, 12, 0, 0), Visibility = Visibility.Collapsed };

    public void Update(MachineEvent entry, string senderName)
    {
        sender = senderName;
        // A refresh of the same request keeps what the Owner has picked; only a changed request is drawn again.
        var next = JsonSerializer.Serialize(entry.Request) + entry.Text + entry.Tool?.Name + entry.Tool?.Summary;
        if (title is not null && next == signature) { title.Text = Heading(entry); current = entry; return; }
        signature = next; current = entry;
        Children.Clear(); inputs.Clear(); picked = []; others = []; send = null;
        var request = entry.Request!;
        var header = (StackPanel)SecretCard.CardTitle(entry.View == "question" ? "\uE8FD" : "\uE72E", Heading(entry)); title = (TextBlock)header.Children[1];
        Children.Add(header);
        if (entry.View == "question") DrawQuestions(request); else DrawApproval(entry, request);
        Children.Add(error);
    }
    private string Heading(MachineEvent entry) => sender + (entry.View == "question" ? " · 選んでほしいこと" : " · 許可の確認");

    private void DrawApproval(MachineEvent entry, MachineRequest request)
    {
        var what = (entry.Tool?.Name ?? entry.Title ?? "道具") + (string.IsNullOrWhiteSpace(entry.Tool?.Summary) ? "" : "\n" + entry.Tool!.Summary);
        Children.Add(SecretCard.CardBody(what));
        if (request.Status == "answered") { Children.Add(SecretCard.CardStatus("\uE73E", request.Decision == "deny" ? "却下しました" : "許可しました", strong: true)); return; }
        if (request.Status != "pending") { Children.Add(SecretCard.CardText("席はこの許可を待たなくなりました。", muted: true)); return; }
        var allow = new Button { Content = "許可", FontWeight = FontWeights.SemiBold, Padding = new Thickness(16, 6, 16, 6), Margin = new Thickness(0, 0, 8, 0) }; allow.SetResourceReference(StyleProperty, "PrimaryButton");
        var deny = new Button { Content = "却下", FontWeight = FontWeights.SemiBold, Padding = new Thickness(16, 6, 16, 6) };
        allow.Click += async (_, _) => await SendAsync(request, null, "allow"); deny.Click += async (_, _) => await SendAsync(request, null, "deny");
        inputs.Add(allow); inputs.Add(deny);
        Children.Add(new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 12, 0, 0), Children = { allow, deny } });
    }

    private void DrawQuestions(MachineRequest request)
    {
        var questions = request.Questions ?? [];
        for (var q = 0; q < questions.Length; q++)
        {
            var question = questions[q];
            if (q > 0) Children.Add(new Border { Height = 20 });
            if (!string.IsNullOrWhiteSpace(question.Header)) Children.Add(SecretCard.CardText(question.Header!, bold: true, size: 13, muted: true));
            Children.Add(SecretCard.CardBody(question.Question));
            if (request.Status == "answered") { Children.Add(SecretCard.CardStatus("\uE73E", "回答: " + AnswerText(question, request.Answers?.ElementAtOrDefault(q)), strong: true)); continue; }
            if (request.Status != "pending") { Children.Add(SecretCard.CardText("席はこの問いを待たなくなりました。", muted: true)); continue; }
            DrawChoices(request, q, question);
        }
        if (request.Status != "pending") return;
        // One single-choice question: pressing a choice answers at once. Otherwise the Owner picks, then 送る.
        send = new Button { Content = "送る", FontWeight = FontWeights.SemiBold, Padding = new Thickness(16, 6, 16, 6), HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 12, 0, 0), IsEnabled = false }; send.SetResourceReference(StyleProperty, "PrimaryButton");
        send.Click += async (_, _) => await SendAsync(request, Collect(request), null);
        inputs.Add(send); Children.Add(send);
    }
    private static string AnswerText(MachineQuestion question, MachineAnswer? answer) =>
        string.Join("、", (answer?.Indexes ?? []).Select(i => question.Options.FirstOrDefault(o => o.Index == i)?.Label ?? i.ToString()).Concat(answer?.Other is { Length: > 0 } other ? [other] : []));

    private void DrawChoices(MachineRequest request, int q, MachineQuestion question)
    {
        var immediate = request.Questions!.Length == 1 && !question.MultiSelect;
        picked.Add([]);
        var buttons = new List<ToggleButton>();
        var list = new StackPanel { Margin = new Thickness(0, 12, 0, 0) };
        TextBox? other = null;
        foreach (var option in question.Options)
        {
            var button = new ToggleButton { Content = Choice(option, question.MultiSelect), Template = ChoiceTemplate(), HorizontalContentAlignment = HorizontalAlignment.Stretch, Margin = new Thickness(0, 0, 0, 8), Cursor = System.Windows.Input.Cursors.Hand };
            System.Windows.Automation.AutomationProperties.SetName(button, option.Label);
            button.Click += async (_, _) =>
            {
                var set = picked[q];
                if (button.IsChecked == true) { if (!question.MultiSelect) { set.Clear(); foreach (var b in buttons) if (b != button) b.IsChecked = false; if (other is not null) other.Text = ""; } set.Add(option.Index); }
                else set.Remove(option.Index);
                Changed(request);
                if (immediate && button.IsChecked == true) await SendAsync(request, Collect(request), null);
            };
            buttons.Add(button); list.Children.Add(button); inputs.Add(button);
        }
        Children.Add(list);
        if (!question.AllowOther) { others.Add(null!); return; }
        other = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MaxHeight = 110, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, FontSize = 14, Padding = new Thickness(8, 6, 8, 6) };
        var placeholder = new TextBlock { Text = "その他（文章で答える）", FontSize = 14, Foreground = Muted, Margin = new Thickness(9, 7, 0, 0), IsHitTestVisible = false, VerticalAlignment = VerticalAlignment.Top };
        other.TextChanged += (_, _) =>
        {
            placeholder.Visibility = other.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
            if (!question.MultiSelect && !string.IsNullOrWhiteSpace(other.Text)) { picked[q].Clear(); foreach (var b in buttons) b.IsChecked = false; }
            Changed(request);
        };
        var field = new Grid { Margin = new Thickness(0, 4, 0, 0) }; field.Children.Add(other); field.Children.Add(placeholder);
        others.Add(other); inputs.Add(other); Children.Add(field);
    }
    private static FrameworkElement Choice(MachineOption option, bool multi)
    {
        var row = new Grid(); row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); row.ColumnDefinitions.Add(new ColumnDefinition());
        var number = new Grid { Width = 20, Height = 20, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 1, 10, 0) };
        number.Children.Add(multi ? new System.Windows.Shapes.Rectangle { Fill = Violet, RadiusX = 5, RadiusY = 5 } : new System.Windows.Shapes.Ellipse { Fill = Violet });
        number.Children.Add(new TextBlock { Text = option.Index.ToString(System.Globalization.CultureInfo.InvariantCulture), FontSize = 11, FontWeight = FontWeights.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center });
        row.Children.Add(number);
        var text = new StackPanel { Children = { new TextBlock { Text = option.Label, FontSize = 15, FontWeight = FontWeights.Medium, TextWrapping = TextWrapping.Wrap, Foreground = Ink } } };
        if (!string.IsNullOrWhiteSpace(option.Description)) text.Children.Add(new TextBlock { Text = option.Description, FontSize = 13, TextWrapping = TextWrapping.Wrap, Foreground = Muted, Margin = new Thickness(0, 2, 0, 0) });
        Grid.SetColumn(text, 1); row.Children.Add(text);
        return row;
    }
    // A template belongs to the thread that parsed it, so each card parses its own. A picked choice is filled darker with a violet edge.
    private static ControlTemplate ChoiceTemplate() => (ControlTemplate)System.Windows.Markup.XamlReader.Parse(
        "<ControlTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" TargetType=\"ToggleButton\"><Border x:Name=\"Chrome\" Background=\"#126147D4\" BorderBrush=\"#386147D4\" BorderThickness=\"1\" CornerRadius=\"12\" Padding=\"14,11\"><ContentPresenter/></Border>"
        + "<ControlTemplate.Triggers><Trigger Property=\"IsMouseOver\" Value=\"True\"><Setter TargetName=\"Chrome\" Property=\"Background\" Value=\"#206147D4\"/></Trigger><Trigger Property=\"IsChecked\" Value=\"True\"><Setter TargetName=\"Chrome\" Property=\"Background\" Value=\"#306147D4\"/><Setter TargetName=\"Chrome\" Property=\"BorderBrush\" Value=\"#FF6147D4\"/></Trigger><Trigger Property=\"IsEnabled\" Value=\"False\"><Setter TargetName=\"Chrome\" Property=\"Opacity\" Value=\"0.5\"/></Trigger></ControlTemplate.Triggers></ControlTemplate>");

    private MachineAnswer[] Collect(MachineRequest request) =>
        request.Questions!.Select((_, q) => new MachineAnswer { Indexes = picked[q].Order().ToArray(), Other = others[q] is { } box && !string.IsNullOrWhiteSpace(box.Text) ? box.Text : null }).ToArray();
    private void Changed(MachineRequest request)
    {
        if (send is null) return;
        send.IsEnabled = !sending && Collect(request).All(a => a.Indexes.Length + (a.Other is null ? 0 : 1) > 0);
    }

    // An answer is not idempotent, so it is sent once per press; a failure leaves the card pending for the Owner to try again.
    private async Task SendAsync(MachineRequest request, MachineAnswer[]? answers, string? decision)
    {
        if (sending || request.RequestId is not { } id) return;
        sending = true; foreach (var control in inputs) control.IsEnabled = false; error.Visibility = Visibility.Collapsed;
        try
        {
            var result = await workspace.AnswerSeatRequestAsync(id, answers, decision);
            if (current is { } entry) Update(entry with { Request = request with { Status = result.Status, Answers = result.Answers ?? answers, Decision = result.Decision ?? decision } }, sender);
        }
        catch (BellApiException failure) when (failure.Code is "REQUEST_NOT_PENDING" or "SEAT_REQUEST_CLOSED")
        {
            if (current is { } entry) Update(entry with { Request = request with { Status = "expired" } }, sender);
        }
        catch (Exception failure)
        {
            error.Text = "操作の結果を確認できませんでした。現在の状態を更新して確認してください。\n" + failure.Message; error.Visibility = Visibility.Visible;
            foreach (var control in inputs) control.IsEnabled = true;
        }
        finally { sending = false; if (current?.Request is { Status: "pending" } pending) Changed(pending); }
    }
}