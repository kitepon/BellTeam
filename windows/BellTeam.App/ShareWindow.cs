using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

// 共有 (conversation forward.md "Share-in"): the small window that opens when another app shares into BellTeam through the Windows share sheet.
// Pick a Bot or a room, add a comment of your own if you like, 共有 sends it; the process ends with the window.
public sealed class ShareWindow : Window
{
    private readonly Workspace workspace;
    private readonly ShareContent content;
    private readonly ImageAttachment[] images;
    private readonly ListBox destinations = new() { BorderThickness = new Thickness(0), Background = Brushes.Transparent, MaxHeight = 220, FontSize = 16 };
    private readonly TextBox comment = new() { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 64, MaxHeight = 140, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(10, 8, 10, 8), FontSize = 16 };
    private readonly TextBlock status = new() { FontSize = 14, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 12, 0, 0) };
    private readonly Button send = new() { Content = AppStrings.RemoteImages_ImageGallery_5, MinWidth = 96, Padding = new Thickness(14, 7, 14, 7), IsDefault = true, IsEnabled = false };
    private bool sending;
    public Action? Completed { get; init; }
    public string StatusText => status.Text;
    internal ShareWindow(Workspace workspace, ShareContent content, ImageAttachment[] images, int skipped)
    {
        this.workspace = workspace; this.content = content; this.images = images;
        Title = AppStrings.ShareWindow_ShareWindow_1; Width = 600; Height = 760; MinWidth = 480; MinHeight = 520; WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = (Brush)Application.Current.FindResource("ConversationBackground");
        var muted = (Brush)Application.Current.FindResource("Muted");
        var form = new StackPanel { Margin = new Thickness(22, 18, 22, 22) };
        form.Children.Add(Header(AppStrings.ShareWindow_ShareWindow_2));
        var preview = new StackPanel();
        if (content.App is { } app) preview.Children.Add(new TextBlock { Text = AppStrings.ShareWindow_ShareWindow_3(app), FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = (Brush)Application.Current.FindResource("Violet"), Margin = new Thickness(0, 0, 0, 4) });
        if (content.Text is { } text) preview.Children.Add(new TextBlock { Text = text, FontSize = 15, TextWrapping = TextWrapping.Wrap, MaxHeight = 110, TextTrimming = TextTrimming.CharacterEllipsis });
        foreach (var url in content.Urls) preview.Children.Add(new TextBlock { Text = url, FontSize = 14, Foreground = (Brush)Application.Current.FindResource("Violet"), TextTrimming = TextTrimming.CharacterEllipsis, Margin = new Thickness(0, 3, 0, 0) });
        if (images.Length != 0) preview.Children.Add(new TextBlock { Text = images.Length == 1 ? AppStrings.ShareWindow_ShareWindow_4 : AppStrings.MessageCard_UpdateRow_1(images.Length), FontSize = 14, Foreground = muted, Margin = new Thickness(0, 3, 0, 0) });
        form.Children.Add(new Border { BorderBrush = muted, BorderThickness = new Thickness(3, 0, 0, 0), Padding = new Thickness(12, 6, 12, 6), Child = preview });
        // Files that are not images cannot be sent yet (forward.md "Files"); the rest of the share still goes, and the Owner is told plainly.
        if (skipped != 0) form.Children.Add(new TextBlock { Text = AppStrings.ShareWindow_ShareWindow_6(skipped), FontSize = 14, Foreground = muted, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 10, 0, 0) });
        form.Children.Add(Header(AppStrings.ShareWindow_ShareWindow_7));
        System.Windows.Automation.AutomationProperties.SetName(destinations, AppStrings.ShareWindow_ShareWindow_7); destinations.SelectionChanged += (_, _) => UpdateButton();
        form.Children.Add(destinations);
        form.Children.Add(Header(AppStrings.ForwardView_ForwardView_5)); System.Windows.Automation.AutomationProperties.SetName(comment, AppStrings.ForwardView_ForwardView_6); form.Children.Add(comment);
        form.Children.Add(status);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 18, 0, 0) };
        var cancel = new Button { Content = AppStrings.EditorForm_CloseLabel_1, MinWidth = 96, Padding = new Thickness(14, 7, 14, 7), Margin = new Thickness(0, 0, 10, 0), IsCancel = true };
        cancel.Click += (_, _) => Close(); send.Click += async (_, _) => await SendAsync();
        buttons.Children.Add(cancel); buttons.Children.Add(send); form.Children.Add(buttons);
        Content = new ScrollViewer { Content = form, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Say(AppStrings.ShareWindow_ShareWindow_12, false);
    }
    private static TextBlock Header(string text) => new() { Text = text, FontSize = 14, FontWeight = FontWeights.SemiBold, Foreground = (Brush)Application.Current.FindResource("Muted"), Margin = new Thickness(0, 16, 0, 6) };
    private void Say(string text, bool error) { status.Text = text; status.Foreground = error ? new SolidColorBrush(Color.FromRgb(255, 59, 48)) : (Brush)Application.Current.FindResource("Muted"); status.Visibility = text.Length == 0 ? Visibility.Collapsed : Visibility.Visible; }
    private void UpdateButton() => send.IsEnabled = !sending && destinations.SelectedItem is not null && workspace.Connected;
    // Render seam: what a person would have picked and typed, and a refusal.
    internal void SetForRender(int destination, string text, string? failure) { destinations.ItemsSource = workspace.Entries; destinations.DisplayMemberPath = nameof(ConversationEntry.Name); destinations.SelectedIndex = destination; comment.Text = text; Say(failure ?? "", failure is not null); }

    // Connect with the saved server and sign-in (the same path as the main window), then offer the destinations.
    public async Task ConnectAsync(string? server)
    {
        if (string.IsNullOrWhiteSpace(server)) { Say(AppStrings.ShareWindow_ConnectAsync_1, true); return; }
        await workspace.ConnectAsync(server, listen: false);
        if (workspace.ConnectionError is { } failure) { Say(failure, true); return; }
        destinations.ItemsSource = workspace.Entries; destinations.DisplayMemberPath = nameof(ConversationEntry.Name);
        Say("", false); UpdateButton();
    }
    private async Task SendAsync()
    {
        if (sending || destinations.SelectedItem is not ConversationEntry destination) return;
        sending = true; send.Content = AppStrings.ShareWindow_SendAsync_1; Say("", false); UpdateButton();
        try
        {
            var refusal = await workspace.ShareAsync(destination.Target, comment.Text, content, images);
            if (refusal is null) { Completed?.Invoke(); Close(); return; }
            Say(refusal, true);
        }
        finally { sending = false; send.Content = AppStrings.RemoteImages_ImageGallery_5; UpdateButton(); }
    }
}
