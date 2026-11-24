using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;

namespace BellTeam.Linux;

// First run of an official app (app-sessions.md 7e, Tronie's ruling; the same order as Android): sign in, be handed a contract, and only then connect a server. The screen is the account card with one way on.
internal sealed class LinuxAccountGate : StartupBackdrop, IDisposable
{
    private readonly CancellationTokenSource life = new();
    public LinuxAccountCard Card { get; }

    public LinuxAccountGate(Action onContinue, string? previewQr = null)
    {
        Card = new LinuxAccountCard(life.Token, firstScreen: true, previewQr);
        var next = MacUi.Prominent(StoreAccountText.GateNext, onContinue); next.HorizontalAlignment = HorizontalAlignment.Center; next.Margin = new Thickness(0, 18, 0, 0); next.IsVisible = Card.Entitled;
        Card.EntitledChanged += () => next.IsVisible = Card.Entitled;
        var column = new StackPanel { Children = { Card, next } };
        Children.Add(Scroll(column, 520, new Thickness(30, 40)));
    }

    public void Dispose() { life.Cancel(); life.Dispose(); }
}
