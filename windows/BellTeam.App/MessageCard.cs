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
    // Reply (conversation reply.md): the quote above the text, tap = jump; the reply icon under the bubble and the right-click menu.
    private Button? quoteButton;
    private TextBlock? quoteName, quoteText, quoteNote;
    // Forward (forward.md): the origin mark above a forwarded or shared row, and its content as a quoted block under the Owner's comment.
    private TextBlock? originMark;
    private Border? contentBorder;
    private MarkdownView? contentBody;
    // Bubble actions (a303, the same row on every platform): three small icons at the bubble's bottom right, always visible. Reply and forward act as the right-click menu does; copy puts the message text on the clipboard.
    private readonly Button replyButton = ActionIcon("", AppStrings.MessageCard_replyButton_1, AppStrings.MessageCard_replyButton_2);
    private readonly Button forwardButton = ActionIcon("", AppStrings.ForwardView_SaveLabel_2, AppStrings.MessageCard_forwardButton_2);
    private readonly Button copyButton = ActionIcon("", AppStrings.MessageCard_copyButton_1, AppStrings.MessageCard_copyButton_2);
    private readonly StackPanel actions = new() { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Right };
    private Grid? footer;
    private SecretCard? secret;
    private QuestionCard? question;
    private MachineEntry? machine;
    private Border? bubble;
    private string? accentName;
    private readonly TextBlock delivery = new() { FontSize = 14, Foreground = Muted, VerticalAlignment = VerticalAlignment.Center };
    // Mac MessageRow time line: HStack(spacing 6) { ForkSeatBadge, time and status }, padded 5 on both sides.
    private readonly Border forkBadge = ForkBadge();
    private readonly StackPanel timeLine = new() { Orientation = Orientation.Horizontal, Margin = new Thickness(5, 0, 5, 0) };
    private bool entered;
    // 「分身」: a violet capsule with the branch mark (Mac ForkSeatBadge, arrow.triangle.branch). The screen reader reads the text 「分身」.
    private static Border ForkBadge()
    {
        var violet = Frozen(Color.FromRgb(0x61, 0x47, 0xD4));
        var mark = new System.Windows.Shapes.Path { Data = Geometry.Parse("M6,13 L6,7 L1.5,1.5 M6,7 L10.5,1.5"), Stroke = violet, StrokeThickness = 1.6, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, StrokeLineJoin = PenLineJoin.Round, Width = 12, Height = 14, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 5, 0) };
        var label = new TextBlock { Text = AppStrings.MessageCard_ForkBadge_1, FontSize = 14, FontWeight = FontWeights.SemiBold, Foreground = violet, VerticalAlignment = VerticalAlignment.Center };
        System.Windows.Automation.AutomationProperties.SetName(label, AppStrings.MessageCard_ForkBadge_1);
        return new Border { Background = Frozen(Color.FromArgb(191, 0xE8, 0xE0, 0xFF)), CornerRadius = new CornerRadius(99), Padding = new Thickness(8, 2, 8, 2), Margin = new Thickness(0, 0, 6, 0), Child = new StackPanel { Orientation = Orientation.Horizontal, Children = { mark, label } } };
    }
    public MessageCard()
    {
        timeLine.Children.Add(forkBadge); timeLine.Children.Add(delivery);
        actions.Children.Add(replyButton); actions.Children.Add(forwardButton); actions.Children.Add(copyButton);
        replyButton.Click += (_, _) => Workspace.StartQuote(Message);
        forwardButton.Click += (_, _) => (Window.GetWindow(this) as MainWindow)?.ShowForwardSheet(Message);
        copyButton.Click += (_, _) => CopyText();
        Loaded += (_, _) =>
        {
            if (entered || Workspace is null || DataContext is not MessageItem item) return;
            entered = true; MessageEntrance.Play(this, Workspace.Messages.Count - 1 - Math.Max(0, Workspace.Messages.IndexOf(item)), Workspace.Opening);
        };
    }
    private static Button ActionIcon(string glyph, string tip, string name)
    {
        var button = new Button { Content = Glyph(glyph, 15, Frozen(Color.FromRgb(0x61, 0x47, 0xD4))), ToolTip = tip, Cursor = System.Windows.Input.Cursors.Hand };
        button.SetResourceReference(StyleProperty, "QuietButton"); button.Padding = new Thickness(7, 4, 7, 4); button.Margin = new Thickness(0);
        System.Windows.Automation.AutomationProperties.SetName(button, name);
        return button;
    }
    // The text the row shows (a forwarded row: its comment and the forwarded content). A clipboard another program holds is transient: the icon stays as it was, and the check mark shows only a copy that went through.
    private void CopyText()
    {
        try { Clipboard.SetDataObject(Message.MachineEvent is { } sent && (sent is { View: "words", Bubble: true } || Timeline.IsThinkingBubble(Message)) ? sent.Text : Message.Message ?? "", true); } catch (System.Runtime.InteropServices.ExternalException) { return; }
        var icon = (TextBlock)copyButton.Content; icon.Text = "";
        var timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1500) };
        timer.Tick += (_, _) => { timer.Stop(); icon.Text = ""; };
        timer.Start();
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
        if (Message is not { } original || Workspace is null) return;
        // a471-tune-answer: the last words of a finished turn (the server's bubble mark, never decided here) are an ordinary incoming bubble drawn from the row's text.
        // a471-thinking-bubble: a shown thinking row is the same bubble drawn from its whole text (slanted and lighter, copy only: the gates below read the row as sent).
        var thinking = Timeline.IsThinkingBubble(original);
        var asBubble = thinking || original.MachineEvent is { View: "words", Bubble: true };
        var message = asBubble ? original with { Message = original.MachineEvent!.Text, MachineEvent = null } : original;
        var shape = asBubble ? message.Id + (thinking ? "#thinking" : "#bubble") : message.Id; // the mark reaches the same row id later, so the card is built again
        if (messageId != shape)
        {
            messageId = shape; secret = null; question = null; machine = null;
            if (message.Kind == "peer") BuildPeer(message);
            else if (message.MachineEvent is not null) { layout = null; Content = machine = new MachineEntry(Workspace); }
            else if (message.SecretRequest is not null || message.OwnerQuestion is not null) BuildRequest(message);
            else BuildRow(message);
        }
        if (machine is not null) machine.Update(message, BotName(message.Sender?.Id, message));
        else if (layout is not null) UpdateRow(message);
        else if (secret is not null || question is not null) UpdateRequest(message);
        else if (peerLabel is not null) peerLabel.Text = AppStrings.MessageCard_Render_2(message.PeerName ?? AppStrings.MemberEditors_Build_11);
    }

    // "<name>との連絡 ›": the message itself opens in the 「メンバー間の連絡」 sheet.
    private void BuildPeer(TimelineMessage message)
    {
        layout = null;
        var label = new TextBlock { FontSize = 14, Foreground = Muted, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(8, 0, 8, 0), Text = AppStrings.MessageCard_Render_2(message.PeerName ?? AppStrings.MemberEditors_Build_11) };
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
    private string BotName(string? botId, TimelineMessage message) => Workspace.Bots.FirstOrDefault(bot => bot.Id == botId)?.Name ?? message.Sender?.Title ?? Author;

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
        quoteName = new TextBlock { FontSize = 13, FontWeight = FontWeights.Bold, Foreground = Frozen(Color.FromRgb(0x61, 0x47, 0xD4)), TextTrimming = TextTrimming.CharacterEllipsis };
        quoteText = new TextBlock { FontSize = 14, FontWeight = FontWeights.Normal, Foreground = Muted, TextWrapping = TextWrapping.Wrap, MaxHeight = 40, TextTrimming = TextTrimming.CharacterEllipsis };
        quoteNote = new TextBlock { FontSize = 13, FontWeight = FontWeights.Normal, Foreground = Muted, Margin = new Thickness(0, 3, 0, 0) };
        var quoteBox = new Border { BorderBrush = Frozen(Color.FromRgb(0x61, 0x47, 0xD4)), BorderThickness = new Thickness(3, 0, 0, 0), Background = Frozen(Color.FromArgb(40, 0x61, 0x47, 0xD4)), Padding = new Thickness(10, 6, 10, 6), Child = new StackPanel { Children = { quoteName, quoteText, quoteNote } } };
        quoteButton = new Button { Content = quoteBox, Padding = new Thickness(0), HorizontalContentAlignment = HorizontalAlignment.Stretch, Cursor = System.Windows.Input.Cursors.Hand };
        quoteButton.SetResourceReference(StyleProperty, "QuietButton"); quoteButton.Padding = new Thickness(0); quoteButton.Margin = new Thickness(0);
        quoteButton.Click += (_, _) => { if (Message.ReplyTo is { Available: true } quote) _ = Workspace.JumpToAsync(quote); };
        var menu = new ContextMenu();
        var reply = new MenuItem { Header = AppStrings.MessageCard_replyButton_1 }; reply.Click += (_, _) => Workspace.StartQuote(Message);
        // 引用して返信: only the selected part of this message's text is quoted (reply.md "Quoting a selected part"). The text is rendered markup, so no raw offset is known and none is sent.
        var part = new MenuItem { Header = AppStrings.MessageCard_BuildRow_2 };
        part.Click += (_, _) => Workspace.StartQuote(Message, new QuoteSelection(body.Selection.Text));
        menu.Items.Add(part); menu.Items.Add(reply); menu.Items.Add(new MenuItem { Header = AppStrings.MessageCard_copyButton_1, Command = System.Windows.Input.ApplicationCommands.Copy, CommandTarget = body });
        menu.Opened += (_, _) => { reply.IsEnabled = Timeline.IsQuotable(Message); part.IsEnabled = reply.IsEnabled && !body.Selection.IsEmpty && !string.IsNullOrWhiteSpace(body.Selection.Text); };
        body.ContextMenu = menu;
        var forward = new MenuItem { Header = AppStrings.ForwardView_SaveLabel_2 }; forward.Click += (_, _) => (Window.GetWindow(this) as MainWindow)?.ShowForwardSheet(Message);
        menu.Items.Insert(2, forward); menu.Opened += (_, _) => forward.IsEnabled = Timeline.IsForwardable(Message);
        originMark = new TextBlock { FontSize = 12, FontWeight = FontWeights.SemiBold, Foreground = Frozen(Color.FromRgb(0x61, 0x47, 0xD4)) };
        contentBody = new MarkdownView { FontSize = 18, Margin = new Thickness(-5, 0, -5, 0), ContextMenu = menu };
        contentBorder = new Border { BorderBrush = Muted, BorderThickness = new Thickness(3, 0, 0, 0), Padding = new Thickness(10, 2, 0, 2), Child = contentBody };
        stack = new StackPanel { Children = { quoteButton, originMark, heading, images, imagePlaceholder, body, contentBorder, replyLabel } };
        bubble = new Border { Child = stack, Padding = new Thickness(16, 12, 16, 12), CornerRadius = new CornerRadius(21), BorderThickness = new Thickness(1) };
        accentName = null;
        // The time line sits at the sender's side of the bubble, the action icons at its bottom right.
        timeLine.HorizontalAlignment = outgoing ? HorizontalAlignment.Right : HorizontalAlignment.Left; timeLine.VerticalAlignment = VerticalAlignment.Center;
        if (timeLine.Parent is Panel previousParent) previousParent.Children.Remove(timeLine);
        if (actions.Parent is Panel previousActions) previousActions.Children.Remove(actions);
        footer = new Grid(); footer.ColumnDefinitions.Add(new ColumnDefinition()); footer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(timeLine, 0); Grid.SetColumn(actions, 1); footer.Children.Add(timeLine); footer.Children.Add(actions);
        var column = new StackPanel { Children = { stackName, stackImages, bubble, footer } };
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

    // The jump target is pulsed so the eye finds it, and the quoted part is painted for a moment when it can be found in the shown text.
    public void Flash(ReplyReference? quote = null)
    {
        BeginAnimation(OpacityProperty, new System.Windows.Media.Animation.DoubleAnimation(0.6, 1, TimeSpan.FromMilliseconds(900)));
        if (quote is not { Available: true, Part: true } || body is null) return;
        // shortcut: the part is found by its first and last line inside single text runs of the rendered text (reply.md: the raw range cannot be mapped); a part that crosses markup is not highlighted, the jump still works.
        var lines = quote.Text.Split('\n').Select(line => line.Trim()).Where(line => line.Length != 0).ToArray();
        if (lines.Length == 0 || Find(body.Document.ContentStart, lines[0]) is not { } first || (lines.Length == 1 ? first : Find(first.End, lines[^1])) is not { } last) return;
        new System.Windows.Documents.TextRange(first.Start, last.End).ApplyPropertyValue(System.Windows.Documents.TextElement.BackgroundProperty, Frozen(Color.FromArgb(150, 0xB9, 0xA6, 0xFF)));
        // Back to the plain rendering after a moment: building the document again also restores any code-span backgrounds the paint covered.
        var timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
        timer.Tick += (_, _) => { timer.Stop(); var source = body.Source; body.Source = ""; body.Source = source; };
        timer.Start();
    }
    private static System.Windows.Documents.TextRange? Find(System.Windows.Documents.TextPointer from, string needle)
    {
        for (var at = from; at is not null; at = at.GetNextContextPosition(System.Windows.Documents.LogicalDirection.Forward))
        {
            if (at.GetPointerContext(System.Windows.Documents.LogicalDirection.Forward) != System.Windows.Documents.TextPointerContext.Text) continue;
            var index = at.GetTextInRun(System.Windows.Documents.LogicalDirection.Forward).IndexOf(needle, StringComparison.Ordinal);
            if (index >= 0) return new System.Windows.Documents.TextRange(at.GetPositionAtOffset(index)!, at.GetPositionAtOffset(index + needle.Length)!);
        }
        return null;
    }

    private void UpdateRow(TimelineMessage message)
    {
        var outgoing = message.IsOutgoing; var urls = message.DisplayedImageUrls; var isRoom = Workspace.IsRoom;
        var senderName = message.Kind == "peer" ? message.PeerName : isRoom && !outgoing ? message.Sender?.Title : null;
        var hasStack = urls.Length > 1;
        var text = message.Message ?? "";
        var reply = Timeline.ReplyLabel(message, isRoom, Workspace.MemberName);
        var quote = message.ReplyTo;
        var hasBubble = !hasStack || text.Length != 0 || reply is not null || quote is not null;
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
        imageLabel!.Text = count > 1 ? AppStrings.MessageCard_UpdateRow_1(count) : AppStrings.MemberEditors_Build_12;
        imagePlaceholder!.Visibility = message.Image == true && urls.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        // A forwarded or shared row: the Owner's comment in the bubble's own text, the content as a quoted block (forward.md "History").
        var origin = message.Origin is { Kind.Length: > 0 } known ? known : null;
        var (comment, content) = origin is null ? (text, "") : Timeline.OriginParts(message);
        try { body!.Source = comment; contentBody!.Source = content; }
        catch (NotSupportedException error) { body!.Document = new System.Windows.Documents.FlowDocument(new System.Windows.Documents.Paragraph(new System.Windows.Documents.Run(error.Message))); }
        if (Timeline.IsThinkingBubble(Message)) { body!.Document.FontStyle = FontStyles.Italic; body.Document.Foreground = Muted; } // every Source change builds a new document, so the style is set after it
        body!.Visibility = comment.Length != 0 ? Visibility.Visible : Visibility.Collapsed;
        contentBorder!.Visibility = content.Length != 0 ? Visibility.Visible : Visibility.Collapsed;
        originMark!.Text = origin is null ? "" : string.Join(" · ", new[] { Timeline.OriginMark(origin), origin.IsForward ? origin.FromName : null, origin.IsForward && origin.At is { } at ? Timeline.ShortTime(at, DateTimeOffset.Now) : null }.Where(part => !string.IsNullOrEmpty(part)));
        originMark.Visibility = originMark.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        replyLabel!.Text = reply ?? ""; replyLabel.Visibility = reply is null ? Visibility.Collapsed : Visibility.Visible;
        quoteButton!.Visibility = quote is null ? Visibility.Collapsed : Visibility.Visible;
        if (quote is not null)
        {
            // An unavailable original draws only the fixed line and is not tappable (reply.md "Original not available").
            quoteName!.Text = quote.Available ? quote.SenderName ?? "" : ""; quoteName.Visibility = quoteName.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
            quoteText!.Text = Timeline.QuoteBody(quote);
            quoteNote!.Text = Timeline.QuoteNote(quote) ?? ""; quoteNote.Visibility = quoteNote.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
            quoteButton.IsHitTestVisible = quoteButton.Focusable = quote.Available;
            System.Windows.Automation.AutomationProperties.SetName(quoteButton, quote.Available ? AppStrings.MessageCard_UpdateRow_3(quoteName.Text, quoteText.Text) : quoteNote.Text.Length == 0 ? Timeline.UnavailableQuote : AppStrings.MessageCard_UpdateRow_4(quoteText.Text, Timeline.UnavailableQuote));
        }
        // The gate reads the row as sent (a marked answer is drawn from a copy without its machine_event).
        replyButton.Visibility = Timeline.IsQuotable(Message) ? Visibility.Visible : Visibility.Collapsed;
        forwardButton.Visibility = Timeline.IsForwardable(Message) ? Visibility.Visible : Visibility.Collapsed;
        copyButton.Visibility = string.IsNullOrEmpty(message.Message) ? Visibility.Collapsed : Visibility.Visible;
        // VStack(spacing: 8): space only between the parts that are showing.
        var first = true;
        foreach (UIElement part in stack!.Children) { if (part.Visibility == Visibility.Collapsed) continue; ((FrameworkElement)part).Margin = new Thickness(part == body ? -5 : 0, first ? 0 : 8, part == body ? -5 : 0, 0); first = false; } // the rich text box insets its text by 5
        var state = Timeline.DeliveryLabel(message, isRoom);
        delivery.Text = string.Join(" · ", new[] { Timeline.ShortTime(message.At, DateTimeOffset.Now), state }.Where(part => part.Length != 0));
        delivery.Foreground = state == "配達失敗" ? Failed : Muted;
        delivery.Visibility = delivery.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        // Only a member's own conversation labels fork rows (a room's rows carry no seat).
        var fork = !isRoom && message.IsFork;
        forkBadge.Visibility = fork ? Visibility.Visible : Visibility.Collapsed;
        timeLine.Visibility = delivery.Text.Length == 0 && !fork ? Visibility.Collapsed : Visibility.Visible;
        var anyAction = actions.Children.Cast<UIElement>().Any(button => button.Visibility == Visibility.Visible);
        actions.Visibility = anyAction ? Visibility.Visible : Visibility.Collapsed;
        footer!.Visibility = timeLine.Visibility == Visibility.Visible || anyAction ? Visibility.Visible : Visibility.Collapsed;
        timeLine.Margin = new Thickness(5, 0, 5, 0); footer.Margin = new Thickness(0, hasBubble ? 3 : 0, 0, 0);
    }
}
