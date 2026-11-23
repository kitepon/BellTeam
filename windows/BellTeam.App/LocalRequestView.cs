using System.Windows;
using System.Windows.Controls;
using BellTeam.Core;
using static BellTeam.App.SettingsUi;

namespace BellTeam.App;

// a540: the screen of the local form (contract 1.36 s10). The device that wants in shows the request's QR (QrView draws the text exactly as the library gives it) and waits for the paying phone's reply over the same Wi-Fi;
// then it says what came back. It only draws and reports the person's choice: makeRequest, the listener and accept run in the library's desktop part.
internal sealed class LocalRequestView : StackPanel
{
    private readonly Action newQr, cancel;
    public LocalRequestView(Action newQr, Action cancel) { this.newQr = newQr; this.cancel = cancel; }

    // The request is on screen and the listener waits.
    public void ShowRequest(string qrPayload)
    {
        Children.Clear();
        Children.Add(Text(LocalFormText.Title, 16, Ink, FontWeights.Bold));
        Children.Add(Text(LocalFormText.Lead, 13, Muted, null, new Thickness(0, 6, 0, 0)));
        Children.Add(new QrView(qrPayload, 220) { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 10, 0, 10) });
        Children.Add(Text(LocalFormText.Window, 12, Muted));
        Children.Add(Text(LocalFormText.Firewall, 12, Muted, null, new Thickness(0, 4, 0, 0)));
        Children.Add(Text(LocalFormText.Waiting, 13, Muted, null, new Thickness(0, 8, 0, 0)));
        Children.Add(Button(LocalFormText.Cancel, cancel));
    }

    // Paid: the end of the period (the person keeps using the app). Every other outcome ends the try: its sentence and a new QR.
    public void ShowOutcome(LocalFormOutcome outcome, DateTimeOffset? paidUntil = null)
    {
        Children.Clear();
        Children.Add(Text(LocalFormText.Title, 16, Ink, FontWeights.Bold));
        var paid = outcome == LocalFormOutcome.Paid;
        Children.Add(Text(paid ? LocalFormText.Paid(paidUntil ?? throw new ArgumentNullException(nameof(paidUntil))) : LocalFormText.Of(outcome), 14, paid ? Ink : Red, null, new Thickness(0, 10, 0, 0)));
        if (!paid) Children.Add(Button(LocalFormText.NewQr, newQr));
    }

    // A try that ended with one of the library's codes, in the words of LocalFormText.Failure: its sentence and a new QR.
    public void ShowSentence(string sentence)
    {
        Children.Clear();
        Children.Add(Text(LocalFormText.Title, 16, Ink, FontWeights.Bold));
        Children.Add(Text(sentence, 14, Red, null, new Thickness(0, 10, 0, 0)));
        Children.Add(Button(LocalFormText.NewQr, newQr));
    }

    // The accepted period ended on this device's clock: the next step is a new QR.
    public void ShowPeriodEnded()
    {
        Children.Clear();
        Children.Add(Text(LocalFormText.Title, 16, Ink, FontWeights.Bold));
        Children.Add(Text(LocalFormText.PeriodEnded, 14, Ink, null, new Thickness(0, 10, 0, 0)));
        Children.Add(Button(LocalFormText.NewQr, newQr));
    }

    // The person stopped the wait: only the way to a new QR.
    public void ShowStopped()
    {
        Children.Clear();
        Children.Add(Text(LocalFormText.Title, 16, Ink, FontWeights.Bold));
        Children.Add(Button(LocalFormText.NewQr, newQr));
    }

    private static Button Button(string label, Action click)
    {
        var button = Capsule(label, Violet, System.Windows.Media.Brushes.White, 12, 14, new Thickness(16, 10, 16, 10));
        button.FontWeight = FontWeights.SemiBold; button.HorizontalAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 12, 0, 0);
        System.Windows.Automation.AutomationProperties.SetName(button, label);
        button.Click += (_, _) => click();
        return button;
    }
}
