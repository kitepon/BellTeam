using Avalonia;
using Avalonia.Animation;
using Avalonia.Animation.Easings;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Styling;
using BellTeam.Core;

namespace BellTeam.Linux;

// The 表示 setting, loaded when the app starts.
internal static class DisplayPreference { public static ConversationOpening Current { get; set; } = ConversationOpening.Rise; }

// Message card entrance, after the Mac ConversationList: opening a conversation staggers the newest cards first
// (0.28s, 24pt rise, 0.035s apart) or fades them (0.25s); a card arriving later enters in 0.22s (16pt rise).
// Only opacity and a render transform are animated, so layout, scrolling and older-page restoration are unaffected.
internal static class MessageEntrance
{
    public static bool Enabled { get; set; } = true;
    private const int StaggeredCards = 12;
    public static void Play(Control card, int orderFromBottom, bool opening)
    {
        if (!Enabled) return;
        var rise = DisplayPreference.Current == ConversationOpening.Rise;
        if (opening && orderFromBottom >= StaggeredCards) return; // cards above the first screenful appear at once
        if (!opening && orderFromBottom >= 4) return; // an older page loaded above the viewport
        var delay = opening && rise ? TimeSpan.FromSeconds(0.035 * orderFromBottom) : TimeSpan.Zero;
        var duration = TimeSpan.FromSeconds(opening ? rise ? 0.28 : 0.25 : 0.22);
        var distance = rise ? opening ? 24 : 16 : 0;
        _ = RunAsync(card, delay, duration, distance);
    }
    private static async Task RunAsync(Control card, TimeSpan delay, TimeSpan duration, double distance)
    {
        card.Opacity = 0;
        Animation Make(AvaloniaProperty property, double from, double to) => new()
        {
            Duration = duration, Delay = delay, FillMode = FillMode.Backward, Easing = new CubicEaseOut(),
            Children = { new KeyFrame { Cue = new Cue(0), Setters = { new Setter(property, from) } }, new KeyFrame { Cue = new Cue(1), Setters = { new Setter(property, to) } } }
        };
        var tasks = new List<Task> { Make(Visual.OpacityProperty, 0, 1).RunAsync(card) };
        if (distance != 0) tasks.Add(Make(TranslateTransform.YProperty, distance, 0).RunAsync(card));
        try { await Task.WhenAll(tasks); }
        finally { card.Opacity = 1; if (distance != 0) card.RenderTransform = null; }
    }
}
