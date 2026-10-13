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
    private static void Changed(DependencyObject sender, DependencyPropertyChangedEventArgs args) => ((MessageCard)sender).Render();
    private void Render()
    {
        if (Message is not { } message) return;
        var stack = new StackPanel();
        stack.Children.Add(new TextBlock { Text = $"{(message.IsOutgoing ? "あなた" : message.Sender?.Title ?? Author)}  {message.At.ToLocalTime():M/d HH:mm}", FontSize = 14, Foreground = Brushes.Gray, Margin = new Thickness(0, 0, 0, 6) });
        try { stack.Children.Add(new MarkdownView { FontSize = 18, Source = message.Message ?? "" }); }
        catch (NotSupportedException error) { stack.Children.Add(new TextBlock { Text = error.Message, Foreground = Brushes.Firebrick, TextWrapping = TextWrapping.Wrap }); }
        if (message.Image == true) stack.Children.Add(new TextBlock { Text = $"画像{message.ImageCount ?? 1}枚（画像の表示は次の段階で対応）", FontSize = 14, Foreground = Brushes.Gray });
        if (message.Delivery is { } status) stack.Children.Add(new TextBlock { Text = status switch { "failed" => "送信できませんでした", "queued" => "送信待ち", "running" => "処理中", _ => "" }, Foreground = status == "failed" ? Brushes.Firebrick : Brushes.Gray, FontSize = 12 });
        var card = new Border { Child = stack, Padding = new Thickness(14), CornerRadius = new CornerRadius(12), Background = new SolidColorBrush(message.IsOutgoing ? Color.FromRgb(233, 225, 245) : Colors.White), Margin = message.IsOutgoing ? new Thickness(35, 0, 0, 0) : new Thickness(0, 0, 20, 0) };
        Content = message.Kind == "peer" ? new Expander { Header = $"{message.PeerName ?? "メンバー"}との連絡", Content = card } : card;
    }
}
