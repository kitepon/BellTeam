using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

// A machine seat's stream entry in the chat log (a471-askuser; conversation machine-stream.md). Drawn by `view`, never from the raw line.
// question / approval = a card the Owner answers while the request is pending; everything else is one quiet line or a small note.
public sealed class MachineEntry(Workspace workspace) : ContentControl
{
    private static readonly Brush Muted = SecretCard.Frozen(Color.FromRgb(120, 125, 145)), Red = SecretCard.Frozen(Color.FromRgb(255, 59, 48));
    private static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");
    private MachineRequestCard? card;
    private string? shape;
    public void Update(TimelineMessage message, string sender)
    {
        var entry = message.MachineEvent!;
        var kind = entry.Request is not null && entry.View is "question" or "approval" ? entry.View : entry.Display == "fold" ? "fold" : "note";
        if (shape != kind)
        {
            shape = kind; card = null;
            if (kind is "question" or "approval")
            {
                card = new MachineRequestCard(workspace);
                Content = new CappedRow { Child = new Border { Background = new SolidColorBrush(Color.FromArgb(230, 255, 255, 255)), CornerRadius = new CornerRadius(20), BorderBrush = new SolidColorBrush(Color.FromArgb(51, 97, 71, 212)), BorderThickness = new Thickness(1), Padding = new Thickness(20), Child = card }, HorizontalAlignment = HorizontalAlignment.Left };
            }
        }
        if (card is not null) { card.Update(entry, sender); return; }
        var text = message.Message ?? "";
        var line = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, FontSize = kind == "fold" ? 13 : 15, Foreground = IsError(entry) ? Red : Muted, FontStyle = entry.View == "thinking" ? FontStyles.Italic : FontStyles.Normal, VerticalAlignment = VerticalAlignment.Center };
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(8, 2, 8, 2) };
        if (kind == "fold") row.Children.Add(new TextBlock { Text = "\uE713", FontFamily = Icons, FontSize = 12, Foreground = Muted, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 6, 0) });
        row.Children.Add(line);
        Content = new CappedRow { Child = row, HorizontalAlignment = HorizontalAlignment.Left };
    }
    // result and tool_result reach the log only when they are errors; api_retry is shown for the same reason.
    private static bool IsError(MachineEvent entry) => entry.View is "result" or "tool_result" || entry.Title == "api_retry";
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
