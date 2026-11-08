using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

// Mac PeerMessageSheet: the full text of a Bot-to-bot contact, opened from its capsule in the 「メンバー間の連絡」 sheet.
public sealed class PeerMessageView : ScrollViewer
{
    public PeerMessageView(Workspace workspace, TimelineMessage message)
    {
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto; Background = Palette.Get("ConversationBackground");
        var panel = new StackPanel { Margin = new Thickness(22) };
        panel.Children.Add(new TextBlock { Text = message.PeerName ?? "メンバー", FontSize = 22, FontWeight = FontWeights.Bold, TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(new TextBlock { Text = Timeline.LongTime(message.At), FontSize = 14, Foreground = Palette.Muted, Margin = new Thickness(0, 15, 0, 0) });
        if (message.Message is { } text) panel.Children.Add(new MarkdownView { FontSize = 18, Source = text, Margin = new Thickness(-5, 15, -5, 0) });
        if (message.DisplayedImageUrls.Length != 0)
        {
            var images = new RemoteImages(workspace) { Margin = new Thickness(0, 15, 0, 0) }; images.Update(message.DisplayedImageUrls, message.IsOutgoing);
            images.HorizontalAlignment = HorizontalAlignment.Left; panel.Children.Add(images);
        }
        Content = panel;
    }
}
