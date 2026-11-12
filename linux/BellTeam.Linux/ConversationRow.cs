using Avalonia.Automation;
using Avalonia;
using Avalonia.Animation;
using Avalonia.Animation.Easings;
using Avalonia.Controls;
using Avalonia.Controls.Documents;
using Avalonia.Controls.Shapes;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Styling;
using BellTeam.Core;

namespace BellTeam.Linux;

// One member or room row of the sidebar (Mac SidebarRow): avatar with the presence dot, name and fast badge, the summary and the red seat-launch line.
public sealed class ConversationRow : Button
{
    private readonly AvatarTile avatar = new() { Width = 57.6, Height = 57.6 };
    private readonly Ellipse presence = new() { Width = 9, Height = 9, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Bottom, Stroke = Brushes.White, StrokeThickness = 2 };
    private readonly Run name = new() { FontSize = 16, FontWeight = FontWeight.SemiBold };
    private readonly Run badge = new() { FontSize = 11, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Violet };
    private readonly TextBlock summary = new() { Foreground = BellTheme.Muted, FontSize = 11, LineHeight = 15, Margin = new Thickness(0, 3, 0, 0), TextWrapping = TextWrapping.Wrap, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly TextBlock seatLaunch = new() { Foreground = BellTheme.Red, FontSize = 11, LineHeight = 15, MaxLines = 2, Margin = new Thickness(0, 3, 0, 0), TextWrapping = TextWrapping.Wrap, TextTrimming = TextTrimming.CharacterEllipsis };
    private CancellationTokenSource? pulse;
    public ConversationEntry Entry { get; private set; }

    public ConversationRow(LinuxWorkspace workspace, ConversationEntry entry, Action<ConversationEntry> select)
    {
        Entry = entry; avatar.Workspace = workspace;
        Classes.Add("plain"); Classes.Add("row"); Background = Brushes.Transparent; Foreground = BellTheme.Ink; FontWeight = FontWeight.Normal; FontSize = 16;
        var texts = new StackPanel { Margin = new Thickness(8, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        var title = new TextBlock { TextTrimming = TextTrimming.CharacterEllipsis, };
        title.Inlines!.Add(name); title.Inlines.Add(badge);
        texts.Children.Add(title); texts.Children.Add(summary); texts.Children.Add(seatLaunch);
        var tile = new Grid { Width = 57.6, Height = 57.6, VerticalAlignment = VerticalAlignment.Center, Children = { avatar, presence } };
        var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("57.6,*"), Children = { tile, texts } };
        Grid.SetColumn(texts, 1); Content = grid;
        Click += (_, _) => select(Entry);
        Update(entry);
    }

    public void Update(ConversationEntry entry)
    {
        var working = entry.Working;
        Entry = entry;
        if (avatar.Entry?.AvatarUrl != entry.AvatarUrl || avatar.Entry?.Name != entry.Name || avatar.Entry?.Bot?.Color != entry.Bot?.Color || avatar.Entry?.Bot?.Avatar != entry.Bot?.Avatar) avatar.Entry = entry;
        name.Text = entry.Name; badge.Text = entry.FastModeBadge;
        summary.Text = entry.PreviewText; summary.MaxLines = entry.IsMember ? 2 : 1;
        seatLaunch.Text = entry.SeatLaunchLine; seatLaunch.IsVisible = entry.SeatLaunchLine is not null;
        presence.IsVisible = entry.IsMember;
        presence.Fill = entry.PresenceTone switch { PresenceTone.Working => BellTheme.Red, PresenceTone.Online => BellTheme.Mint, _ => BellTheme.Line };
        AutomationProperties.SetName(presence, entry.PresenceLabel);
        // Mac BotPresenceDot: pulsing 0.8 s while the member is working.
        pulse?.Cancel(); pulse?.Dispose(); pulse = null; presence.Opacity = 1;
        if (!working) return;
        var animation = new Animation
        {
            Duration = TimeSpan.FromSeconds(.8), IterationCount = IterationCount.Infinite, PlaybackDirection = PlaybackDirection.Alternate, Easing = new SineEaseInOut(),
            Children = { new KeyFrame { Cue = new Cue(0), Setters = { new Setter(OpacityProperty, 1.0) } }, new KeyFrame { Cue = new Cue(1), Setters = { new Setter(OpacityProperty, .25) } } }
        };
        pulse = new CancellationTokenSource(); _ = animation.RunAsync(presence, pulse.Token);
    }
    public Task LoadTask => avatar.LoadTask;
    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e) { pulse?.Cancel(); base.OnDetachedFromVisualTree(e); }
    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e) { base.OnAttachedToVisualTree(e); if (Entry.Working) Update(Entry); }
    protected override Type StyleKeyOverride => typeof(Button);
}
