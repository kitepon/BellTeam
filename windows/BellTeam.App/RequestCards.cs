using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

// Mac SecretRequestCard / OwnerQuestionCard: a white card with a violet title line; the parts are spaced 12 apart.
public sealed class SecretCard(Workspace workspace, string author) : StackPanel
{
    private SecretRequest? current;
    private string currentAuthor = author;
    public void Update(SecretRequest request) => Update(request, currentAuthor);
    public void Update(SecretRequest request, string sender)
    {
        if (current == request && currentAuthor == sender) return;
        current = request; currentAuthor = sender; Children.Clear();
        Children.Add(CardTitle("\uE72E", currentAuthor + " · 秘密情報の入力"));
        Children.Add(CardBody(request.Message));
        Children.Add(CardText(request.Label + " / " + request.ToolId, size: 14, muted: true));
        if (request.Status == "pending")
        {
            var open = new Button { Content = "安全な入力欄を開く", HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 12, 0, 0) };
            open.SetResourceReference(StyleProperty, "MacBorderedButton");
            open.Click += (_, _) => new SecretInputWindow(request, value => workspace.FinishSecretAsync(request.Id, value), Update) { Owner = Window.GetWindow(this) }.ShowDialog();
            Children.Add(open);
        }
        else if (request.Status == "submitted") Children.Add(CardStatus("\uE73E", "登録済み"));
        else if (request.Status == "cancelled") Children.Add(CardStatus("\uE711", "入力を取り消しました"));
        else Children.Add(CardText("不明な入力状態: " + request.Status, error: true));
        if (request.Notification == "failed") Children.Add(CardText("AIへの通知に失敗しました。チャットで完了を知らせてください。", size: 14, error: true));
    }
    private static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");
    internal static FrameworkElement CardTitle(string glyph, string text) => new StackPanel
    {
        Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 12),
        Children = { new TextBlock { Text = glyph, FontFamily = Icons, FontSize = 14, Foreground = Violet, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 8, 0) }, new TextBlock { Text = text, FontSize = 15, FontWeight = FontWeights.SemiBold, Foreground = Violet, VerticalAlignment = VerticalAlignment.Center } }
    };
    internal static FrameworkElement CardStatus(string glyph, string text, bool strong = false) => new StackPanel
    {
        Orientation = Orientation.Horizontal, Margin = new Thickness(0, 12, 0, 0),
        Children = { new TextBlock { Text = glyph, FontFamily = Icons, FontSize = 14, Foreground = strong ? Violet : Ink, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 8, 0) }, new TextBlock { Text = text, FontSize = 15, FontWeight = strong ? FontWeights.SemiBold : FontWeights.Normal, Foreground = strong ? Violet : Ink, VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap } }
    };
    private static readonly Brush Violet = Frozen(Color.FromRgb(97, 71, 212)), Ink = Frozen(Color.FromRgb(33, 41, 61)), MutedInk = Frozen(Color.FromRgb(120, 125, 145)), Red = Frozen(Color.FromRgb(255, 59, 48));
    private static Brush Frozen(Color color) { var brush = new SolidColorBrush(color); brush.Freeze(); return brush; }
    internal static TextBlock CardText(string text, bool bold = false, bool error = false, double size = 16, bool muted = false) => new() { Text = text, TextWrapping = TextWrapping.Wrap, FontSize = size, FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal, Foreground = error ? Red : muted ? MutedInk : Ink, Margin = new Thickness(0, 12, 0, 0) };
    internal static TextBox CardBody(string text) => new() { Text = text, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontSize = 18, BorderThickness = new Thickness(0), Background = Brushes.Transparent, Padding = new Thickness(0), Margin = new Thickness(0) };
}

public sealed class SecretInputWindow : Window
{
    internal PasswordBox Input { get; } = new() { Margin = new Thickness(0, 8, 0, 8), Padding = new Thickness(10) };
    internal TextBlock ErrorText { get; } = SecretCard.CardText("", error: true);
    private readonly Func<string?, Task<SecretRequest>> finish;
    private readonly Action<SecretRequest> completed;
    private readonly Button submit = new() { Content = "登録して続ける" };
    private readonly Button decline = new() { Content = "入力を断る" };
    private readonly Button close = new() { Content = "閉じる" };
    private bool sending;
    public SecretInputWindow(SecretRequest request, Func<string?, Task<SecretRequest>> finish, Action<SecretRequest> completed)
    {
        this.finish = finish; this.completed = completed;
        Title = request.Label; Width = 560; SizeToContent = SizeToContent.Height; MaxHeight = SystemParameters.WorkArea.Height; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var panel = new StackPanel { Margin = new Thickness(24) };
        panel.Children.Add(SecretCard.CardBody(request.Message));
        panel.Children.Add(SecretCard.CardText("値は会話に送信されません。BellTeamの利用者領域へ保存します。", size: 14, muted: true));
        panel.Children.Add(SecretCard.CardText(request.Label, bold: true));
        panel.Children.Add(Input); panel.Children.Add(ErrorText);
        var buttons = new WrapPanel(); buttons.Children.Add(submit); buttons.Children.Add(decline); buttons.Children.Add(close); panel.Children.Add(buttons);
        Content = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Input.PasswordChanged += (_, _) => submit.IsEnabled = !sending && Input.Password.Length != 0;
        submit.IsEnabled = false;
        submit.Click += async (_, _) => await SubmitAsync(true);
        decline.Click += async (_, _) => await SubmitAsync(false);
        close.Click += (_, _) => Close();
        Deactivated += (_, _) => Input.Clear();
        Closed += (_, _) => Input.Clear();
        Closing += (_, args) => { if (sending) args.Cancel = true; };
    }
    internal async Task SubmitAsync(bool register)
    {
        if (sending || register && Input.Password.Length == 0) return;
        sending = true; submit.IsEnabled = decline.IsEnabled = close.IsEnabled = Input.IsEnabled = false;
        var value = register ? Input.Password : null;
        Input.Clear(); ErrorText.Text = "";
        SecretRequest result;
        try { result = await finish(value); }
        catch (Exception)
        {
            // 入力値を含み得る例外の本文・スタックを画面やログへ渡さない。
            ErrorText.Text = "登録結果を確認できませんでした。閉じて最新の状態を確認してください。";
            return;
        }
        finally { sending = false; decline.IsEnabled = close.IsEnabled = Input.IsEnabled = true; submit.IsEnabled = Input.Password.Length != 0; }
        completed(result); Close();
    }
}

public sealed class QuestionCard(Workspace workspace, string author) : StackPanel
{
    private OwnerQuestion? current;
    private string currentAuthor = author;
    private bool sending;
    private readonly List<Control> inputs = [];
    private readonly TextBlock error = SecretCard.CardText("", size: 14, error: true);
    private TextBlock? title;
    public void Update(OwnerQuestion question) => Update(question, currentAuthor);
    public void Update(OwnerQuestion question, string sender)
    {
        if (current is { } old && old.Id == question.Id && old.Status == question.Status && old.Question == question.Question && old.AllowOther == question.AllowOther && old.Answer == question.Answer && old.Options.SequenceEqual(question.Options))
        {
            current = question; currentAuthor = sender;
            title!.Text = currentAuthor + " · 選んでほしいこと";
            return;
        }
        current = question; currentAuthor = sender; Children.Clear(); inputs.Clear();
        var header = (StackPanel)SecretCard.CardTitle("\uE8FD", currentAuthor + " · 選んでほしいこと"); title = (TextBlock)header.Children[1];
        Children.Add(header);
        Children.Add(SecretCard.CardBody(question.Question));
        if (question.Status == "answered") { Children.Add(SecretCard.CardStatus("\uE73E", "回答: " + question.Answer, strong: true)); return; }
        if (question.Status != "open") { Children.Add(SecretCard.CardText("不明な回答状態: " + question.Status, error: true)); return; }
        var choices = new WrapPanel { Margin = new Thickness(0, 12, 0, 0) };
        foreach (var option in question.Options)
        {
            var button = new Button { Content = option, IsEnabled = !sending, Margin = new Thickness(0, 0, 8, 8) }; button.SetResourceReference(StyleProperty, "MacBorderedButton");
            button.Click += async (_, _) => await AnswerAsync(question.Id, option, null);
            choices.Children.Add(button); inputs.Add(button);
        }
        Children.Add(choices);
        if (question.AllowOther)
        {
            var other = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MaxHeight = 110, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, IsEnabled = !sending, FontSize = 14, Padding = new Thickness(8, 6, 8, 6) };
            var placeholder = new TextBlock { Text = "その他（文章で答える）", FontSize = 14, Foreground = new SolidColorBrush(Color.FromRgb(120, 125, 145)), Margin = new Thickness(9, 7, 0, 0), IsHitTestVisible = false, VerticalAlignment = VerticalAlignment.Top };
            var send = new Button { Content = "送る", VerticalAlignment = VerticalAlignment.Bottom, IsEnabled = false, Margin = new Thickness(8, 0, 0, 0) };
            other.TextChanged += (_, _) => { placeholder.Visibility = other.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed; send.IsEnabled = !sending && !string.IsNullOrWhiteSpace(other.Text); };
            send.Click += async (_, _) => { if (!string.IsNullOrWhiteSpace(other.Text)) await AnswerAsync(question.Id, null, other.Text); };
            DockPanel.SetDock(send, Dock.Right);
            var row = new DockPanel { Margin = new Thickness(0, 4, 0, 0) }; var field = new Grid(); field.Children.Add(other); field.Children.Add(placeholder);
            row.Children.Add(send); row.Children.Add(field);
            inputs.Add(other); Children.Add(row);
            SendOther = send; OtherInput = other;
        }
        else { SendOther = null; OtherInput = null; }
        error.Visibility = error.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        Children.Add(error);
    }
    private Button? SendOther; private TextBox? OtherInput;
    private async Task AnswerAsync(string id, string? choice, string? text)
    {
        if (sending) return;
        sending = true; foreach (var control in inputs) control.IsEnabled = false; if (SendOther is not null) SendOther.IsEnabled = false; error.Text = ""; error.Visibility = Visibility.Collapsed;
        try { Update(await workspace.AnswerAsync(id, choice, text)); }
        catch (Exception exception) { error.Text = "操作の結果を確認できませんでした。現在の状態を更新して確認してください。\n" + exception.Message; error.Visibility = Visibility.Visible; }
        finally { sending = false; foreach (var control in inputs) control.IsEnabled = true; if (SendOther is not null) SendOther.IsEnabled = !string.IsNullOrWhiteSpace(OtherInput?.Text); }
    }
}
