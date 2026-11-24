using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using BellTeam.Core;

namespace BellTeam.Linux;

// The tool approvals the selected Bot's seats wait on (seat-approval-clients; Kiro's contract seat-approvals.md), the same entry as the Windows SeatApprovalBar and the Mac app:
// one card per entry, oldest first: heading, tool and harness, the literal command (monospace, selectable; a TUI Claude seat gives none and says to look at the Bot's screen), the reason and the server's two choices.
// The answer goes through Workspace.AnswerSeatApprovalAsync, which reads the entries again after it, so an entry answered elsewhere (409) simply goes. No id is shown. Android links this file as it is.
public sealed class SeatApprovalBar : StackPanel
{
    private static readonly IBrush Amber = new SolidColorBrush(Color.FromRgb(184, 106, 0)), Code = new SolidColorBrush(Color.FromRgb(244, 244, 248));
    private static readonly FontFamily Mono = new("Cascadia Mono, DejaVu Sans Mono, Menlo, Consolas, monospace");
    private readonly HashSet<string> sending = [];
    private readonly Dictionary<string, string> notes = [];
    private LinuxWorkspace? workspace;
    private string? closedNote, closedFor;

    public SeatApprovalBar() { IsVisible = false; AutomationProperties.SetAutomationId(this, "seat-approvals"); }

    public void Attach(LinuxWorkspace next)
    {
        workspace = next;
        next.SeatApprovalsChanged += () => Post(Rebuild);
        next.PropertyChanged += (_, args) => { if (args.PropertyName == nameof(LinuxWorkspace.Selected)) Post(Rebuild); };
        Rebuild();
    }
    private static void Post(Action action) { if (Dispatcher.UIThread.CheckAccess()) action(); else Dispatcher.UIThread.Post(action); }

    internal void Rebuild()
    {
        var botId = workspace?.Selected is { Target.IsRoom: false } entry ? entry.Target.Id : null;
        var mine = botId is null ? [] : workspace!.SeatApprovals.Where(item => item.BotId == botId).ToArray();
        if (closedFor != botId) closedNote = null;
        Children.Clear();
        foreach (var gone in notes.Keys.Where(id => mine.All(item => item.Id != id)).ToArray()) notes.Remove(gone);
        sending.IntersectWith(mine.Select(item => item.Id));
        foreach (var approval in mine) Children.Add(Card(approval));
        if (closedNote is not null) Children.Add(new TextBlock { Text = closedNote, FontSize = 13, Foreground = BellTheme.Muted, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(18, 6, 18, 0) });
        IsVisible = Children.Count != 0;
    }

    private Control Card(SeatApproval approval)
    {
        var stack = new StackPanel();
        var mark = Icons.Draw(Icons.Lock, 16, Amber, thickness: 2); mark.Margin = new Thickness(0, 0, 8, 0);
        var heading = new TextBlock { Text = SeatApprovalText.Heading, FontSize = 15, FontWeight = FontWeight.SemiBold, Foreground = Amber, VerticalAlignment = VerticalAlignment.Center };
        stack.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 10), Children = { mark, heading } });
        if (SeatApprovalText.Source(approval) is { Length: > 0 } source) { var line = SecretCard.CardText(source, bold: true, size: 13, muted: true); line.Margin = new Thickness(0); stack.Children.Add(line); }
        var literal = approval.Command is { Length: > 0 };
        var command = new TextBox
        {
            Classes = { "bare" }, Text = SeatApprovalText.CommandText(approval), IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontFamily = Mono, FontSize = 13.5, Foreground = literal ? BellTheme.Ink : BellTheme.Muted,
            Background = Code, BorderThickness = default, CornerRadius = new CornerRadius(8), Padding = new Thickness(10, 8), Margin = new Thickness(0, 8, 0, 0), MaxHeight = 160
        };
        AutomationProperties.SetAutomationId(command, "seat-approval-command"); stack.Children.Add(command);
        if (!string.IsNullOrWhiteSpace(approval.Reason)) stack.Children.Add(SecretCard.CardText(approval.Reason!, size: 13, muted: true));
        var busy = sending.Contains(approval.Id);
        var row = new WrapPanel { Margin = new Thickness(0, 12, 0, 0) };
        foreach (var (choice, first) in approval.Buttons.Select((choice, index) => (choice, index == 0)))
        {
            var button = first ? MacUi.Prominent(choice.Label, () => _ = AnswerAsync(approval, choice.Decision)) : MacUi.Bordered(choice.Label, () => _ = AnswerAsync(approval, choice.Decision));
            button.Margin = new Thickness(0, 0, 8, 6); button.IsEnabled = !busy; AutomationProperties.SetAutomationId(button, "seat-approval-" + choice.Decision); row.Children.Add(button);
        }
        stack.Children.Add(row);
        if (busy) { var sent = SecretCard.CardText(SeatApprovalText.Sending, size: 13, muted: true); sent.Margin = new Thickness(0); stack.Children.Add(sent); }
        if (notes.TryGetValue(approval.Id, out var note)) stack.Children.Add(SecretCard.CardText(note, size: 13, error: true));
        var card = new Border
        {
            Child = stack, Background = new SolidColorBrush(Colors.White), CornerRadius = new CornerRadius(16), BorderBrush = new SolidColorBrush(Color.FromArgb(90, 184, 106, 0)), BorderThickness = new Thickness(1),
            Padding = new Thickness(16), Margin = new Thickness(18, 6, 18, 0)
        };
        AutomationProperties.SetAutomationId(card, "seat-approval-card"); return card;
    }

    private async Task AnswerAsync(SeatApproval approval, string decision)
    {
        if (workspace is not { } model || !sending.Add(approval.Id)) return;   // one answer at a time: a second press while it is sent is nothing
        notes.Remove(approval.Id); Rebuild();
        SeatApprovalOutcome outcome;
        try { outcome = await model.AnswerSeatApprovalAsync(approval, decision); }
        catch (OperationCanceledException) { sending.Remove(approval.Id); return; }
        sending.Remove(approval.Id);
        if (outcome.Result == SeatApprovalResult.Failed) notes[approval.Id] = outcome.Text!;
        else if (outcome.Result == SeatApprovalResult.Closed) { closedNote = outcome.Text; closedFor = approval.BotId; }
        else closedNote = null;
        Rebuild();
    }
}
