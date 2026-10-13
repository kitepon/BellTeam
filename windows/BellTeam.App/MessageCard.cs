using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

public sealed class MessageCard : ContentControl
{
    public static readonly DependencyProperty MessageProperty = DependencyProperty.Register(nameof(Message), typeof(TimelineMessage), typeof(MessageCard), new PropertyMetadata(null, Changed));
    public TimelineMessage Message { get => (TimelineMessage)GetValue(MessageProperty); set => SetValue(MessageProperty, value); }
    public static readonly DependencyProperty AuthorProperty = DependencyProperty.Register(nameof(Author), typeof(string), typeof(MessageCard), new PropertyMetadata("", Changed));
    public string Author { get => (string)GetValue(AuthorProperty); set => SetValue(AuthorProperty, value); }
    public static readonly DependencyProperty WorkspaceProperty = DependencyProperty.Register(nameof(Workspace), typeof(Workspace), typeof(MessageCard), new PropertyMetadata(null, Changed));
    public Workspace Workspace { get => (Workspace)GetValue(WorkspaceProperty); set => SetValue(WorkspaceProperty, value); }
    private string? messageId;
    private StackPanel? stack;
    private TextBlock? heading;
    private MarkdownView? body;
    private RemoteImages? images;
    private SecretCard? secret;
    private QuestionCard? question;
    private readonly TextBlock delivery = new() { FontSize = 12, Foreground = Brushes.Gray };
    private static void Changed(DependencyObject sender, DependencyPropertyChangedEventArgs args) => ((MessageCard)sender).Render();
    private void Render()
    {
        if (Message is not { } message || Workspace is null) return;
        if (messageId != message.Id)
        {
            messageId = message.Id; secret = null; question = null;
            stack = new StackPanel(); heading = new TextBlock { FontSize = 14, Foreground = Brushes.Gray, Margin = new Thickness(0, 0, 0, 6) };
            body = new MarkdownView { FontSize = 18 }; images = new RemoteImages(Workspace);
            stack.Children.Add(heading); stack.Children.Add(images); stack.Children.Add(body);
            // 行の部品を作り直す時は以前の親から状態欄を外す。
            if (delivery.Parent is Panel parent) parent.Children.Remove(delivery);
            stack.Children.Add(delivery);
            var card = new Border { Child = stack, Padding = new Thickness(14), CornerRadius = new CornerRadius(12), Background = new SolidColorBrush(message.IsOutgoing ? Color.FromRgb(233, 225, 245) : Colors.White), Margin = message.IsOutgoing ? new Thickness(35, 0, 0, 0) : new Thickness(0, 0, 20, 0) };
            Content = message.Kind == "peer" ? new Expander { Header = $"{message.PeerName ?? "メンバー"}との連絡", Content = card } : card;
        }
        heading!.Text = $"{(message.IsOutgoing ? "あなた" : message.Sender?.Title ?? Author)}  {message.At.ToLocalTime():M/d HH:mm}";
        images!.Update(message.DisplayedImageUrls);
        try { body!.Source = message.Message ?? ""; }
        catch (NotSupportedException error) { body!.Document = new System.Windows.Documents.FlowDocument(new System.Windows.Documents.Paragraph(new System.Windows.Documents.Run(error.Message))); }
        body!.Visibility = message.SecretRequest is null && message.OwnerQuestion is null ? Visibility.Visible : Visibility.Collapsed;
        if (message.SecretRequest is { } request)
        {
            if (secret is null) { secret = new SecretCard(Workspace, Author); stack!.Children.Add(secret); }
            secret.Update(request, message.Sender?.Title ?? Author);
        }
        if (message.OwnerQuestion is { } ownerQuestion)
        {
            if (question is null) { question = new QuestionCard(Workspace, Author); stack!.Children.Add(question); }
            question.Update(ownerQuestion, message.Sender?.Title ?? Author);
        }
        delivery.Text = message.Delivery switch { "failed" => "送信できませんでした", "queued" => "送信待ち", "running" => "処理中", _ => message.Image == true && message.DisplayedImageUrls.Length == 0 ? $"画像{message.ImageCount ?? 1}枚" : "" };
        delivery.Visibility = delivery.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
    }
}
