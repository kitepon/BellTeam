using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using Kitepon.ApprovalBox.Client;
using static BellTeam.Linux.LatticeLook;

namespace BellTeam.Linux;

// The device's states in the 決裁箱 window (design peer-channel-signin.md sections 2 and 3, a520): one note above the list for SignedOut, SigningIn, Joining, NeedsApproval, Waiting (code + QR),
// NotEntitled and Reconnecting; Live shows nothing. The words are Core's `Approvals.Device*` (the same on every platform). Every note leaves by its own action or by the next launch.
internal sealed partial class ApprovalsWindow
{
    private Control Strip(Control content)
    {
        if (DeviceStrip() is not { } strip) return content;
        var dock = new DockPanel { LastChildFill = true };
        DockPanel.SetDock(strip, Dock.Top); dock.Children.Add(strip); dock.Children.Add(content);
        return dock;
    }

    internal Control? DeviceStrip()
    {
        if (hub.Source is not { } device) return null;
        var panel = new StackPanel(); var n = 0;
        Border Frame(Control child, double vertical, string name)
        {
            var border = new Border { Child = child, CornerRadius = new CornerRadius(14), Padding = new Thickness(16, vertical, 16, vertical), Margin = new Thickness(18, 0, 18, 8), Background = Brush(Muted, 0x14), BorderBrush = Brush(Muted, 0x44), BorderThickness = new Thickness(1) };
            Avalonia.Automation.AutomationProperties.SetAutomationId(border, name); return border;
        }
        void Line(string text, string? label = null, Action? act = null)
        {
            // A grid, not a horizontal stack: on a phone the wrapped text takes the width left over and the button stays on screen.
            var row = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto"), VerticalAlignment = VerticalAlignment.Center };
            var words = Spaced(Text(text, 13, Ink, FontWeight.SemiBold, wrap: true), 10); Grid.SetColumn(words, 1);
            row.Children.Add(Icon(Globe, 16, Muted)); row.Children.Add(words);
            if (label is not null && act is not null) { var button = Action(label, null); button.Margin = new Thickness(12, 0, 0, 0); Grid.SetColumn(button, 2); button.Click += (_, _) => act(); row.Children.Add(button); }
            panel.Children.Add(Frame(row, 8, "approvals-device-note-" + n++));
        }
        void Waiting(ApprovalOffer offer)
        {
            var code = Text(offer.Code, 22, Ink, FontWeight.Bold, wrap: true); code.FontFamily = new FontFamily("monospace");   // wrapped, not trimmed: the person types all of it
            var info = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(18, 0, 0, 0), MaxWidth = 380 };
            info.Children.Add(code);
            info.Children.Add(Text(Approvals.DeviceApprovalHow, 13, Ink, FontWeight.SemiBold, wrap: true));
            info.Children.Add(Text(Approvals.DeviceApprovalLeft(offer.ExpiresAt - Now()), 12, Muted));
            var stop = Action("やめる", null); stop.HorizontalAlignment = HorizontalAlignment.Left; stop.Margin = new Thickness(0, 10, 0, 0); stop.Click += (_, _) => hub.CancelApproval?.Invoke(); info.Children.Add(stop);
            var qr = new QrView(offer.QrPayload, 150); Grid.SetColumn(info, 1);
            panel.Children.Add(Frame(new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*"), Children = { qr, info } }, 16, "approvals-device-waiting"));
        }
        var state = device.State;
        switch (state.Status)
        {
            case ClientStatus.Joining: Line(Approvals.DeviceJoining); break;
            case ClientStatus.Reconnecting: Line(Approvals.DeviceReconnecting, "今すぐ試す", device.Refresh); break;   // the reason is a short word, never shown to the person (Delta)
            case ClientStatus.Waiting when state.Offer is { } offer: Waiting(offer); break;
            case ClientStatus.NeedsApproval:
                var ended = state.Note switch { "offer_expired" => Approvals.DeviceApprovalExpired, "offer_failed" => Approvals.DeviceApprovalFailed, _ => null };
                if (ended is not null) Line(ended);
                Line(state.Note == "device_removed" ? Approvals.DeviceRemoved : Approvals.DeviceNeedsApproval, hub.RequestApproval is null ? null : ended is null ? Approvals.DeviceAskApproval : "もう一度", () => hub.RequestApproval?.Invoke());
                break;
            case ClientStatus.SignedOut: break;   // not joined (or the credential is gone): the join screen (child-join.md) takes the window, there is no sign-in here any more
            case ClientStatus.NotEntitled: Line(Approvals.DeviceNotEntitled, "確かめ直す", device.Refresh); break;
            case ClientStatus.UpdateRequired: Line(Approvals.DeviceUpdateNeeded, "今すぐ試す", device.Refresh); break;   // /v1 is closed, or peer_channel is on and this build has no engine for it
        }
        return panel.Children.Count == 0 ? null : panel;
    }
}
