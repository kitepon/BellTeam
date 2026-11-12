using System.ComponentModel;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;

namespace BellTeam.Linux;

// One conversation row, built like the Mac MessageRow: a Bot-to-bot capsule, a request card, or a bubble with its time line.
public sealed class MessageCard : ContentControl
{
    private readonly MessageItem item;
    private readonly LinuxWorkspace workspace;
    private TimelineMessage Message => item.Message;
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
    private TextBlock? peerLabel;
    private SecretCard? secret;
    private QuestionCard? question;
    private Border? bubble;
    private string? accentName;
    private readonly TextBlock delivery = new() { FontSize = 14, Foreground = BellTheme.Muted, VerticalAlignment = VerticalAlignment.Center };
    // Mac MessageRow time line: HStack(spacing 6) { ForkSeatBadge, time and status }, padded 5 on both sides.
    private readonly Border forkBadge = ForkBadge();
    private readonly StackPanel timeLine = new() { Orientation = Orientation.Horizontal, Margin = new Thickness(5, 0, 5, 0) };
    private bool entered;
    // What Workspace.Opening was when this card loaded (the staggered opening or the short arrival animation).
    internal bool? EnteredAsOpening { get; private set; }

    // 「分身」: a violet capsule with the branch mark (Mac ForkSeatBadge, arrow.triangle.branch). The screen reader reads the text 「分身」.
    private static Border ForkBadge()
    {
        var label = new TextBlock { Text = "分身", FontSize = 14, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Violet, VerticalAlignment = VerticalAlignment.Center };
        return new Border
        {
            Background = new SolidColorBrush(Color.FromArgb(191, 0xE8, 0xE0, 0xFF)), CornerRadius = new CornerRadius(99), Padding = new Thickness(8, 2, 8, 2), Margin = new Thickness(0, 0, 6, 0),
            Child = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 5, Children = { Icons.Draw(Icons.Branch, 14, BellTheme.Violet, thickness: 2), label } }
        };
    }

    public MessageCard(MessageItem item, LinuxWorkspace workspace)
    {
        this.item = item; this.workspace = workspace;
        Padding = default; Margin = new Thickness(0, 0, 0, 17);
        timeLine.Children.Add(forkBadge); timeLine.Children.Add(delivery);
        Loaded += (_, _) =>
        {
            if (entered) return;
            entered = true; EnteredAsOpening = workspace.Opening; MessageEntrance.Play(this, workspace.Messages.Count - 1 - Math.Max(0, workspace.Messages.IndexOf(item)), workspace.Opening);
        };
        Render();
    }
    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        item.PropertyChanged += ItemChanged; workspace.PropertyChanged += WorkspaceChanged; Render(); UpdateAccent();
    }
    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e) { item.PropertyChanged -= ItemChanged; workspace.PropertyChanged -= WorkspaceChanged; base.OnDetachedFromVisualTree(e); }
    private void ItemChanged(object? sender, PropertyChangedEventArgs args) => Render();
    private void WorkspaceChanged(object? sender, PropertyChangedEventArgs args) { if (args.PropertyName == nameof(LinuxWorkspace.Selected)) UpdateAccent(); }
    private void UpdateAccent()
    {
        if (bubble is null || Message is not { } message) return;
        var name = (workspace.IsRoom ? workspace.Bots.FirstOrDefault(bot => bot.Id == message.Sender?.Id)?.Color : workspace.Selected?.Bot?.Color) ?? "violet";
        if (accentName == name) return;
        accentName = name; var accent = BellColors.Accent(name);
        bubble.Background = new SolidColorBrush(message.IsOutgoing ? Colors.White : Color.FromArgb(46, accent.R, accent.G, accent.B));
        bubble.BorderBrush = new SolidColorBrush(message.IsOutgoing ? Color.FromRgb(229, 227, 240) : Color.FromArgb(90, accent.R, accent.G, accent.B));
        heading!.Foreground = message.IsOutgoing ? BellTheme.Muted : new SolidColorBrush(accent); stackName!.Foreground = new SolidColorBrush(accent);
    }
    private void Render()
    {
        var message = Message;
        if (messageId != message.Id)
        {
            messageId = message.Id; layout = null;
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
        var label = new TextBlock { FontSize = 14, Foreground = BellTheme.Muted, VerticalAlignment = VerticalAlignment.Center, Text = $"{message.PeerName ?? "メンバー"}との連絡" };
        var capsule = new Border
        {
            Background = new SolidColorBrush(Color.FromArgb(191, 255, 255, 255)), CornerRadius = new CornerRadius(99), Padding = new Thickness(15, 9, 15, 9),
            Child = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { Icons.Draw(Icons.Link, 14, BellTheme.Muted, thickness: 1.6), label, Icons.Draw(Icons.ChevronRight, 10, BellTheme.Muted, thickness: 2.4) } }
        };
        var button = new Button { Classes = { "plain" }, Content = capsule, Background = Brushes.Transparent, Padding = default, Margin = default, CornerRadius = new CornerRadius(99), HorizontalAlignment = HorizontalAlignment.Center };
        AutomationProperties.SetName(button, label.Text);
        button.Click += (_, _) => (TopLevel.GetTopLevel(this) as MainWindow)?.ShowPeerSheet(Message);
        Content = button; peerLabel = label;
    }

    private void BuildRequest(TimelineMessage message)
    {
        var card = new Border { Background = new SolidColorBrush(Color.FromArgb(230, 255, 255, 255)), CornerRadius = new CornerRadius(20), BorderBrush = new SolidColorBrush(Color.FromArgb(51, 97, 71, 212)), BorderThickness = new Thickness(1), Padding = new Thickness(20) };
        if (message.SecretRequest is not null) { secret = new SecretCard(workspace, workspace.Title); card.Child = secret; }
        else { question = new QuestionCard(workspace, workspace.Title); card.Child = question; }
        Content = new CappedRow { Child = card, HorizontalAlignment = HorizontalAlignment.Left };
    }
    private void UpdateRequest(TimelineMessage message)
    {
        if (message.SecretRequest is { } request) secret?.Update(request, BotName(request.BotId, message));
        if (message.OwnerQuestion is { } ownerQuestion) question?.Update(ownerQuestion, BotName(ownerQuestion.BotId, message));
    }
    // Mac cards name the asking bot by its id, not by who the timeline says sent it.
    private string BotName(string? botId, TimelineMessage message) => workspace.Bots.FirstOrDefault(bot => bot.Id == botId)?.Name ?? message.Sender?.Title ?? workspace.Title;

    private void BuildRow(TimelineMessage message)
    {
        var outgoing = message.IsOutgoing;
        stackName = new TextBlock { FontSize = 14, FontWeight = FontWeight.Bold, Margin = new Thickness(0, 0, 0, 5), HorizontalAlignment = outgoing ? HorizontalAlignment.Right : HorizontalAlignment.Left };
        stackImages = new RemoteImages(workspace) { Margin = new Thickness(0, 0, 0, 8) };
        heading = new TextBlock { FontSize = 14, FontWeight = FontWeight.Bold };
        images = new RemoteImages(workspace);
        imageLabel = new TextBlock { FontSize = 15, VerticalAlignment = VerticalAlignment.Center };
        imagePlaceholder = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 7, Children = { Icons.Draw(Icons.Image, 16, Brushes.SlateGray, thickness: 1.6), imageLabel } };
        body = new MarkdownView { FontSize = 18 };
        replyLabel = new TextBlock { FontSize = 11, Foreground = BellTheme.Muted };
        stack = new StackPanel { Children = { heading, images, imagePlaceholder, body, replyLabel } };
        bubble = new Border { Child = stack, Padding = new Thickness(16, 12, 16, 12), CornerRadius = new CornerRadius(21), BorderThickness = new Thickness(1) };
        accentName = null;
        timeLine.HorizontalAlignment = outgoing ? HorizontalAlignment.Right : HorizontalAlignment.Left;
        (timeLine.Parent as Panel)?.Children.Remove(timeLine);
        var column = new StackPanel { Children = { stackName, stackImages, bubble, timeLine } };
        // Mac: a room shows the sender's 30 avatar beside incoming rows; the free 45 on the opposite side is the Spacer(minLength: 45).
        layout = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*"), Margin = outgoing ? new Thickness(45, 0, 0, 0) : new Thickness(0, 0, 45, 0) };
        if (workspace.IsRoom && !outgoing)
        {
            avatar = new AvatarTile { Width = 30, Height = 30, Margin = new Thickness(0, 0, 8, 1), VerticalAlignment = VerticalAlignment.Bottom, Workspace = workspace };
            layout.Children.Add(avatar);
        }
        else avatar = null;
        Grid.SetColumn(column, 1); layout.Children.Add(column);
        Content = new CappedRow { Child = layout, HorizontalAlignment = outgoing ? HorizontalAlignment.Right : HorizontalAlignment.Left }; // fills the width like a Mac bubble, up to a cap, at the sender's side
    }

    private void UpdateRow(TimelineMessage message)
    {
        var outgoing = message.IsOutgoing; var urls = message.DisplayedImageUrls; var isRoom = workspace.IsRoom;
        var senderName = message.Kind == "peer" ? message.PeerName : isRoom && !outgoing ? message.Sender?.Title : null;
        var hasStack = urls.Length > 1;
        var text = message.Message ?? "";
        var reply = Timeline.ReplyLabel(message, isRoom, workspace.MemberName);
        var hasBubble = !hasStack || text.Length != 0 || reply is not null;
        if (avatar is not null && message.Sender is { } sender)
        {
            var entry = workspace.MemberEntry(sender.Id) ?? new ConversationEntry(new(sender.Id, false), sender.Title, "", DateTimeOffset.MinValue, null, null);
            if (avatar.Entry?.AvatarUrl != entry.AvatarUrl || avatar.Entry?.Name != entry.Name || avatar.Entry?.Bot?.Avatar != entry.Bot?.Avatar) avatar.Entry = entry;
        }
        stackName!.Text = senderName ?? ""; stackName.IsVisible = hasStack && !string.IsNullOrEmpty(senderName);
        stackImages!.Update(hasStack ? urls : [], outgoing); stackImages.IsVisible = hasStack;
        bubble!.IsVisible = hasBubble;
        heading!.Text = senderName ?? ""; heading.IsVisible = !hasStack && !string.IsNullOrEmpty(senderName);
        UpdateAccent();
        images!.Update(hasStack ? [] : urls, outgoing); images.IsVisible = urls.Length == 1;
        var count = message.ImageCount ?? 1;
        imageLabel!.Text = count > 1 ? $"画像{count}枚" : "画像";
        imagePlaceholder!.IsVisible = message.Image == true && urls.Length == 0;
        try { body!.Source = text; }
        catch (NotSupportedException error) { body!.ShowText(error.Message); }
        body!.IsVisible = text.Length != 0;
        replyLabel!.Text = reply ?? ""; replyLabel.IsVisible = reply is not null;
        // VStack(spacing: 8): space only between the parts that are showing.
        var first = true;
        foreach (var part in stack!.Children) { if (!part.IsVisible) continue; part.Margin = new Thickness(0, first ? 0 : 8, 0, 0); first = false; }
        var state = Timeline.DeliveryLabel(message, isRoom);
        delivery.Text = string.Join(" · ", new[] { Timeline.ShortTime(message.At, DateTimeOffset.Now), state }.Where(part => part.Length != 0));
        delivery.Foreground = state == "配達失敗" ? BellTheme.Red : BellTheme.Muted;
        delivery.IsVisible = delivery.Text.Length != 0;
        // Only a member's own conversation labels fork rows (a room's rows carry no seat).
        var fork = !isRoom && message.IsFork;
        forkBadge.IsVisible = fork;
        timeLine.IsVisible = delivery.Text.Length != 0 || fork;
        timeLine.Margin = new Thickness(5, hasBubble ? 5 : 0, 5, 0);
    }
}
