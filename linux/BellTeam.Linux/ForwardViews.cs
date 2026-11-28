using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;

namespace BellTeam.Linux;

// 転送 and 共有 (conversation forward.md): a sheet to pick a Bot or a room and add a comment of your own. Both send through the shared Workspace,
// which answers null when accepted or the refusal in plain words (the sheet stays open then, with the comment).
public sealed class DestinationSheet : ScrollViewer, ISheetSave
{
    private readonly Func<ChatTarget, string, Task<string?>> send;
    private readonly Action close;
    private readonly string label, busyLabel;
    // The destinations are the sidebar's own rows (avatar, name, summary) under its ルーム / メンバー headers; the chosen one takes the sidebar's selected look.
    private readonly StackPanel destinations = new();
    private readonly Dictionary<ChatTarget, ConversationRow> rows = [];
    private ConversationEntry? chosen;
    private readonly TextBox comment = new() { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 64, MaxHeight = 160, Padding = new Thickness(10, 8), FontSize = 16 };
    private readonly TextBlock error = new() { Foreground = BellTheme.Red, FontSize = 14, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 12, 0, 0), IsVisible = false };
    private readonly ConversationEntry[] entries;
    private bool sending;
    public bool CanSave => !sending && chosen is not null;
    public event Action? CanSaveChanged;
    string ISheetSave.CloseLabel => LinuxStrings.EditorForm_CloseLabel_2;
    string ISheetSave.SaveLabel => sending ? LinuxStrings.ForwardViews_SaveLabel_1(busyLabel) : label;
    bool ISheetSave.CanClose => !sending;
    public string ErrorText => error.Text ?? "";
    // Render seam: what a person would have picked and typed, and a refusal.
    public void SetForRender(int destination, string text, string? failure = null)
    {
        Choose(entries[destination]); comment.Text = text;
        if (failure is not null) { error.Text = failure; error.IsVisible = true; }
    }

    public DestinationSheet(LinuxWorkspace workspace, string previewHeader, Control preview, string destinationHeader, string label, string busyLabel, Func<ChatTarget, string, Task<string?>> send, Action close, ConversationEntry? preselect = null, string? note = null)
    {
        this.send = send; this.close = close; this.label = label; this.busyLabel = busyLabel;
        VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto; Background = BellTheme.ConversationBackground;
        var form = new StackPanel { Margin = new Thickness(20, 8, 20, 24), MaxWidth = 720 };
        form.Children.Add(Header(previewHeader)); form.Children.Add(preview);
        if (note is not null) form.Children.Add(new TextBlock { Text = note, FontSize = 14, Foreground = BellTheme.Muted, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 10, 0, 0) });
        form.Children.Add(Header(destinationHeader));
        entries = workspace.Entries.ToArray();
        foreach (var group in entries.GroupBy(entry => entry.Group))
        {
            destinations.Children.Add(new TextBlock { Text = group.Key, FontSize = 14, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Muted, Margin = new Thickness(8, 12, 0, 4) });
            foreach (var entry in group) { var row = new ConversationRow(workspace, entry, Choose); rows[entry.Target] = row; destinations.Children.Add(row); }
        }
        AutomationProperties.SetName(destinations, destinationHeader);
        if (preselect is not null) chosen = entries.FirstOrDefault(entry => entry.Target == preselect.Target);
        UpdateRows();
        form.Children.Add(new ScrollViewer { Content = destinations, MaxHeight = 330, VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto });
        // The refusal sits under the list, above the comment, so it stays on screen when the sheet is tall.
        error.Margin = new Thickness(0, 10, 0, 0); form.Children.Add(error);
        form.Children.Add(Header(LinuxStrings.ForwardViews_DestinationSheet_1)); AutomationProperties.SetName(comment, LinuxStrings.ForwardViews_DestinationSheet_2); form.Children.Add(comment);
        Content = form;
    }
    private void Choose(ConversationEntry entry) { chosen = entry; UpdateRows(); CanSaveChanged?.Invoke(); }
    private void UpdateRows() { foreach (var (target, row) in rows) row.Classes.Set("selected", chosen?.Target == target); }
    private static TextBlock Header(string text) => new() { Text = text, FontSize = 14, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Muted, Margin = new Thickness(0, 16, 0, 6) };

    public async Task SaveAsync()
    {
        if (!CanSave || chosen is not { } destination) return;
        sending = true; error.IsVisible = false; CanSaveChanged?.Invoke();
        try
        {
            var refusal = await send(destination.Target, comment.Text ?? "");
            if (refusal is null) { close(); return; }
            error.Text = refusal; error.IsVisible = true;
        }
        finally { sending = false; CanSaveChanged?.Invoke(); }
    }

    private static Border Quote(Control child, IBrush bar) => new() { BorderBrush = bar, BorderThickness = new Thickness(3, 0, 0, 0), Background = new SolidColorBrush(Color.FromArgb(40, 0x61, 0x47, 0xD4)), Padding = new Thickness(12, 8), Child = child };

    // The sheet of the 転送 button: the picked message, then the destination.
    public static DestinationSheet Forward(LinuxWorkspace workspace, TimelineMessage message, Action close)
    {
        var text = message.QuoteText; if (text.Length == 0 && message.DisplayedImageUrls.Length != 0) text = LinuxStrings.ForwardViews_Forward_1;
        // Drawn the way the conversation draws the message (no literal ** or - marks), clipped to a few lines.
        var body = new MarkdownView { FontSize = 15, Foreground = BellTheme.Muted };
        try { body.Source = text; } catch (NotSupportedException) { body.ShowText(text); }
        var preview = Quote(new Border { Child = body, MaxHeight = 96, ClipToBounds = true }, BellTheme.Violet);
        return new DestinationSheet(workspace, LinuxStrings.ForwardViews_Forward_2, preview, LinuxStrings.ForwardViews_Forward_3, LinuxStrings.ForwardViews_Forward_4, LinuxStrings.ForwardViews_Forward_4, (target, comment) => workspace.ForwardAsync(message, target, comment), close);
    }

    // The sheet of a drop from another app (Linux has no share sheet): the dropped text, links and images, then the destination (the open conversation is picked).
    public static DestinationSheet Share(LinuxWorkspace workspace, ShareContent content, ImageAttachment[] images, int skipped, Action close)
    {
        var parts = new StackPanel();
        if (content.Text is { Length: > 0 } text) parts.Children.Add(new TextBlock { Text = text, FontSize = 15, TextWrapping = TextWrapping.Wrap, MaxHeight = 110, TextTrimming = TextTrimming.CharacterEllipsis });
        foreach (var url in content.Urls) parts.Children.Add(new TextBlock { Text = url, FontSize = 14, Foreground = BellTheme.Violet, TextTrimming = TextTrimming.CharacterEllipsis, Margin = new Thickness(0, 3, 0, 0) });
        if (images.Length != 0) parts.Children.Add(new TextBlock { Text = images.Length == 1 ? LinuxStrings.ForwardViews_Share_1 : LinuxStrings.ForwardViews_Share_2(images.Length), FontSize = 14, Foreground = BellTheme.Muted, Margin = new Thickness(0, 3, 0, 0) });
        // Files that are not images cannot be sent yet (forward.md "Files"); the rest still goes, and the Owner is told plainly.
        var note = skipped == 0 ? null : LinuxStrings.ForwardViews_Share_3(skipped);
        return new DestinationSheet(workspace, LinuxStrings.ForwardViews_Share_4, Quote(parts, BellTheme.Muted), LinuxStrings.ForwardViews_Share_5, LinuxStrings.ForwardViews_Share_6, LinuxStrings.ForwardViews_Share_6, (target, comment) => workspace.ShareAsync(target, comment, content, images), close, workspace.Selected, note);
    }
}

// What a drop of text from another app becomes (forward.md "Share-in"): links are carried as URLs, not repeated in the text.
public static class ShareDrop
{
    // Every non-empty line a link: only URLs (a lone dragged link is one URL, not text). Otherwise the whole text is shared and its links stay inside it.
    public static ShareContent? Parse(string dropped)
    {
        var lines = dropped.Replace("\r\n", "\n").Split('\n').Select(line => line.Trim()).Where(line => line.Length != 0).ToArray();
        if (lines.Length == 0) return null;
        var links = ShareContent.WebLinks(lines);
        return links.Length == lines.Length ? new ShareContent(null, null, links) : new ShareContent(null, dropped.Trim(), []);
    }
}
