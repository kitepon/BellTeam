using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.ComponentModel;
using BellTeam.Core;

namespace BellTeam.App;

// One conversation row, built like the Mac MessageRow: a Bot-to-bot capsule, a request card, or a bubble with its time line.
public sealed class MessageCard : ContentControl
{
    public static readonly DependencyProperty MessageProperty = DependencyProperty.Register(nameof(Message), typeof(TimelineMessage), typeof(MessageCard), new PropertyMetadata(null, Changed));
    public TimelineMessage Message { get => (TimelineMessage)GetValue(MessageProperty); set => SetValue(MessageProperty, value); }
    public static readonly DependencyProperty AuthorProperty = DependencyProperty.Register(nameof(Author), typeof(string), typeof(MessageCard), new PropertyMetadata("", Changed));
    public string Author { get => (string)GetValue(AuthorProperty); set => SetValue(AuthorProperty, value); }
    public static readonly DependencyProperty WorkspaceProperty = DependencyProperty.Register(nameof(Workspace), typeof(Workspace), typeof(MessageCard), new PropertyMetadata(null, Changed));
    public Workspace Workspace { get => (Workspace)GetValue(WorkspaceProperty); set => SetValue(WorkspaceProperty, value); }
    private static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");
    private static readonly Brush Muted = Frozen(Color.FromRgb(120, 125, 145)), Failed = Frozen(Color.FromRgb(255, 59, 48));
    private static Brush Frozen(Color color) { var brush = new SolidColorBrush(color); brush.Freeze(); return brush; }
    private string? messageId;
    private Grid? layout;
    private AvatarTile? avatar;
    private TextBlock? stackName;
    private RemoteImages? stackImages;
    private StackPanel? stack;
    private TextBlock? heading;
    private MarkdownView? body;
    private RemoteImages? images;
    private StackPanel? imagePlaceholder;
    private TextBlock? imageLabel;
    private TextBlock? replyLabel;
    private SecretCard? secret;
    private QuestionCard? question;
    private Border? bubble;
    private string? accentName;
    private readonly TextBlock delivery = new() { FontSize = 14, Foreground = Muted, Margin = new Thickness(5, 0, 5, 0) };
    private bool entered;
    public MessageCard()
    {
        Loaded += (_, _) =>
        {
            if (entered || Workspace is null || DataContext is not MessageItem item) return;
            entered = true; MessageEntrance.Play(this, Workspace.Messages.Count - 1 - Math.Max(0, Workspace.Messages.IndexOf(item)), Workspace.Opening);
        };
    }
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
        var label = new SolidColorBrush(message.IsOutgoing ? Color.FromRgb(120, 125, 145) : accent);
        heading!.Foreground = label; stackName!.Foreground = new SolidColorBrush(accent);
    }
    private static TextBlock Glyph(string text, double size, Brush brush) => new() { Text = text, FontFamily = Icons, FontSize = size, Foreground = brush, VerticalAlignment = VerticalAlignment.Center };
    private void Render()
    {
        if (Message is not { } message || Workspace is null) return;
        if (messageId != message.Id)
        {
            messageId = message.Id; secret = null; question = null;
            if (message.Kind == "peer") BuildPeer(message);
            else if (message.SecretRequest is not null || message.OwnerQuestion is not null) BuildRequest(message);
            else BuildRow(message);
        }
        if (layout is not null) UpdateRow(message);
        else if (secret is not null || question is not null) UpdateRequest(message);
        else if (peerLabel is not null) peerLabel.Text = $"{message.PeerName ?? "メンバー"}との連絡";
    }

    // "<name>との連絡 ›": the message itself opens in the 「メンバー間の連絡」 sheet.
    private void BuildPeer(TimelineMessage message)
    {
        layout = null;
        var label = new TextBlock { FontSize = 14, Foreground = Muted, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(8, 0, 8, 0), Text = $"{message.PeerName ?? "メンバー"}との連絡" };
        var capsule = new Border { Background = new SolidColorBrush(Color.FromArgb(191, 255, 255, 255)), CornerRadius = new CornerRadius(99), Padding = new Thickness(15, 9, 15, 9), Child = new StackPanel { Orientation = Orientation.Horizontal, Children = { Glyph("", 13, Muted), label, Glyph("", 10, Muted) } } };
        var button = new Button { Content = capsule, Padding = new Thickness(0), Margin = new Thickness(0), HorizontalAlignment = HorizontalAlignment.Center, Cursor = System.Windows.Input.Cursors.Hand };
        button.SetResourceReference(StyleProperty, "QuietButton"); button.Padding = new Thickness(0); button.Margin = new Thickness(0);
        System.Windows.Automation.AutomationProperties.SetName(button, label.Text);
        button.Click += (_, _) => (Window.GetWindow(this) as MainWindow)?.ShowPeerSheet(Message);
        Content = button; peerLabel = label;
    }
    private TextBlock? peerLabel;

    private void BuildRequest(TimelineMessage message)
    {
        layout = null;
        var card = new Border { Background = new SolidColorBrush(Color.FromArgb(230, 255, 255, 255)), CornerRadius = new CornerRadius(20), BorderBrush = new SolidColorBrush(Color.FromArgb(51, 97, 71, 212)), BorderThickness = new Thickness(1), Padding = new Thickness(20) };
        if (message.SecretRequest is not null) { secret = new SecretCard(Workspace, Author); card.Child = secret; }
        else { question = new QuestionCard(Workspace, Author); card.Child = question; }
        Content = new CappedRow { Child = card, HorizontalAlignment = HorizontalAlignment.Left };
    }
    private void UpdateRequest(TimelineMessage message)
    {
        if (message.SecretRequest is { } request) secret?.Update(request, BotName(request.BotId, message));
        if (message.OwnerQuestion is { } ownerQuestion) question?.Update(ownerQuestion, BotName(ownerQuestion.BotId, message));
    }
    // Mac cards name the asking bot by its id, not by who the timeline says sent it.
    private string BotName(string botId, TimelineMessage message) => Workspace.Bots.FirstOrDefault(bot => bot.Id == botId)?.Name ?? message.Sender?.Title ?? Author;

    private void BuildRow(TimelineMessage message)
    {
        var outgoing = message.IsOutgoing;
        stackName = new TextBlock { FontSize = 14, FontWeight = FontWeights.Bold, Margin = new Thickness(0, 0, 0, 5), HorizontalAlignment = outgoing ? HorizontalAlignment.Right : HorizontalAlignment.Left };
        stackImages = new RemoteImages(Workspace) { Margin = new Thickness(0, 0, 0, 8) };
        heading = new TextBlock { FontSize = 14, FontWeight = FontWeights.Bold };
        images = new RemoteImages(Workspace);
        imageLabel = new TextBlock { FontSize = 15, VerticalAlignment = VerticalAlignment.Center };
        imagePlaceholder = new StackPanel { Orientation = Orientation.Horizontal, Children = { Glyph("", 15, Brushes.SlateGray), imageLabel } };
        imageLabel.Margin = new Thickness(7, 0, 0, 0);
        body = new MarkdownView { FontSize = 18 };
        replyLabel = new TextBlock { FontSize = 11, Foreground = Muted };
        stack = new StackPanel { Children = { heading, images, imagePlaceholder, body, replyLabel } };
        bubble = new Border { Child = stack, Padding = new Thickness(16, 12, 16, 12), CornerRadius = new CornerRadius(21), BorderThickness = new Thickness(1) };
        accentName = null;
        delivery.HorizontalAlignment = outgoing ? HorizontalAlignment.Right : HorizontalAlignment.Left;
        if (delivery.Parent is Panel previousParent) previousParent.Children.Remove(delivery);
        var column = new StackPanel { Children = { stackName, stackImages, bubble, delivery } };
        // Mac: a room shows the sender's 30 avatar beside incoming rows; the free 45 on the opposite side is the Spacer(minLength: 45).
        layout = new Grid { Margin = outgoing ? new Thickness(45, 0, 0, 0) : new Thickness(0, 0, 45, 0) };
        layout.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); layout.ColumnDefinitions.Add(new ColumnDefinition());
        if (Workspace.IsRoom && !outgoing)
        {
            avatar = new AvatarTile { Width = 30, Height = 30, Margin = new Thickness(0, 0, 8, 1), VerticalAlignment = VerticalAlignment.Bottom, Workspace = Workspace };
            layout.Children.Add(avatar);
        }
        else avatar = null;
        Grid.SetColumn(column, 1); layout.Children.Add(column);
        Content = new CappedRow { Child = layout, HorizontalAlignment = outgoing ? HorizontalAlignment.Right : HorizontalAlignment.Left }; // fills the width like a Mac bubble, up to a cap, at the sender's side
    }

    private void UpdateRow(TimelineMessage message)
    {
        var outgoing = message.IsOutgoing; var urls = message.DisplayedImageUrls; var isRoom = Workspace.IsRoom;
        var senderName = message.Kind == "peer" ? message.PeerName : isRoom && !outgoing ? message.Sender?.Title : null;
        var hasStack = urls.Length > 1;
        var text = message.Message ?? "";
        var reply = Timeline.ReplyLabel(message, isRoom, Workspace.MemberName);
        var hasBubble = !hasStack || text.Length != 0 || reply is not null;
        if (avatar is not null && message.Sender is { } sender)
        {
            var entry = Workspace.MemberEntry(sender.Id) ?? new ConversationEntry(new(sender.Id, false), sender.Title, "", DateTimeOffset.MinValue, null, null);
            if (avatar.Entry?.AvatarUrl != entry.AvatarUrl || avatar.Entry?.Name != entry.Name || avatar.Entry?.Bot?.Avatar != entry.Bot?.Avatar) avatar.Entry = entry;
        }
        stackName!.Text = senderName ?? ""; stackName.Visibility = hasStack && !string.IsNullOrEmpty(senderName) ? Visibility.Visible : Visibility.Collapsed;
        stackImages!.Update(hasStack ? urls : [], outgoing); stackImages.Visibility = hasStack ? Visibility.Visible : Visibility.Collapsed;
        bubble!.Visibility = hasBubble ? Visibility.Visible : Visibility.Collapsed;
        heading!.Text = senderName ?? ""; heading.Visibility = !hasStack && !string.IsNullOrEmpty(senderName) ? Visibility.Visible : Visibility.Collapsed;
        UpdateAccent();
        images!.Update(hasStack ? [] : urls, outgoing); images.Visibility = urls.Length == 1 ? Visibility.Visible : Visibility.Collapsed;
        var count = message.ImageCount ?? 1;
        imageLabel!.Text = count > 1 ? $"画像{count}枚" : "画像";
        imagePlaceholder!.Visibility = message.Image == true && urls.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        try { body!.Source = text; }
        catch (NotSupportedException error) { body!.Document = new System.Windows.Documents.FlowDocument(new System.Windows.Documents.Paragraph(new System.Windows.Documents.Run(error.Message))); }
        body!.Visibility = text.Length != 0 ? Visibility.Visible : Visibility.Collapsed;
        replyLabel!.Text = reply ?? ""; replyLabel.Visibility = reply is null ? Visibility.Collapsed : Visibility.Visible;
        // VStack(spacing: 8): space only between the parts that are showing.
        var first = true;
        foreach (UIElement part in stack!.Children) { if (part.Visibility == Visibility.Collapsed) continue; ((FrameworkElement)part).Margin = new Thickness(part == body ? -5 : 0, first ? 0 : 8, part == body ? -5 : 0, 0); first = false; } // the rich text box insets its text by 5
        var state = Timeline.DeliveryLabel(message, isRoom);
        delivery.Text = string.Join(" · ", new[] { Timeline.ShortTime(message.At, DateTimeOffset.Now), state }.Where(part => part.Length != 0));
        delivery.Foreground = state == "配達失敗" ? Failed : Muted;
        delivery.Visibility = delivery.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        if (hasBubble) delivery.Margin = new Thickness(5, 5, 5, 0);
    }
}
