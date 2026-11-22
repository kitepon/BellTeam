using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using BellTeam.Linux;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Android;

// First run of an official app (app-sessions.md 7e, Tronie's ruling): sign in, buy or be handed a contract, and only then connect a server. This screen is the account card with one way on.
public sealed class AccountGate : ScrollViewer
{
    public AccountGate(Action onContinue, CancellationToken token)
    {
        var card = new AccountCard(token);
        var next = Capsule(StoreAccountText.GateNext, BellTheme.ProminentFill, Brushes.White, 12, 15, new Thickness(18, 12));
        next.HorizontalAlignment = HorizontalAlignment.Stretch; next.HorizontalContentAlignment = HorizontalAlignment.Center; next.Margin = new Thickness(0, 18, 0, 0); next.IsVisible = card.Entitled;
        next.Click += (_, _) => onContinue();
        card.EntitledChanged += () => next.IsVisible = card.Entitled;
        Content = new Border { Padding = new Thickness(16, 40, 16, 24), Background = SettingsUi.Canvas, Child = new StackPanel { Children = { card, next } } };
    }
}
