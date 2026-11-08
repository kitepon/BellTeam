using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Animation;
using BellTeam.Core;

namespace BellTeam.App;

// The 表示 setting, loaded when the app starts and updated when the settings page saves it.
internal static class DisplayPreference { public static ConversationOpening Current { get; set; } = ConversationOpening.Rise; }

// Message card entrance, after the Mac ConversationList: opening a conversation staggers the newest cards first
// (0.28s, 24pt rise, 0.035s apart) or fades them (0.25s); a card arriving later enters in 0.22s (16pt rise).
// Only opacity and a render transform are animated, so layout, ScrollToBottom and older-page scroll restoration are unaffected.
internal static class MessageEntrance
{
    public static bool Enabled { get; set; } = true;
    private const int StaggeredCards = 12;
    public static void Play(FrameworkElement card, int orderFromBottom, bool opening)
    {
        if (!Enabled) return;
        var rise = DisplayPreference.Current == ConversationOpening.Rise;
        if (opening && orderFromBottom >= StaggeredCards) return; // cards above the first screenful appear at once
        if (!opening && orderFromBottom >= 4) return; // an older page loaded above the viewport
        var delay = opening && rise ? TimeSpan.FromSeconds(0.035 * orderFromBottom) : TimeSpan.Zero;
        var duration = TimeSpan.FromSeconds(opening ? rise ? 0.28 : 0.25 : 0.22);
        var distance = rise ? opening ? 24 : 16 : 0;
        card.Opacity = 0;
        var fade = new DoubleAnimation(0, 1, duration) { BeginTime = delay, FillBehavior = FillBehavior.Stop, EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } };
        fade.Completed += (_, _) => card.Opacity = 1;
        card.BeginAnimation(UIElement.OpacityProperty, fade);
        if (distance == 0) return;
        var move = new TranslateTransform(0, distance); card.RenderTransform = move;
        var slide = new DoubleAnimation(distance, 0, duration) { BeginTime = delay, FillBehavior = FillBehavior.Stop, EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } };
        slide.Completed += (_, _) => card.RenderTransform = null;
        move.BeginAnimation(TranslateTransform.YProperty, slide);
    }
}
