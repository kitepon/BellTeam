using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.LatticeLook;

namespace BellTeam.Linux;

// This device joins the Owner's Approval Box as a CHILD (child-join.md; Owner 2026-11-24): the one screen, the same on every client. Not joined, it is the first thing the 決裁箱 window shows (the first-screen approval view is the model):
// the sign-in (the same words and buttons as the first screen) and, after it, the QR his iPhone reads. Once joined the window is the normal 決裁箱 and its connection block carries 「決裁箱につながっています」 with 「つなぎを外す」.
// A child is never a parent: no 「ほかの端末を追加する」, no purchase, no plan.
internal sealed partial class ApprovalsWindow
{
    private bool leaving;   // 「つなぎを外す」 asked once: 外す / やめる
    private string? lastProvider;   // the button last pressed: 「もう一度つなぐ」 asks the same sign-in again (requestJoin always takes a provider)

    private void Request(string provider) { lastProvider = provider; Device?.RequestJoin(provider); }

    private ChildJoinState? Join => Device?.Join;
    /// <summary>The not-joined screen (and the waiting one) takes the whole window.</summary>
    private bool JoinScreenOpen => Join is { Phase: not JoinPhase.Joined };

    private Control JoinScreen(ChildJoinState join)
    {
        var column = new StackPanel { Spacing = 10 };
        if (join.Phase == JoinPhase.Waiting && join.QrLink is { Length: > 0 } link)
        {
            column.Children.Add(Text(ChildJoinText.WaitingTitle, 18, Ink, FontWeight.Bold));
            var code = new QrView(link, 280) { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 0) }; Avalonia.Automation.AutomationProperties.SetName(code, ChildJoinText.QrLabel);
            column.Children.Add(code);
            var valid = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Spacing = 8 };
            valid.Children.Add(Spinner(14)); if (join.ExpiresAt is { } until) valid.Children.Add(Text(LocalFormText.ValidUntil(until), 13, Muted));
            column.Children.Add(valid);
            column.Children.Add(Text(LocalFormText.Qr, 14, Ink, wrap: true));
            column.Children.Add(Wide(Action(ChildJoinText.LeaveNo, null), () => Device?.CancelJoin()));
        }
        else
        {
            column.Children.Add(new Border { Child = Icon(Globe, 26, Violet), HorizontalAlignment = HorizontalAlignment.Center });
            column.Children.Add(Text(ChildJoinText.Title, 18, Ink, FontWeight.Bold));
            column.Children.Add(Text(ChildJoinText.Lead, 14.5, Ink, wrap: true));
            if (join.Removed) column.Children.Add(Text(ChildJoinText.Removed, 14, Ink, FontWeight.SemiBold, wrap: true));
            if (join.Phase == JoinPhase.Failed) column.Children.Add(Text(ChildJoinText.FailedLine(join.Code), 14, Red, FontWeight.SemiBold, wrap: true));
            if (join.Phase == JoinPhase.SigningIn)
            {
                column.Children.Add(Text(SignInText.Waiting, 14, Muted, wrap: true));
                column.Children.Add(Wide(Action(SignInText.Cancel, null), () => Device?.CancelJoin()));
            }
            else if (join.Phase == JoinPhase.Failed && lastProvider is { } again) column.Children.Add(Wide(Action(ChildJoinText.ConnectAgain, null, true), () => Request(again)));
            else
            {
                column.Children.Add(Text(LocalFormText.FirstSignInChildOnly, 13, Muted, wrap: true));
                // Apple's rule: its button is black and the first, and the only black one.
                var apple = Wide(Action(SignInText.Apple, null, true), () => Request("apple")); apple.Background = Brushes.Black; apple.Foreground = Brushes.White;
                column.Children.Add(apple); column.Children.Add(Wide(Action(SignInText.Google, null), () => Request("google")));
            }
        }
        var card = Glass(column, 22, new Thickness(26, 24)); card.MaxWidth = 520; card.HorizontalAlignment = HorizontalAlignment.Center; card.VerticalAlignment = VerticalAlignment.Center;
        return card;
    }

    private static Button Wide(Button button, System.Action click) { button.HorizontalAlignment = HorizontalAlignment.Stretch; button.HorizontalContentAlignment = HorizontalAlignment.Center; button.Click += (_, _) => click(); return button; }

    // The block line of a joined device, above 「AIの許可待ちを決裁箱へ送る」: the state and the one action (two steps: 外す / やめる; the host's own BellTeam login is untouched).
    internal Control? JoinedBlock()
    {
        if (Join is not { Phase: JoinPhase.Joined }) return null;
        var block = new StackPanel { Spacing = 10, Margin = new Thickness(0, 18, 0, 0) };
        block.Children.Add(new Border { Height = 1, Background = Brush(Muted, 0x44) });
        block.Children.Add(Text(ChildJoinText.Joined, 14.5, Ink, FontWeight.SemiBold, wrap: true));
        var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Spacing = 8 };
        if (!leaving) { var leave = Action(ChildJoinText.Leave, null); leave.Click += (_, _) => { leaving = true; Render(); }; row.Children.Add(leave); }
        else
        {
            var yes = Action(ChildJoinText.LeaveYes, null, true); yes.Click += async (_, _) => { leaving = false; if (Device is { } device) await device.LeaveAsync(); if (!life.IsCancellationRequested) Render(); };
            var no = Action(ChildJoinText.LeaveNo, null); no.Click += (_, _) => { leaving = false; Render(); };
            row.Children.Add(yes); row.Children.Add(no);
        }
        block.Children.Add(row);
        return block;
    }
}
