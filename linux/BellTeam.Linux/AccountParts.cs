using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Linux;

// The handoff QR block of the account card (app-sessions.md 7f, Anis's sentences): Android and Linux draw the same one.
public static class AccountParts
{
    public static Control HandoffBlock(string qrPayload, string shortCode, string checkNumber, Action cancel)
    {
        var block = new StackPanel { Margin = new Thickness(0, 14, 0, 0), Spacing = 6 };
        block.Children.Add(Text(StoreAccountText.HandoffTitle, 16, Ink, FontWeight.Bold));
        block.Children.Add(Text(StoreAccountText.HandoffLead, 13, Muted));
        block.Children.Add(new QrView(qrPayload, 220) { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 6) });
        var pair = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*") };
        var code = Pair(StoreAccountText.HandoffCode, shortCode); var check = Pair(StoreAccountText.HandoffCheckNumber, checkNumber); Grid.SetColumn(check, 1);
        pair.Children.Add(code); pair.Children.Add(check); block.Children.Add(pair);
        block.Children.Add(Text(StoreAccountText.HandoffCheckLine, 12, Muted));
        var waiting = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 4, 0, 0) };
        waiting.Children.Add(Glyph(SettingsIcons.Waiting, 16, Muted)); var wt = Text(StoreAccountText.HandoffWaiting, 13, Muted); wt.VerticalAlignment = VerticalAlignment.Center; waiting.Children.Add(wt);
        block.Children.Add(waiting);
        var stop = Capsule(StoreAccountText.HandoffCancel, Fill, Ink, 12, 14, new Thickness(16, 10));
        stop.HorizontalAlignment = HorizontalAlignment.Left; stop.Margin = new Thickness(0, 12, 0, 0); stop.Click += (_, _) => cancel();
        block.Children.Add(stop);
        return new Border { Child = block, Background = SettingsUi.Canvas, CornerRadius = new CornerRadius(16), Padding = new Thickness(16), Margin = new Thickness(0, 12, 0, 0) };
    }

    private static Control Pair(string label, string value)
    {
        var p = new StackPanel { Spacing = 2 };
        p.Children.Add(Text(label, 12, Muted)); p.Children.Add(Text(value, 20, Ink, FontWeight.Bold)); return p;
    }
}
