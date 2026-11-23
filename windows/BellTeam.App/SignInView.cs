using System.Windows;
using System.Windows.Controls;
using BellTeam.Core;

namespace BellTeam.App;

// The sign-in entry of login-billing (sentences: SignInText, app-sessions.md 7f). No console-code field and no paste field: an official app has one way in (Tronie, 2026-11-22).
// It only draws a phase and reports the person's choice; the sign-in itself runs in the library's desktop part.
internal sealed class SignInView : StartupBackdrop
{
    private readonly Action<string> signIn;
    private readonly IReadOnlyList<string> providers;
    private readonly Action cancel;
    private readonly StackPanel body = new() { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center, MaxWidth = 460, Margin = new Thickness(30) };

    // signIn gets "apple" or "google"; cancel ends the wait for the browser; providers are the buttons the device can use.
    public SignInView(Action<string> signIn, Action cancel, IReadOnlyList<string> providers)
    {
        this.signIn = signIn; this.cancel = cancel; this.providers = providers;
        Children.Add(body); Show(SignInPhase.Entry);
    }

    // failure: any other failure sentence, shown above the buttons.
    public void Show(SignInPhase phase, string? failure = null)
    {
        body.Children.Clear();
        body.Children.Add(Centered(MacUi.Text(SignInText.Title, 28, MacUi.Ink, FontWeights.Bold)));
        switch (phase)
        {
            case SignInPhase.Waiting:
                body.Children.Add(Centered(MacUi.Text(SignInText.Waiting, 15, MacUi.Muted, margin: new Thickness(0, 14, 0, 0))));
                body.Children.Add(Button(MacUi.Bordered(SignInText.Cancel, cancel)));
                break;
            default:
                if (phase == SignInPhase.ReturnNotReceived) body.Children.Add(Centered(MacUi.Text(SignInText.ReturnNotReceived, 14, MacUi.Red, margin: new Thickness(0, 14, 0, 0))));
                if (failure is not null) body.Children.Add(Centered(MacUi.Text(failure, 14, MacUi.Red, margin: new Thickness(0, 14, 0, 0))));
                foreach (var provider in providers) body.Children.Add(Button(MacUi.Prominent(provider == "apple" ? SignInText.Apple : SignInText.Google, () => signIn(provider))));
                body.Children.Add(Centered(MacUi.Text(SignInText.Note, 12, MacUi.Muted, margin: new Thickness(0, 14, 0, 0))));
                break;
        }
    }

    private static Button Button(Button button) { button.HorizontalAlignment = HorizontalAlignment.Center; button.Margin = new Thickness(0, 14, 0, 0); return button; }
    private static FrameworkElement Centered(TextBlock text) { text.TextAlignment = TextAlignment.Center; text.TextWrapping = TextWrapping.Wrap; text.HorizontalAlignment = HorizontalAlignment.Center; return text; }
}
