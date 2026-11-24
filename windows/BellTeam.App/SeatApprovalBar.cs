using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

/// <summary>
/// The Bot's screen, top: the tool approvals its seats wait on (seat-approval-clients; Kiro's contract seat-approvals.md). One card per entry, oldest first: heading, the tool and harness, the literal command (monospace, selectable, wraps; a TUI Claude seat gives none and says to look at the Bot's screen),
/// the reason, and the server's two choices (1回だけ許可する / 許可しない). The answer goes through <see cref="Workspace.AnswerSeatApprovalAsync"/>; the entries are read again after it, so an entry answered elsewhere (409) simply goes. No id is shown.
/// </summary>
public sealed class SeatApprovalBar : StackPanel
{
    public static readonly DependencyProperty WorkspaceProperty = DependencyProperty.Register(nameof(Workspace), typeof(Workspace), typeof(SeatApprovalBar), new PropertyMetadata(null, (bar, change) => ((SeatApprovalBar)bar).Attach((Workspace?)change.OldValue, (Workspace?)change.NewValue)));
    public Workspace? Workspace { get => (Workspace?)GetValue(WorkspaceProperty); set => SetValue(WorkspaceProperty, value); }

    private static readonly Brush Amber = SecretCard.Frozen(Color.FromRgb(184, 106, 0)), Ink = SecretCard.Frozen(Color.FromRgb(33, 41, 61)), Muted = SecretCard.Frozen(Color.FromRgb(120, 125, 145)), Red = SecretCard.Frozen(Color.FromRgb(255, 59, 48)),
        Code = SecretCard.Frozen(Color.FromRgb(244, 244, 248));
    private readonly HashSet<string> sending = [];
    private readonly Dictionary<string, string> notes = [];
    private string? closedNote, closedFor;

    public SeatApprovalBar() { Visibility = Visibility.Collapsed; System.Windows.Automation.AutomationProperties.SetAutomationId(this, "seat-approvals"); }

    private void Attach(Workspace? old, Workspace? next)
    {
        if (old is not null) { old.SeatApprovalsChanged -= OnChanged; old.PropertyChanged -= OnProperty; }
        if (next is not null) { next.SeatApprovalsChanged += OnChanged; next.PropertyChanged += OnProperty; }
        Rebuild();
    }
    private void OnProperty(object? sender, System.ComponentModel.PropertyChangedEventArgs args) { if (args.PropertyName == nameof(Workspace.Selected)) OnChanged(); }
    private void OnChanged() { if (Dispatcher.CheckAccess()) Rebuild(); else Dispatcher.BeginInvoke(Rebuild); }

    private IReadOnlyList<SeatApproval> Mine => Workspace?.Selected is { Target.IsRoom: false } entry ? [.. Workspace.SeatApprovals.Where(item => item.BotId == entry.Target.Id)] : [];

    internal void Rebuild()
    {
        var mine = Mine; var botId = Workspace?.Selected?.Target.Id;
        if (closedFor != botId) closedNote = null;
        Children.Clear();
        foreach (var gone in notes.Keys.Where(id => mine.All(item => item.Id != id)).ToArray()) notes.Remove(gone);
        sending.IntersectWith(mine.Select(item => item.Id));
        foreach (var approval in mine) Children.Add(Card(approval));
        if (closedNote is not null) Children.Add(new TextBlock { Text = closedNote, FontSize = 13, Foreground = Muted, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(18, 6, 18, 0) });
        Visibility = Children.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
    }

    private FrameworkElement Card(SeatApproval approval)
    {
        var stack = new StackPanel();
        var header = (StackPanel)SecretCard.CardTitle("\uE72E", SeatApprovalText.Heading); ((TextBlock)header.Children[1]).Foreground = Amber; stack.Children.Add(header);
        if (SeatApprovalText.Source(approval) is { Length: > 0 } source) stack.Children.Add(SecretCard.CardText(source, bold: true, size: 13, muted: true));
        var command = new TextBox
        {
            Text = SeatApprovalText.CommandText(approval), IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontFamily = new FontFamily("Consolas"), FontSize = 13.5, Foreground = approval.Command is { Length: > 0 } ? Ink : Muted,
            Background = Code, BorderThickness = new Thickness(0), Padding = new Thickness(10, 8, 10, 8), Margin = new Thickness(0, 8, 0, 0), MaxHeight = 160, VerticalScrollBarVisibility = ScrollBarVisibility.Auto
        };
        System.Windows.Automation.AutomationProperties.SetAutomationId(command, "seat-approval-command"); stack.Children.Add(command);
        if (!string.IsNullOrWhiteSpace(approval.Reason)) { var reason = SecretCard.CardText(approval.Reason!, size: 13, muted: true); reason.Margin = new Thickness(0, 8, 0, 0); stack.Children.Add(reason); }
        var busy = sending.Contains(approval.Id);
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 12, 0, 0) };
        foreach (var (choice, first) in approval.Buttons.Select((choice, index) => (choice, index == 0)))
        {
            var button = new Button { Content = choice.Label, FontWeight = FontWeights.SemiBold, Padding = new Thickness(16, 6, 16, 6), Margin = new Thickness(0, 0, 8, 0), IsEnabled = !busy };
            if (first) button.SetResourceReference(StyleProperty, "PrimaryButton");
            System.Windows.Automation.AutomationProperties.SetAutomationId(button, "seat-approval-" + choice.Decision);
            button.Click += async (_, _) => await AnswerAsync(approval, choice.Decision);
            row.Children.Add(button);
        }
        if (busy) row.Children.Add(new TextBlock { Text = SeatApprovalText.Sending, FontSize = 13, Foreground = Muted, VerticalAlignment = VerticalAlignment.Center });
        stack.Children.Add(row);
        if (notes.TryGetValue(approval.Id, out var note)) stack.Children.Add(new TextBlock { Text = note, FontSize = 13, Foreground = Red, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0) });
        var card = new Border
        {
            Child = stack, Background = new SolidColorBrush(Color.FromArgb(240, 255, 255, 255)), CornerRadius = new CornerRadius(16), BorderBrush = new SolidColorBrush(Color.FromArgb(90, 184, 106, 0)), BorderThickness = new Thickness(1),
            Padding = new Thickness(16), Margin = new Thickness(18, 6, 18, 0)
        };
        System.Windows.Automation.AutomationProperties.SetAutomationId(card, "seat-approval-card"); return card;
    }

    private async Task AnswerAsync(SeatApproval approval, string decision)
    {
        if (Workspace is not { } workspace || !sending.Add(approval.Id)) return;   // one answer at a time: a second press while it is sent is nothing
        notes.Remove(approval.Id); Rebuild();
        SeatApprovalOutcome outcome;
        try { outcome = await workspace.AnswerSeatApprovalAsync(approval, decision); }
        catch (OperationCanceledException) { sending.Remove(approval.Id); return; }
        sending.Remove(approval.Id);
        if (outcome.Result == SeatApprovalResult.Failed) notes[approval.Id] = outcome.Text!;
        else if (outcome.Result == SeatApprovalResult.Closed) { closedNote = outcome.Text; closedFor = approval.BotId; }
        else closedNote = null;
        Rebuild();
    }
}
