using System.Windows;
using System.Windows.Controls;
using BellTeam.Core;
using static BellTeam.App.SettingsUi;

namespace BellTeam.App;

// a540: the section of the local form (contract 1.36 s10; words: Rapi's table, LocalFormText). The device that wants in shows the request's QR (QrView draws the text exactly as the library gives it) and waits for the paying phone's reply over the same Wi-Fi.
// It only draws and reports the person's choice: makeRequest, the listener and accept run in the library's desktop part. The one Windows addition is the firewall note (the person's one step on the first listen).
internal sealed class LocalRequestView : StackPanel
{
    private readonly Action<string> start;
    private readonly Action cancel;
    // start gets the provider of the button pressed: "apple" (the iPhone's reply carries its own Apple identity token) or "google" (this PC signs in with Google)
    public LocalRequestView(Action<string> start, Action cancel) { this.start = start; this.cancel = cancel; }

    // No try is running: the section and the two buttons that start one (Apple first, as the Mac app). sentence = what the last try ended with (red), none for a first or a stopped try.
    public void ShowIdle(string? sentence = null)
    {
        Head();
        var first = Text(LocalFormText.FirstSignInChildOnly, 13, Ink, FontWeights.SemiBold, new Thickness(0, 10, 0, 0));   // before the Apple / Google buttons, below the lead
        System.Windows.Automation.AutomationProperties.SetAutomationId(first, "local-request-first-signin"); Children.Add(first);
        Children.Add(Text(LocalFormText.Firewall, 12, Muted, null, new Thickness(0, 4, 0, 0)));
        if (sentence is not null) Children.Add(Text(sentence, 13, Red, null, new Thickness(0, 10, 0, 0)));
        var buttons = new WrapPanel();
        buttons.Children.Add(Button(LocalFormText.Apple, () => start("apple"))); buttons.Children.Add(Button(LocalFormText.Google, () => start("google")));
        Children.Add(buttons);
    }

    // The request is on screen and the listener waits until expiry.
    public void ShowRequest(string qrPayload, DateTimeOffset expiry)
    {
        Head();
        // 1.49/1.50 (the Owner's sentence, BellTeam's own text in Core): word for word beside the QR. The QR is the library's join link (longer than the bare text), so it is drawn larger.
        var qr = new QrView(qrPayload, 280, LocalFormText.QrLabel) { VerticalAlignment = VerticalAlignment.Center };
        var guidance = Text(LocalFormText.Qr, 15, Ink, FontWeights.SemiBold, new Thickness(18, 0, 0, 0)); guidance.VerticalAlignment = VerticalAlignment.Center; guidance.MaxWidth = 260;
        System.Windows.Automation.AutomationProperties.SetAutomationId(guidance, "local-request-guidance");
        Children.Add(new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 10), Children = { qr, guidance } });
        Children.Add(Text(LocalFormText.Firewall, 12, Muted));
        Children.Add(Text(LocalFormText.WaitingUntil(expiry), 13, Muted, null, new Thickness(0, 8, 0, 0)));
        Children.Add(Button(LocalFormText.Cancel, cancel));
    }

    private void Head()
    {
        Children.Clear();
        Children.Add(Text(LocalFormText.Title, 16, Ink, FontWeights.Bold));
        Children.Add(Text(LocalFormText.Lead, 13, Muted, null, new Thickness(0, 6, 0, 0)));
    }

    private static Button Button(string label, Action click)
    {
        var button = Capsule(label, Violet, System.Windows.Media.Brushes.White, 12, 14, new Thickness(16, 10, 16, 10));
        button.FontWeight = FontWeights.SemiBold; button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 12, 10, 0);
        System.Windows.Automation.AutomationProperties.SetName(button, label);
        button.Click += (_, _) => click();
        return button;
    }
}
