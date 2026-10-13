using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

public sealed class SecretCard(Workspace workspace, string author) : StackPanel
{
    private SecretRequest? current;
    private string currentAuthor = author;
    public void Update(SecretRequest request) => Update(request, currentAuthor);
    public void Update(SecretRequest request, string sender)
    {
        if (current == request && currentAuthor == sender) return;
        current = request; currentAuthor = sender; Children.Clear();
        Children.Add(CardText(currentAuthor + " · 秘密情報の入力", bold: true));
        Children.Add(CardBody(request.Message));
        Children.Add(CardText(request.Label + " / " + request.ToolId));
        if (request.Status == "pending")
        {
            var open = new Button { Content = "安全な入力欄を開く", HorizontalAlignment = HorizontalAlignment.Left };
            open.Click += (_, _) => new SecretInputWindow(request, value => workspace.FinishSecretAsync(request.Id, value), Update) { Owner = Window.GetWindow(this) }.ShowDialog();
            Children.Add(open);
        }
        else Children.Add(CardText(request.Status switch { "submitted" => "登録済み", "cancelled" => "入力を取り消しました", _ => "不明な入力状態: " + request.Status }));
        if (request.Notification == "failed") Children.Add(CardText("AIへの通知に失敗しました。チャットで完了を知らせてください。", error: true));
    }
    internal static TextBlock CardText(string text, bool bold = false, bool error = false) => new() { Text = text, TextWrapping = TextWrapping.Wrap, FontSize = 16, FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal, Foreground = error ? Brushes.Firebrick : Brushes.DarkSlateGray, Margin = new Thickness(0, 4, 0, 8) };
    internal static TextBox CardBody(string text) => new() { Text = text, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontSize = 18, BorderThickness = new Thickness(0), Background = Brushes.Transparent, Padding = new Thickness(0), Margin = new Thickness(0, 4, 0, 8) };
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
        panel.Children.Add(SecretCard.CardText("値は会話に送信されません。BellTeamの利用者領域へ保存します。"));
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
    private readonly TextBlock error = SecretCard.CardText("", error: true);
    public void Update(OwnerQuestion question) => Update(question, currentAuthor);
    public void Update(OwnerQuestion question, string sender)
    {
        if (current is { } old && old.Id == question.Id && old.Status == question.Status && old.Question == question.Question && old.AllowOther == question.AllowOther && old.Answer == question.Answer && old.Options.SequenceEqual(question.Options))
        {
            current = question; currentAuthor = sender;
            ((TextBlock)Children[0]).Text = currentAuthor + " · 選んでほしいこと";
            return;
        }
        current = question; currentAuthor = sender; Children.Clear(); inputs.Clear();
        Children.Add(SecretCard.CardText(currentAuthor + " · 選んでほしいこと", bold: true));
        Children.Add(SecretCard.CardBody(question.Question));
        if (question.Status == "answered") { Children.Add(SecretCard.CardText("回答: " + question.Answer, bold: true)); return; }
        if (question.Status != "open") { Children.Add(SecretCard.CardText("不明な回答状態: " + question.Status, error: true)); return; }
        var choices = new WrapPanel();
        foreach (var option in question.Options)
        {
            var button = new Button { Content = option, IsEnabled = !sending };
            button.Click += async (_, _) => await AnswerAsync(question.Id, option, null);
            choices.Children.Add(button); inputs.Add(button);
        }
        Children.Add(choices);
        if (question.AllowOther)
        {
            Children.Add(SecretCard.CardText("その他（文章で答える）"));
            var other = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MaxHeight = 110, IsEnabled = !sending };
            var send = new Button { Content = "送る", HorizontalAlignment = HorizontalAlignment.Right, IsEnabled = !sending };
            send.Click += async (_, _) => { if (!string.IsNullOrWhiteSpace(other.Text)) await AnswerAsync(question.Id, null, other.Text); };
            inputs.Add(other); inputs.Add(send); Children.Add(other); Children.Add(send);
        }
        error.Visibility = error.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        Children.Add(error);
    }
    private async Task AnswerAsync(string id, string? choice, string? text)
    {
        if (sending) return;
        sending = true; foreach (var control in inputs) control.IsEnabled = false; error.Text = ""; error.Visibility = Visibility.Collapsed;
        try { Update(await workspace.AnswerAsync(id, choice, text)); }
        catch (Exception exception) { error.Text = "操作の結果を確認できませんでした。現在の状態を更新して確認してください。\n" + exception.Message; error.Visibility = Visibility.Visible; }
        finally { sending = false; foreach (var control in inputs) control.IsEnabled = true; }
    }
}
