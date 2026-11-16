using System.ComponentModel;
using Avalonia;
using Avalonia.Animation;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input.Platform;
using Avalonia.Styling;
using Avalonia.Threading;
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
    // Reply (conversation reply.md): the quote above the text (tap = jump), the reply icon of the action row under the bubble and the right-click menu.
    private Button? quoteButton;
    private TextBlock? quoteName, quoteText, quoteNote;
    private readonly Button replyButton = ActionButton(Icons.Reply, "このメッセージに返信");
    // Forward (conversation forward.md): the forward icon next to reply, and the mark / quoted content of a forwarded or shared row.
    private readonly Button forwardButton = ActionButton(Icons.Export, "このメッセージを転送");
    private readonly Button copyButton = ActionButton(Icons.Copy, "このメッセージをコピー");
    // Owner 11/17 (a304): three small always-visible icons under the bubble, at its bottom right, the same on every platform.
    private readonly StackPanel actions = new() { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
    private TextBlock? originMark;
    private Border? contentBorder;
    private MarkdownView? contentBody;
    private CancellationTokenSource? flash;
    public string? MessageId => messageId;
    private TextBlock? peerLabel;
    private SecretCard? secret;
    private QuestionCard? question;
    private Border? bubble;
    private string? accentName;
    private readonly TextBlock delivery = new() { FontSize = 14, Foreground = BellTheme.Muted, VerticalAlignment = VerticalAlignment.Center };
    // Mac MessageRow time line: HStack(spacing 6) { ForkSeatBadge, time and status }, padded 5 on both sides.
    private readonly Border forkBadge = ForkBadge();
    private readonly StackPanel timeLine = new() { Orientation = Orientation.Horizontal, Margin = new Thickness(5, 0, 5, 0) };
    private Grid? actionRow;
    private bool entered;
    private static Button ActionButton(string icon, string name)
    {
        var button = new Button { Classes = { "plain" }, Content = Icons.Draw(icon, 16, BellTheme.Muted, thickness: 1.8), Width = 28, Height = 24, Background = Brushes.Transparent, Padding = default, HorizontalContentAlignment = HorizontalAlignment.Center, VerticalContentAlignment = VerticalAlignment.Center };
        AutomationProperties.SetName(button, name); return button;
    }
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
        actions.Children.Add(replyButton); actions.Children.Add(forwardButton); actions.Children.Add(copyButton);
        replyButton.Click += (_, _) => workspace.StartQuote(Message);
        forwardButton.Click += (_, _) => (TopLevel.GetTopLevel(this) as MainWindow)?.ShowForwardSheet(Message);
        copyButton.Click += async (_, _) =>
        {
            if (Message.Message is not { Length: > 0 } text || TopLevel.GetTopLevel(this)?.Clipboard is not { } clipboard) return;
            await clipboard.SetTextAsync(text);
            copyButton.Content = Icons.Draw(Icons.Check, 16, BellTheme.Violet, thickness: 2); await Task.Delay(1200); copyButton.Content = Icons.Draw(Icons.Copy, 16, BellTheme.Muted, thickness: 1.8);
        };
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
        quoteName = new TextBlock { FontSize = 13, FontWeight = FontWeight.Bold, Foreground = BellTheme.Violet, TextTrimming = TextTrimming.CharacterEllipsis };
        quoteText = new TextBlock { FontSize = 14, FontWeight = FontWeight.Normal, Foreground = BellTheme.Muted, TextWrapping = TextWrapping.Wrap, MaxLines = 2, TextTrimming = TextTrimming.CharacterEllipsis };
        quoteNote = new TextBlock { FontSize = 13, FontWeight = FontWeight.Normal, Foreground = BellTheme.Muted, Margin = new Thickness(0, 3, 0, 0) };
        var quoteBox = new Border { BorderBrush = BellTheme.Violet, BorderThickness = new Thickness(3, 0, 0, 0), Background = new SolidColorBrush(Color.FromArgb(40, 0x61, 0x47, 0xD4)), Padding = new Thickness(10, 6), Child = new StackPanel { Children = { quoteName, quoteText, quoteNote } } };
        quoteButton = new Button { Classes = { "plain" }, Content = quoteBox, Background = Brushes.Transparent, Padding = default, HorizontalContentAlignment = HorizontalAlignment.Stretch, HorizontalAlignment = HorizontalAlignment.Stretch };
        quoteButton.Click += (_, _) => { if (Message.ReplyTo is { Available: true } quote) _ = workspace.JumpToAsync(quote); };
        // 引用して返信: only the selected part of this message's text is quoted (reply.md "Quoting a selected part"). The shown text is rendered markup, so no raw offset is known and none is sent.
        body.Menu = ReplyMenu;
        originMark = new TextBlock { FontSize = 13, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Muted, TextTrimming = TextTrimming.CharacterEllipsis };
        contentBody = new MarkdownView { FontSize = 16 };
        contentBorder = new Border { BorderBrush = BellTheme.Muted, BorderThickness = new Thickness(3, 0, 0, 0), Padding = new Thickness(12, 2, 0, 0), Child = contentBody };
        stack = new StackPanel { Children = { quoteButton, originMark, heading, images, imagePlaceholder, body, contentBorder, replyLabel } };
        bubble = new Border { Child = stack, Padding = new Thickness(16, 12, 16, 12), CornerRadius = new CornerRadius(21), BorderThickness = new Thickness(1) };
        accentName = null;
        timeLine.HorizontalAlignment = outgoing ? HorizontalAlignment.Right : HorizontalAlignment.Left;
        actionRow?.Children.Clear();
        // The time stays at the sender's side; the icons sit at the right end, under the bubble's bottom right.
        actionRow = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto"), Children = { timeLine, actions } }; Grid.SetColumn(actions, 1);
        var column = new StackPanel { Children = { stackName, stackImages, bubble, actionRow } };
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

    private MenuFlyout ReplyMenu()
    {
        var part = new MenuItem { Header = "引用して返信" }; var whole = new MenuItem { Header = "返信" }; var copy = new MenuItem { Header = "コピー" };
        part.Click += (_, _) => { if (body!.SelectedText is { Length: > 0 } text) workspace.StartQuote(Message, new QuoteSelection(text)); };
        whole.Click += (_, _) => workspace.StartQuote(Message);
        copy.Click += async (_, _) => { if (body!.SelectedText is { Length: > 0 } text && TopLevel.GetTopLevel(this)?.Clipboard is { } clipboard) await clipboard.SetTextAsync(text); };
        var forward = new MenuItem { Header = "転送" }; forward.Click += (_, _) => (TopLevel.GetTopLevel(this) as MainWindow)?.ShowForwardSheet(Message);
        var flyout = new MenuFlyout { Items = { part, whole, forward, copy } };
        flyout.Opening += (_, _) => { forward.IsEnabled = Timeline.IsForwardable(Message); whole.IsEnabled = Timeline.IsQuotable(Message); var selected = !string.IsNullOrWhiteSpace(body!.SelectedText); part.IsEnabled = whole.IsEnabled && selected; copy.IsEnabled = selected; };
        return flyout;
    }

    // The jump target is pulsed so the eye finds it, and the quoted part is painted for a moment when it can be found in the shown text.
    public void Flash(ReplyReference? quote = null)
    {
        flash?.Cancel(); body?.ClearHighlight(); flash = new CancellationTokenSource(); var token = flash.Token;
        var pulse = new Animation { Duration = TimeSpan.FromMilliseconds(900), Children = { new KeyFrame { Cue = new Cue(0), Setters = { new Setter(OpacityProperty, .6) } }, new KeyFrame { Cue = new Cue(1), Setters = { new Setter(OpacityProperty, 1.0) } } } };
        _ = pulse.RunAsync(this, token);
        if (quote is not { Available: true, Part: true } || body is null || !body.Highlight(quote.Text)) return;
        _ = Task.Delay(TimeSpan.FromSeconds(3), token).ContinueWith(task => { if (!task.IsCanceled) Dispatcher.UIThread.Post(body.ClearHighlight); });
    }

    private void UpdateRow(TimelineMessage message)
    {
        var outgoing = message.IsOutgoing; var urls = message.DisplayedImageUrls; var isRoom = workspace.IsRoom;
        var senderName = message.Kind == "peer" ? message.PeerName : isRoom && !outgoing ? message.Sender?.Title : null;
        var hasStack = urls.Length > 1;
        // A forwarded or shared row: the Owner's comment in the bubble's own text, the content as a quoted block (forward.md "History").
        var origin = message.Origin is { Kind.Length: > 0 } known ? known : null;
        var (text, content) = origin is null ? (message.Message ?? "", "") : Timeline.OriginParts(message);
        var reply = Timeline.ReplyLabel(message, isRoom, workspace.MemberName);
        var quote = message.ReplyTo;
        var hasBubble = !hasStack || text.Length != 0 || content.Length != 0 || reply is not null || quote is not null || origin is not null;
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
        try { body!.Source = text; contentBody!.Source = content; }
        catch (NotSupportedException error) { body!.ShowText(error.Message); }
        body!.IsVisible = text.Length != 0;
        contentBorder!.IsVisible = content.Length != 0;
        originMark!.Text = origin is null ? "" : string.Join(" · ", new[] { Timeline.OriginMark(origin), origin.IsForward ? origin.FromName : null, origin.IsForward && origin.At is { } at ? Timeline.ShortTime(at, DateTimeOffset.Now) : null }.Where(part => !string.IsNullOrEmpty(part)));
        originMark.IsVisible = originMark.Text.Length != 0;
        replyLabel!.Text = reply ?? ""; replyLabel.IsVisible = reply is not null;
        quoteButton!.IsVisible = quote is not null;
        if (quote is not null)
        {
            // An unavailable original draws only the fixed line and is not tappable (reply.md "Original not available").
            quoteName!.Text = quote.Available ? quote.SenderName ?? "" : ""; quoteName.IsVisible = quoteName.Text.Length != 0;
            quoteText!.Text = Timeline.QuoteBody(quote);
            quoteNote!.Text = Timeline.QuoteNote(quote) ?? ""; quoteNote.IsVisible = quoteNote.Text.Length != 0;
            quoteButton.IsHitTestVisible = quoteButton.Focusable = quote.Available;
            AutomationProperties.SetName(quoteButton, quote.Available ? $"返信先 {quoteName.Text}: {quoteText.Text}。押すと元のメッセージへ移動します。" : quoteNote.Text.Length == 0 ? Timeline.UnavailableQuote : quoteText.Text + "。" + Timeline.UnavailableQuote);
        }
        replyButton.IsVisible = Timeline.IsQuotable(message); forwardButton.IsVisible = Timeline.IsForwardable(message); copyButton.IsVisible = forwardButton.IsVisible && !string.IsNullOrEmpty(message.Message);
        actions.IsVisible = replyButton.IsVisible || forwardButton.IsVisible || copyButton.IsVisible;
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
        actionRow!.IsVisible = timeLine.IsVisible || actions.IsVisible;
        actionRow.Margin = new Thickness(0, hasBubble ? 3 : 0, 0, 0); timeLine.Margin = new Thickness(5, 0, 5, 0); actions.Margin = new Thickness(0, 0, 3, 0);
    }
}
