using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Shapes;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.LatticeLook;

namespace BellTeam.Linux;

// 「AIの許可待ちを決裁箱へ送る」 (seat-approval-card.md, "The pairing view"): under the 連携 panel of the 決裁箱 window, the same on every client. Drawn only from the body's three routes
// (GET /api/approvals/seat-link, POST …/start, POST …/stop); the QR is drawn from qrText, never from anything this client reads elsewhere. A body without the routes reads as unavailable (the plain line and one button).
internal sealed partial class ApprovalsWindow
{
    private SeatLink? seatLink;
    private CancellationTokenSource? seatLoop;

    // One call (read, start or stop); while it waits for the Owner's scan the read repeats every 3 s, only while the panel is open (a state leaves by the Owner's tap, the run ending or the 5-minute bound).
    private Task ReadSeatLinkAsync() => SeatLinkCallAsync((api, token) => api.SeatLinkAsync(token));

    private async Task SeatLinkCallAsync(Func<BellApi, CancellationToken, Task<SeatLink>> call)
    {
        seatLoop?.Cancel(); var loop = seatLoop = CancellationTokenSource.CreateLinkedTokenSource(life.Token);
        try
        {
            var reply = await call(workspace.Management.Api, loop.Token);
            seatLink = reply.Absent ? null : reply; Render();   // a body without the routes (404): the section is not drawn
            if (reply.Waiting) _ = PollSeatLinkAsync(loop.Token);
        }
        catch (OperationCanceledException) { }
    }

    private async Task PollSeatLinkAsync(CancellationToken token)
    {
        try { while (seatLink?.State == "waiting" && linkOpen) { await Task.Delay(3000, token); seatLink = await workspace.Management.Api.SeatLinkAsync(token); Render(); } }
        catch (OperationCanceledException) { }
    }

    // The state's chip above the sentence, styled like the 「ライブ」 chip: green linked, red failed (and unavailable), gray removed; none and waiting are neutral and have none.
    private static Control? Badge(SeatLink link)
    {
        if (SeatLinkText.Badge(link) is not var (label, tone)) return null;
        var color = tone switch { "ok" => Done, "err" => Red, _ => Muted };
        var chip = Pill(Row(new Ellipse { Width = 7, Height = 7, Fill = Brush(color) }, Spaced(Text(label, 12.5, color, FontWeight.SemiBold), 6)), color, 0x1F, new Thickness(11, 6, 13, 6));
        chip.HorizontalAlignment = HorizontalAlignment.Left; return chip;
    }

    internal Control? SeatLinkSection()
    {
        if (seatLink is not { } link) return null;
        var section = new StackPanel { Spacing = 10, Margin = new Thickness(0, 18, 0, 0) };
        section.Children.Add(new Border { Height = 1, Background = Brush(Muted, 0x44) });
        section.Children.Add(Text(SeatLinkText.Title, 16, Ink, FontWeight.Bold));
        if (Badge(link) is { } badge) section.Children.Add(badge);
        section.Children.Add(Text(SeatLinkText.Line(link), 14.5, SeatLinkText.IsFailure(link) ? Red : Ink, wrap: true));
        if (link is { Waiting: true, QrText: { } qr })
        {
            var code = new QrView(qr, 200) { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 0) }; Avalonia.Automation.AutomationProperties.SetName(code, "決裁箱につなぐQRコード");
            section.Children.Add(code);
            if (link.TypedSecret is { Length: > 0 } typed) { var text = Text(typed, 18, Ink, FontWeight.Bold, wrap: true); text.FontFamily = new FontFamily("monospace"); text.HorizontalAlignment = HorizontalAlignment.Center; section.Children.Add(text); }
            if (link.ExpiresAt is { } expiry) { var left = Text(SeatLinkText.Until(expiry), 12, Muted); left.HorizontalAlignment = HorizontalAlignment.Center; section.Children.Add(left); }
        }
        if (SeatLinkText.Action(link) is { } label)
        {
            var button = Action(label, null, link.State != "waiting"); button.HorizontalAlignment = HorizontalAlignment.Center; button.Margin = new Thickness(0, 6, 0, 0);
            button.Click += (_, _) => _ = SeatLinkCallAsync(link.State == "waiting" ? (api, token) => api.StopSeatLinkAsync(token) : (api, token) => api.StartSeatLinkAsync(token));
            section.Children.Add(button);
        }
        return section;
    }
}
