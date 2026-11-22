using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using BellTeam.Core;

namespace BellTeam.App;

// The sign-in entry of login-billing (sentences: SignInText, app-sessions.md 7f). No console-code field and no paste field: an official app has one way in (Tronie, 2026-11-22).
// It only draws a phase and reports the person's choice; the sign-in itself runs in the library's desktop part. The setup-code field is shown only at the first binding of an unbound server.
internal sealed class SignInView : StartupBackdrop
{
    private readonly Action<string> signIn;
    private readonly IReadOnlyList<string> providers;
    private readonly Action cancel;
    private readonly StackPanel body = new() { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center, MaxWidth = 460, Margin = new Thickness(30) };
    private readonly TextBox setupCode = new() { FontSize = 15, Padding = new Thickness(10, 8, 10, 8), MinWidth = 280, MaxWidth = 360 };
    private bool needsSetupCode;
    // Typed once, kept while the phase changes; read by the caller when it starts the proof.
    public string SetupCode => setupCode.Text.Trim();

    // signIn gets "apple" or "google"; cancel ends the wait for the browser; providers are the buttons the device can use.
    public SignInView(Action<string> signIn, Action cancel, IReadOnlyList<string> providers, bool needsSetupCode = false)
    {
        this.signIn = signIn; this.cancel = cancel; this.providers = providers; this.needsSetupCode = needsSetupCode;
        AutomationProperties.SetName(setupCode, SignInText.SetupCodeLabel);
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
                if (phase == SignInPhase.NotOwner) body.Children.Add(Centered(MacUi.Text(SignInText.NotOwner, 14, MacUi.Red, margin: new Thickness(0, 14, 0, 0))));
                if (failure is not null) body.Children.Add(Centered(MacUi.Text(failure, 14, MacUi.Red, margin: new Thickness(0, 14, 0, 0))));
                if (needsSetupCode)
                {
                    body.Children.Add(Centered(MacUi.Text(SignInText.SetupCodeLabel, 15, MacUi.Ink, FontWeights.SemiBold, new Thickness(0, 18, 0, 6))));
                    body.Children.Add(setupCode);
                    body.Children.Add(Centered(MacUi.Text(SignInText.SetupCodeHint, 12, MacUi.Muted, margin: new Thickness(0, 6, 0, 0))));
                }
                foreach (var provider in providers) body.Children.Add(Button(MacUi.Prominent(provider == "apple" ? SignInText.Apple : SignInText.Google, () => signIn(provider))));
                body.Children.Add(Centered(MacUi.Text(SignInText.Note, 12, MacUi.Muted, margin: new Thickness(0, 14, 0, 0))));
                break;
        }
    }

    // The setup code is asked for again only until the server is bound.
    public void RequireSetupCode(bool on) { needsSetupCode = on; Show(SignInPhase.Entry); }

    private static Button Button(Button button) { button.HorizontalAlignment = HorizontalAlignment.Center; button.Margin = new Thickness(0, 14, 0, 0); return button; }
    private static FrameworkElement Centered(TextBlock text) { text.TextAlignment = TextAlignment.Center; text.TextWrapping = TextWrapping.Wrap; text.HorizontalAlignment = HorizontalAlignment.Center; return text; }
}
