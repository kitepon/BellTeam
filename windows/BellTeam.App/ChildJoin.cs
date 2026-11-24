using System.Windows;
using System.Windows.Controls;
using BellTeam.Core;
using static BellTeam.App.SettingsUi;

namespace BellTeam.App;

internal enum ChildJoinPhase { NotJoined, Waiting, Failed, Joined }

/// <summary>
/// The port of the 決裁箱 window's child join (child-join.md "The port"): the Approval Box component's joinState and its three calls, as the window needs them. The window never signs in or holds a credential itself.
/// Join(provider) is requestJoin (the library signs in first when the child form keeps none; null = again, with the provider of the last try); CancelJoin and Leave are cancelJoin and leave.
/// </summary>
internal interface IChildJoin
{
    ChildJoinPhase Phase { get; }
    /// <summary>The browser sign-in of requestJoin runs (still NotJoined).</summary>
    bool SigningIn { get; }
    /// <summary>Waiting: the library's join link (the QR) and when the offer ends.</summary>
    string? QrLink { get; }
    DateTimeOffset? ExpiresAt { get; }
    /// <summary>Failed: the library's own code; never shown, only other_account has its own sentence.</summary>
    string? FailedCode { get; }
    /// <summary>The parent removed this device while it was joined (a /v1 401): NotJoined, with the word for it.</summary>
    bool Removed { get; }
    /// <summary>Joined, but the component says this build cannot read /v1.</summary>
    bool UpdateRequired { get; }
    event Action? Changed;
    Task JoinAsync(string? provider);
    void CancelJoin();
    Task LeaveAsync();
}

/// <summary>
/// The one screen of a window that is not joined (child-join.md): the first-screen approval view's shape. NotJoined: title, lead, the first screen's sign-in (Apple, Google); signing in: its waiting line and やめる;
/// Waiting: title, the QR, 「H:mm まで有効」, the guideline's QR text word for word, やめる; Failed / removed: the sentence and もう一度つなぐ. Never a parent's 「ほかの端末を追加する」, a purchase or a plan.
/// </summary>
internal sealed class ChildJoinView : StackPanel
{
    internal ChildJoinView(IChildJoin join)
    {
        HorizontalAlignment = HorizontalAlignment.Center; MaxWidth = 520; Margin = new Thickness(24, 36, 24, 24);
        if (join is { Phase: ChildJoinPhase.Waiting, QrLink: { } link, ExpiresAt: { } until }) { Waiting(join, link, until); return; }
        var title = Text(ChildJoinText.Title, 24, Ink, FontWeights.Bold); title.HorizontalAlignment = HorizontalAlignment.Center; Children.Add(title);
        var lead = Text(ChildJoinText.Lead, 15, Muted, null, new Thickness(0, 8, 0, 18)); lead.TextAlignment = TextAlignment.Center; lead.HorizontalAlignment = HorizontalAlignment.Center; Children.Add(lead);
        var card = new StackPanel();
        if (join.Phase == ChildJoinPhase.Failed) card.Children.Add(Id(Text(ChildJoinText.FailedLine(join.FailedCode), 13, Red), "child-join-failed"));
        else if (join.Removed) card.Children.Add(Id(Text(ChildJoinText.Removed, 14, Ink, FontWeights.SemiBold), "child-join-removed"));
        if (join.SigningIn)
        {
            card.Children.Add(Text(SignInText.Waiting, 15, Ink, FontWeights.SemiBold));
            card.Children.Add(FirstScreenView.Button(ChildJoinText.LeaveNo, Fill, Ink, join.CancelJoin, "child-join-cancel"));
        }
        else if (join.Phase == ChildJoinPhase.Failed || join.Removed)
            card.Children.Add(FirstScreenView.Button(ChildJoinText.ConnectAgain, System.Windows.Media.Brushes.Black, System.Windows.Media.Brushes.White, () => _ = join.JoinAsync(null), "child-join-again"));
        else
        {
            card.Children.Add(Id(Text(LocalFormText.FirstSignIn, 14, Muted), "child-join-first-signin"));
            card.Children.Add(FirstScreenView.Button(SignInText.Apple, System.Windows.Media.Brushes.Black, System.Windows.Media.Brushes.White, () => _ = join.JoinAsync("apple"), "child-join-apple"));
            card.Children.Add(FirstScreenView.Button(SignInText.Google, System.Windows.Media.Brushes.White, Ink, () => _ = join.JoinAsync("google"), "child-join-google", bordered: true));
        }
        var holder = Card(card); holder.Padding = new Thickness(20); Children.Add(holder);
    }

    private void Waiting(IChildJoin join, string link, DateTimeOffset until)
    {
        var title = Text(ChildJoinText.WaitingTitle, 24, Ink, FontWeights.Bold); title.TextAlignment = TextAlignment.Center; title.HorizontalAlignment = HorizontalAlignment.Center; Id(title, "child-join-waiting-title"); Children.Add(title);
        Children.Add(new QrView(link, 280, ChildJoinText.QrLabel) { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 18, 0, 12) });
        var valid = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        valid.Children.Add(new Spinner { Margin = new Thickness(0, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center });
        valid.Children.Add(Id(Text(LocalFormText.ValidUntil(until), 14, Muted), "child-join-valid")); Children.Add(valid);
        var guidance = Text(LocalFormText.Qr, 15, Ink, FontWeights.SemiBold, new Thickness(0, 14, 0, 0)); Id(guidance, "child-join-qr-guidance"); Children.Add(guidance);
        var cancel = FirstScreenView.Button(ChildJoinText.LeaveNo, Fill, Ink, join.CancelJoin, "child-join-cancel"); cancel.HorizontalAlignment = HorizontalAlignment.Center; Children.Add(cancel);
    }

    private static T Id<T>(T element, string id) where T : DependencyObject { System.Windows.Automation.AutomationProperties.SetAutomationId(element, id); return element; }
}
