using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Linux;

// A sheet whose header carries a 保存 button (Mac editor toolbar).
public interface ISheetSave
{
    bool CanSave { get; }
    event Action? CanSaveChanged;
    Task SaveAsync();
    // The header's two buttons: the left one closes (the editors say キャンセル until something is saved), the right one saves.
    string CloseLabel => "閉じる";
    string SaveLabel => "保存";
    bool CanClose => true;
    // Escape closes an open alert before it closes the sheet; true when something was closed.
    bool DismissPopup() => false;
}

// A window that shows sheets over its page (MainWindow).
internal interface ISheetHost
{
    void OpenSheet(string title, Control content);
    void CloseSheet();
}

public sealed record AlertChoice(string Label, Action? Click = null, bool Destructive = false, bool Bold = false);

// The shared body of the Mac member and room editors: a scrolling grouped form, one status line, the Mac alert, and the busy state that locks everything.
// The header (キャンセル / 保存) belongs to the host: a sheet header, reading ISheetSave.
public abstract class EditorFormView : Grid, ISheetSave, IDisposable
{
    private readonly ScrollViewer scroller = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    private readonly Grid alertLayer = new() { Background = new SolidColorBrush(Color.FromArgb(0x59, 0, 0, 0)), IsVisible = false };
    private readonly CancellationTokenSource lifetime;
    private bool busy, closed;
    protected readonly StackPanel Form = new() { Margin = new Thickness(20, 4, 20, 28) };
    protected readonly List<Task> InitialLoads = [];
    protected EditorFormView(LinuxWorkspace workspace)
    {
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(workspace.ConnectionToken);
        Background = BellTheme.ConversationBackground;
        scroller.Content = Form; Children.Add(scroller); alertLayer.ZIndex = 5; Children.Add(alertLayer);
    }
    // Set by the host: closes the sheet.
    public Action? Closer { get; set; }
    protected CancellationToken Token => lifetime.Token;
    public Task ReadyTask => Task.WhenAll(InitialLoads);
    public bool IsBusy => busy;
    public bool IsClosing => closed;
    public bool Ready { get; protected set; }
    public bool AlertOpen => alertLayer.IsVisible;
    public event Action? CanSaveChanged;
    public virtual bool CanSave => Ready && !busy && !SaveBlocked;
    public virtual bool CanClose => !busy;
    protected virtual bool SaveBlocked => false;
    public virtual string CloseLabel => "キャンセル";
    public virtual string SaveLabel => "保存";
    public abstract Task SaveAsync();
    protected void Notify() => CanSaveChanged?.Invoke();

    protected void Close()
    {
        if (closed) return;
        closed = true; Notify(); Closer?.Invoke();
    }
    public virtual void Dispose() { closed = true; if (!lifetime.IsCancellationRequested) lifetime.Cancel(); lifetime.Dispose(); }

    // Mac .disabled(saving): the whole form stops answering while a request runs, and the header buttons follow through ISheetSave.
    protected async Task RunAsync(Func<Task> work)
    {
        if (busy) return;
        busy = true; scroller.IsEnabled = false; Notify();
        try { await work(); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        finally { busy = false; scroller.IsEnabled = true; Notify(); }
    }

    // Render seam: the bottom of the form (the 削除 section and the result lines).
    public void ScrollToEndForRender() { scroller.UpdateLayout(); scroller.ScrollToEnd(); scroller.UpdateLayout(); }
    public bool DismissPopup()
    {
        if (!AlertOpen) return false;
        alertLayer.IsVisible = false; return true;
    }

    // The Mac alert: a title, a message and stacked buttons. Any button closes it first, then runs its action.
    protected void ShowAlert(string title, string message, params AlertChoice[] choices)
    {
        alertLayer.Children.Clear(); alertLayer.Children.Add(AlertFrame(title, message, () => DismissPopup(), choices)); alertLayer.IsVisible = true;
    }
    // The alert card itself. Any button dismisses first, then runs its action.
    internal static Border AlertFrame(string title, string message, Action dismiss, params AlertChoice[] choices)
    {
        var card = new StackPanel { Width = 300 };
        var heading = Text(title, 14, Ink, FontWeight.SemiBold, new Thickness(20, 18, 20, message.Length == 0 ? 16 : 0)); heading.TextAlignment = TextAlignment.Center; card.Children.Add(heading);
        if (message.Length != 0) { var detail = Text(message, 12, Ink, null, new Thickness(20, 6, 20, 16)); detail.TextAlignment = TextAlignment.Center; card.Children.Add(detail); }
        foreach (var choice in choices)
        {
            var button = new Button { Classes = { "plain" }, Content = choice.Label, Background = Brushes.Transparent, BorderThickness = new Thickness(0, 1, 0, 0), BorderBrush = Hairline, CornerRadius = default, Foreground = choice.Destructive ? Red : Violet, FontSize = 14, FontWeight = choice.Bold ? FontWeight.SemiBold : FontWeight.Normal, Padding = new Thickness(0, 11), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Center };
            AutomationProperties.SetName(button, choice.Label);
            button.Click += (_, _) => { dismiss(); choice.Click?.Invoke(); };
            card.Children.Add(button);
        }
        var frame = new Border { Child = card, Background = new SolidColorBrush(Color.FromRgb(0xF6, 0xF6, 0xF8)), CornerRadius = new CornerRadius(14), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, ClipToBounds = true, BoxShadow = BoxShadows.Parse("0 6 24 0 #4D000000") };
        AutomationProperties.SetName(frame, title);
        return frame;
    }

    // ---- Form building blocks shared by both editors ----
    internal static Button LinkButton(string label, Action click, bool enabled = true, bool destructive = false)
    {
        var button = new Button { Classes = { "plain" }, Content = label, HorizontalAlignment = HorizontalAlignment.Left, Padding = default, Margin = default, FontSize = 13, FontWeight = FontWeight.Normal, Foreground = destructive ? Red : Violet, Background = Brushes.Transparent, IsEnabled = enabled };
        button.Click += (_, _) => click(); AutomationProperties.SetName(button, label); return button;
    }
    internal static Border Note(string text, IBrush? color = null, double size = 13) => Row(Text(text, size, color ?? Secondary));
    internal static Border Labeled(string label, Control control, double labelWidth = 0)
    {
        var grid = new Grid { VerticalAlignment = VerticalAlignment.Center, ColumnDefinitions = new ColumnDefinitions(labelWidth > 0 ? $"{labelWidth},*" : "Auto,*") };
        var caption = Text(label, 13); caption.VerticalAlignment = VerticalAlignment.Center; grid.Children.Add(caption);
        control.HorizontalAlignment = HorizontalAlignment.Right; control.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(control, 1); grid.Children.Add(control); return Row(grid);
    }
    internal static ComboBox Popup(string label, IEnumerable<FormOption> options, string? selected)
    {
        var items = options.ToArray();
        var combo = new ComboBox { ItemsSource = items, SelectedItem = items.FirstOrDefault(item => item.Id == selected), FontSize = 13, Padding = new Thickness(10, 5), MinWidth = 140, MaxWidth = 360, ItemTemplate = new Avalonia.Controls.Templates.FuncDataTemplate<FormOption>((option, _) => new TextBlock { Text = option?.Label }) };
        AutomationProperties.SetName(combo, label); return combo;
    }
    // Mac Form multi-line field: the caption above, up to seven lines of text.
    internal static (Border Row, TextBox Box) Paragraph(string caption, string value, bool captionShown = true)
    {
        var (element, box) = Field(caption, value, multiline: true, minHeight: 48); box.MaxHeight = 150;
        var stack = new StackPanel();
        if (captionShown) stack.Children.Add(Text(caption, 11, Muted, FontWeight.SemiBold, new Thickness(0, 0, 0, 6)));
        stack.Children.Add(element); return (Row(stack), box);
    }
}
