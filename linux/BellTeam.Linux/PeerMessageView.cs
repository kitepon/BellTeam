using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;

namespace BellTeam.Linux;

// Mac PeerMessageSheet: the full text of a Bot-to-bot contact, opened from its capsule in the 「メンバー間の連絡」 sheet.
public sealed class PeerMessageView : ScrollViewer
{
    public PeerMessageView(LinuxWorkspace workspace, TimelineMessage message)
    {
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto; HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled; Background = BellTheme.ConversationBackground;
        var panel = new StackPanel { Margin = new Thickness(22) };
        panel.Children.Add(new TextBlock { Text = message.PeerName ?? "メンバー", FontSize = 22, FontWeight = FontWeight.Bold, TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(new TextBlock { Text = Timeline.LongTime(message.At), FontSize = 14, Foreground = BellTheme.Muted, Margin = new Thickness(0, 15, 0, 0) });
        if (message.Message is { } text) panel.Children.Add(new MarkdownView { FontSize = 18, Source = text, Margin = new Thickness(0, 15, 0, 0) });
        if (message.DisplayedImageUrls.Length != 0)
        {
            var images = new RemoteImages(workspace) { Margin = new Thickness(0, 15, 0, 0) }; images.Update(message.DisplayedImageUrls, message.IsOutgoing);
            images.HorizontalAlignment = HorizontalAlignment.Left; panel.Children.Add(images);
        }
        Content = panel;
    }
    protected override Type StyleKeyOverride => typeof(ScrollViewer);
}
