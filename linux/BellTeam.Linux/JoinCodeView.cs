using Avalonia;
using Avalonia.Controls;
using Avalonia.Input.Platform;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Linux;

// login-billing 1.60: the join code (a link to the parent app that carries the QR's fields) beside the QR, to see and copy. It holds an identity token, so the person pastes it; nothing here edits it. Null when the library gave none.
internal static class JoinCodeView
{
    /// <summary>A phone sets this at start (null on a PC): opens a link on this phone, so a code can be opened in the parent app that is on the same phone (login-billing 1.60, "on a phone also open").</summary>
    public static Action<string>? OpenOnThisPhone { get; set; }

    public static Control? Create(string? code, string hint, string? openLabel = null)
    {
        if (code is not { Length: > 0 }) return null;
        var column = new StackPanel { Spacing = 6, Margin = new Thickness(0, 8, 0, 0) };
        column.Children.Add(Text(LocalFormText.CodeLabel, 12, Muted));
        var text = new SelectableTextBlock { Text = code, FontSize = 12, FontFamily = new FontFamily("monospace"), Foreground = Ink, TextWrapping = TextWrapping.Wrap, MaxLines = 3, TextTrimming = TextTrimming.CharacterEllipsis };
        Avalonia.Automation.AutomationProperties.SetName(text, LocalFormText.CodeLabel);
        column.Children.Add(text);
        if (openLabel is not null && OpenOnThisPhone is { } open)
        {
            var go = Capsule(openLabel, BellTheme.ProminentFill, Brushes.White, 12, 14, new Thickness(16, 10)); go.HorizontalAlignment = HorizontalAlignment.Left; go.FontWeight = FontWeight.SemiBold;
            go.Click += (_, _) => open(code);
            column.Children.Add(go);
        }
        var copy = Capsule(LocalFormText.CodeCopy, Fill, Ink, 12, 14, new Thickness(16, 10)); copy.HorizontalAlignment = HorizontalAlignment.Left;
        copy.Click += async (_, _) => { if (TopLevel.GetTopLevel(copy)?.Clipboard is { } board) { await board.SetTextAsync(code); copy.Content = LocalFormText.CodeCopied; } };
        column.Children.Add(copy);
        column.Children.Add(Text(hint, 12.5, Muted, null, new Thickness(0, 2, 0, 0)));
        return column;
    }
}
