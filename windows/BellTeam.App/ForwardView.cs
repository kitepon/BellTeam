using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

// 転送 (conversation forward.md): the sheet that opens from a message's 転送 button. Pick a Bot or a room, add a comment of your own if you like, 転送 sends it.
public sealed class ForwardView : ScrollViewer, ISheetSave
{
    private readonly Workspace workspace;
    private readonly TimelineMessage message;
    private readonly Action close;
    private readonly ListBox destinations = new() { BorderThickness = new Thickness(0), Background = Brushes.Transparent, MaxHeight = 260 };
    private readonly TextBox comment = new() { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 64, MaxHeight = 160, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(10, 8, 10, 8), FontSize = 16 };
    private readonly TextBlock error = new() { Foreground = new SolidColorBrush(Color.FromRgb(255, 59, 48)), FontSize = 14, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 12, 0, 0), Visibility = Visibility.Collapsed };
    private bool sending;
    public bool CanSave => !sending && destinations.SelectedItem is not null;
    public event Action? CanSaveChanged;
    string ISheetSave.CloseLabel => "キャンセル";
    string ISheetSave.SaveLabel => sending ? "転送中…" : "転送";
    public string ErrorText => error.Text;
    // Render seam: what a person would have picked and typed.
    public void SetForRender(int destination, string text) { destinations.SelectedIndex = destination; comment.Text = text; }
    public void FailForRender(string text) { error.Text = text; error.Visibility = Visibility.Visible; }

    public ForwardView(Workspace workspace, TimelineMessage message, Action close)
    {
        this.workspace = workspace; this.message = message; this.close = close;
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto; Background = (Brush)Application.Current.FindResource("ConversationBackground");
        var muted = (Brush)Application.Current.FindResource("Muted");
        var form = new StackPanel { Margin = new Thickness(20, 8, 20, 24), MaxWidth = 720 };
        form.Children.Add(Header("転送する発言"));
        var text = message.Message ?? ""; if (text.Length == 0 && message.DisplayedImageUrls.Length != 0) text = "（画像）";
        form.Children.Add(new Border { BorderBrush = (Brush)Application.Current.FindResource("Violet"), BorderThickness = new Thickness(3, 0, 0, 0), Background = new SolidColorBrush(Color.FromArgb(40, 0x61, 0x47, 0xD4)), Padding = new Thickness(12, 8, 12, 8), Child = new TextBlock { Text = text, FontSize = 15, Foreground = muted, TextWrapping = TextWrapping.Wrap, MaxHeight = 90, TextTrimming = TextTrimming.CharacterEllipsis } });
        form.Children.Add(Header("転送先"));
        destinations.ItemsSource = workspace.Entries; destinations.DisplayMemberPath = nameof(ConversationEntry.Name); destinations.FontSize = 16;
        System.Windows.Automation.AutomationProperties.SetName(destinations, "転送先");
        destinations.SelectionChanged += (_, _) => CanSaveChanged?.Invoke();
        form.Children.Add(destinations);
        form.Children.Add(Header("コメント（任意）"));
        System.Windows.Automation.AutomationProperties.SetName(comment, "コメント");
        form.Children.Add(comment); form.Children.Add(error);
        Content = form;
    }
    private static TextBlock Header(string text) => new() { Text = text, FontSize = 14, FontWeight = FontWeights.SemiBold, Foreground = (Brush)Application.Current.FindResource("Muted"), Margin = new Thickness(0, 16, 0, 6) };

    public async Task SaveAsync()
    {
        if (!CanSave || destinations.SelectedItem is not ConversationEntry destination) return;
        sending = true; error.Visibility = Visibility.Collapsed; CanSaveChanged?.Invoke();
        try
        {
            var refusal = await workspace.ForwardAsync(message, destination.Target, comment.Text);
            if (refusal is null) { close(); return; }
            error.Text = refusal; error.Visibility = Visibility.Visible;
        }
        finally { sending = false; CanSaveChanged?.Invoke(); }
    }
}
