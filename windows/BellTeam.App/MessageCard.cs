using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.ComponentModel;
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
    private Border? bubble;
    private string? accentName;
    private readonly TextBlock delivery = new() { FontSize = 14, Foreground = Brushes.SlateGray, Margin = new Thickness(5, 6, 5, 0) };
    private static void Changed(DependencyObject sender, DependencyPropertyChangedEventArgs args)
    {
        var card = (MessageCard)sender;
        if (args.Property == WorkspaceProperty)
        {
            if (args.OldValue is Workspace previous) WeakEventManager<Workspace, PropertyChangedEventArgs>.RemoveHandler(previous, nameof(BellTeam.App.Workspace.PropertyChanged), card.WorkspaceUpdated);
            if (args.NewValue is Workspace next) WeakEventManager<Workspace, PropertyChangedEventArgs>.AddHandler(next, nameof(BellTeam.App.Workspace.PropertyChanged), card.WorkspaceUpdated);
        }
        card.Render();
    }
    private void WorkspaceUpdated(object? sender, PropertyChangedEventArgs args) { if (args.PropertyName == nameof(BellTeam.App.Workspace.Selected)) UpdateAccent(); }
    private void UpdateAccent()
    {
        if (bubble is null || Message is not { } message || Workspace is null) return;
        var name = (Workspace.IsRoom ? Workspace.Bots.FirstOrDefault(bot => bot.Id == message.Sender?.Id)?.Color : Workspace.Selected?.Bot?.Color) ?? "violet";
        if (accentName == name) return;
        accentName = name; var accent = BellColors.Accent(name);
        bubble.Background = new SolidColorBrush(message.IsOutgoing ? Colors.White : Color.FromArgb(46, accent.R, accent.G, accent.B));
        bubble.BorderBrush = new SolidColorBrush(message.IsOutgoing ? Color.FromRgb(229, 227, 240) : Color.FromArgb(90, accent.R, accent.G, accent.B));
        heading!.Foreground = new SolidColorBrush(accent);
    }
    private void Render()
    {
        if (Message is not { } message || Workspace is null) return;
        if (messageId != message.Id)
        {
            messageId = message.Id; secret = null; question = null;
            stack = new StackPanel(); heading = new TextBlock { FontSize = 14, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(Color.FromRgb(97, 71, 212)), Margin = new Thickness(0, 0, 0, 8) };
            body = new MarkdownView { FontSize = 18 }; images = new RemoteImages(Workspace);
            stack.Children.Add(heading); stack.Children.Add(images); stack.Children.Add(body);
            // 行の部品を作り直す時は以前の親から状態欄を外す。
            if (delivery.Parent is Panel parent) parent.Children.Remove(delivery);
            var accent = BellColors.Accent(Workspace.IsRoom ? Workspace.Bots.FirstOrDefault(bot => bot.Id == message.Sender?.Id)?.Color : Workspace.Selected?.Bot?.Color);
            var card = new Border { Child = stack, Padding = new Thickness(16, 12, 16, 12), CornerRadius = new CornerRadius(21), BorderThickness = new Thickness(1), BorderBrush = new SolidColorBrush(message.IsOutgoing ? Color.FromRgb(229, 227, 240) : Color.FromArgb(90, accent.R, accent.G, accent.B)), Background = new SolidColorBrush(message.IsOutgoing ? Colors.White : Color.FromArgb(46, accent.R, accent.G, accent.B)) };
            bubble = card; accentName = null;
            var row = new StackPanel { Margin = message.IsOutgoing ? new Thickness(45, 0, 0, 0) : new Thickness(0, 0, 45, 0) }; row.Children.Add(card); row.Children.Add(delivery);
            Content = message.Kind == "peer" ? new Expander { Header = $"{message.PeerName ?? "メンバー"}との連絡", Content = row } : row;
        }
        heading!.Text = message.IsOutgoing ? "あなた" : message.Sender?.Title ?? Author;
        heading.Visibility = message.Kind == "peer" || Workspace.IsRoom && !message.IsOutgoing ? Visibility.Visible : Visibility.Collapsed;
        UpdateAccent();
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
        var state = message.IsOutgoing ? message.Delivery switch { "failed" => "配達失敗", "queued" => "送信待ち", "running" => "処理中", "delivered" => "配達済み", _ => "" } : "";
        delivery.Text = message.At.ToLocalTime().ToString("M/d HH:mm") + (state.Length == 0 ? "" : " · " + state);
        delivery.HorizontalAlignment = message.IsOutgoing ? HorizontalAlignment.Right : HorizontalAlignment.Left;
        delivery.Visibility = delivery.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
    }
}
