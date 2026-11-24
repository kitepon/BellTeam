using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;
using static BellTeam.App.SettingsUi;

namespace BellTeam.App;

/// <summary>
/// The first screen of a device that is not yet approved (the Owner 2026-11-24: the parent-approval process on the first screen, 決裁箱 0.2.2 as the model; the same on every client).
/// Before sign-in: the app's name, one line of purpose, the Owner's first-sign-in text and the two sign-in buttons. While the browser signs in: that line and やめる. After sign-in: 「使っている端末の承認を待っています」, the QR,
/// its validity, the Owner's QR text and やめる (the Windows firewall note is the one addition). A device that is already paid never sees it (the gate shows サーバーにつなぐ). Draws from <see cref="AccountView"/>; the account runs the library.
/// </summary>
internal sealed class FirstScreenView : StackPanel
{
    private readonly AccountView account;
    public FirstScreenView(AccountView account) { this.account = account; HorizontalAlignment = HorizontalAlignment.Center; MaxWidth = 520; Margin = new Thickness(24); account.Changed += Render; Render(); }

    private void Render()
    {
        Children.Clear();
        if (account.Request is { } request) { Approval(request.Qr, request.ExpiresAt); return; }
        var hero = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 20, 0, 22) };
        // The BellTeam app icon, the same image as Apple's, with rounded corners.
        var icon = new Image { Source = EmbeddedAsset.Icon(176), Width = 88, Height = 88, Stretch = Stretch.Uniform, HorizontalAlignment = HorizontalAlignment.Center, SnapsToDevicePixels = true };
        RoundClip.Apply(icon, 20); System.Windows.Automation.AutomationProperties.SetAutomationId(icon, "first-screen-icon"); hero.Children.Add(icon);
        var name = Text(LocalFormText.AppName, 34, Ink, FontWeights.Bold, new Thickness(0, 14, 0, 0)); name.HorizontalAlignment = HorizontalAlignment.Center; hero.Children.Add(name);
        var purpose = Text(LocalFormText.Purpose, 16, Muted, null, new Thickness(0, 6, 0, 0)); purpose.HorizontalAlignment = HorizontalAlignment.Center; purpose.TextAlignment = TextAlignment.Center; hero.Children.Add(purpose);
        Children.Add(hero);
        var card = new StackPanel();
        if (account.SigningInWithBrowser)
        {
            card.Children.Add(Text(SignInText.Waiting, 15, Ink, FontWeights.SemiBold));
            card.Children.Add(Button(SignInText.Cancel, Fill, Ink, account.CancelBrowser, "first-screen-cancel"));
        }
        else
        {
            var first = Text(LocalFormText.FirstSignIn, 14, Muted); System.Windows.Automation.AutomationProperties.SetAutomationId(first, "first-screen-first-signin"); card.Children.Add(first);
            if (account.Sentence is { } sentence) card.Children.Add(Text(sentence, 13, Red, null, new Thickness(0, 10, 0, 0)));
            card.Children.Add(Button(SignInText.Apple, System.Windows.Media.Brushes.Black, System.Windows.Media.Brushes.White, () => _ = account.StartAsync("apple"), "first-screen-apple"));
            card.Children.Add(Button(SignInText.Google, System.Windows.Media.Brushes.White, Ink, () => _ = account.StartAsync("google"), "first-screen-google", bordered: true));
        }
        var holder = Card(card); holder.Padding = new Thickness(20); Children.Add(holder);
    }

    // After sign-in, the device is not approved yet: the QR a parent device reads (the library's join link), how long it is good for, the Owner's words, やめる.
    internal void ShowApproval(string qr, DateTimeOffset expiry) { Children.Clear(); Approval(qr, expiry); }   // the screen a request on the account draws (the library makes the request after a real sign-in)
    private void Approval(string qr, DateTimeOffset expiry)
    {
        var title = Text(LocalFormText.WaitingTitle, 24, Ink, FontWeights.Bold, new Thickness(0, 24, 0, 0)); title.TextAlignment = TextAlignment.Center; title.HorizontalAlignment = HorizontalAlignment.Center;
        System.Windows.Automation.AutomationProperties.SetAutomationId(title, "first-screen-waiting-title"); Children.Add(title);
        Children.Add(new QrView(qr, 280, LocalFormText.QrLabel) { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 18, 0, 12) });
        var valid = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        valid.Children.Add(new Spinner { Margin = new Thickness(0, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center });
        valid.Children.Add(Text(LocalFormText.ValidUntil(expiry), 14, Muted)); Children.Add(valid);
        var guidance = Text(LocalFormText.Qr, 15, Ink, FontWeights.SemiBold, new Thickness(0, 14, 0, 0)); System.Windows.Automation.AutomationProperties.SetAutomationId(guidance, "first-screen-qr-guidance"); Children.Add(guidance);
        Children.Add(Text(LocalFormText.Firewall, 12, Muted, null, new Thickness(0, 8, 0, 0)));
        var cancel = Button(LocalFormText.Cancel, Fill, Ink, account.CancelBrowser, "first-screen-cancel"); cancel.HorizontalAlignment = HorizontalAlignment.Center; Children.Add(cancel);
    }

    internal static Button Button(string label, Brush background, Brush foreground, Action click, string id, bool bordered = false)
    {
        var button = Capsule(label, background, foreground, 14, 15, new Thickness(18, 13, 18, 13));
        button.FontWeight = FontWeights.SemiBold; button.HorizontalAlignment = HorizontalAlignment.Stretch; button.Margin = new Thickness(0, 14, 0, 0);
        if (bordered) { button.BorderBrush = Hairline; button.BorderThickness = new Thickness(1); }
        System.Windows.Automation.AutomationProperties.SetName(button, label); System.Windows.Automation.AutomationProperties.SetAutomationId(button, id);
        button.Click += (_, _) => click();
        return button;
    }
}
