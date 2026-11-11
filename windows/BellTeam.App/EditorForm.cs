using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using static BellTeam.App.SettingsUi;

namespace BellTeam.App;

public sealed record AlertChoice(string Label, Action? Click = null, bool Destructive = false, bool Bold = false);

// The shared body of the Mac member and room editors: a scrolling grouped form, one status line, the Mac alert, and the busy state that locks everything.
// The header (キャンセル / 保存) belongs to the host: a sheet header or the member window's own bar, both reading ISheetSave.
public abstract class EditorFormView : Grid, ISheetSave, IDisposable
{
    private readonly ScrollViewer scroller = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    private readonly Grid alertLayer = new() { Background = new SolidColorBrush(Color.FromArgb(0x59, 0, 0, 0)), Visibility = Visibility.Collapsed };
    private readonly CancellationTokenSource lifetime;
    private bool busy, closed;
    protected readonly StackPanel Form = new() { Margin = new Thickness(20, 4, 20, 28) };
    protected readonly List<Task> InitialLoads = [];
    protected EditorFormView(Workspace workspace)
    {
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(workspace.ConnectionToken);
        SetResourceReference(BackgroundProperty, "ConversationBackground");
        scroller.Content = Form; Children.Add(scroller); Children.Add(alertLayer); Panel.SetZIndex(alertLayer, 5);
    }
    // Set by the host: closes the sheet or the window.
    public Action? Closer { get; set; }
    protected CancellationToken Token => lifetime.Token;
    public Task ReadyTask => Task.WhenAll(InitialLoads);
    public bool IsBusy => busy;
    // The window host reads this so a close that the editor itself asks for is never held back by the busy state.
    public bool IsClosing => closed;
    public bool Ready { get; protected set; }
    public bool AlertOpen => alertLayer.Visibility == Visibility.Visible;
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
    // Render seam: a part of the form at the top of the view.
    public void ScrollToForRender(UIElement target) { scroller.UpdateLayout(); scroller.ScrollToVerticalOffset(Math.Max(0, target.TranslatePoint(new Point(0, 0), Form).Y - 8)); scroller.UpdateLayout(); }
    public bool DismissPopup()
    {
        if (!AlertOpen) return false;
        alertLayer.Visibility = Visibility.Collapsed; return true;
    }

    // The Mac alert: a title, a message and stacked buttons. Any button closes it first, then runs its action.
    protected void ShowAlert(string title, string message, params AlertChoice[] choices)
    {
        alertLayer.Children.Clear(); alertLayer.Children.Add(AlertFrame(title, message, () => DismissPopup(), choices)); alertLayer.Visibility = Visibility.Visible;
    }
    // The alert card itself, also used by the schedule page's delete confirmation. Any button dismisses first, then runs its action.
    internal static Border AlertFrame(string title, string message, Action dismiss, params AlertChoice[] choices)
    {
        var card = new StackPanel { Width = 300 };
        var heading = Text(title, 14, Ink, FontWeights.SemiBold, new Thickness(20, 18, 20, message.Length == 0 ? 16 : 0)); heading.TextAlignment = TextAlignment.Center; card.Children.Add(heading);
        if (message.Length != 0) { var detail = Text(message, 12, Ink, null, new Thickness(20, 6, 20, 16)); detail.TextAlignment = TextAlignment.Center; card.Children.Add(detail); }
        foreach (var choice in choices)
        {
            var button = new Button { Content = choice.Label, Style = null, Background = Brushes.Transparent, BorderThickness = new Thickness(0, 1, 0, 0), BorderBrush = Hairline, Foreground = choice.Destructive ? Red : Violet, FontSize = 14, FontWeight = choice.Bold ? FontWeights.SemiBold : FontWeights.Normal, Padding = new Thickness(0, 11, 0, 11), Cursor = Cursors.Hand };
            button.Template = AlertTemplate();
            System.Windows.Automation.AutomationProperties.SetName(button, choice.Label);
            button.Click += (_, _) => { dismiss(); choice.Click?.Invoke(); };
            card.Children.Add(button);
        }
        var frame = new Border { Child = card, Background = new SolidColorBrush(Color.FromRgb(0xF6, 0xF6, 0xF8)), CornerRadius = new CornerRadius(14), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, ClipToBounds = true, Effect = new System.Windows.Media.Effects.DropShadowEffect { Opacity = .3, BlurRadius = 24, ShadowDepth = 6, Direction = 270 } };
        System.Windows.Automation.AutomationProperties.SetName(frame, title);
        return frame;
    }
    private static ControlTemplate AlertTemplate() => (ControlTemplate)System.Windows.Markup.XamlReader.Parse(
        "<ControlTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" TargetType=\"Button\"><Border x:Name=\"Chrome\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" Background=\"{TemplateBinding Background}\" BorderBrush=\"{TemplateBinding BorderBrush}\" BorderThickness=\"{TemplateBinding BorderThickness}\" Padding=\"{TemplateBinding Padding}\"><ContentPresenter HorizontalAlignment=\"Center\"/></Border><ControlTemplate.Triggers><Trigger Property=\"IsMouseOver\" Value=\"True\"><Setter TargetName=\"Chrome\" Property=\"Background\" Value=\"#14000000\"/></Trigger></ControlTemplate.Triggers></ControlTemplate>");

    // ---- Form building blocks shared by both editors ----
    internal static Button LinkButton(string label, Action click, bool enabled = true, bool destructive = false)
    {
        var button = new Button { Content = label, HorizontalAlignment = HorizontalAlignment.Left, Padding = new Thickness(0), Margin = new Thickness(0), FontSize = 13, FontWeight = FontWeights.Normal, Foreground = destructive ? Red : Violet, IsEnabled = enabled };
        button.SetResourceReference(StyleProperty, "QuietButton"); button.Click += (_, _) => click();
        System.Windows.Automation.AutomationProperties.SetName(button, label); return button;
    }
    internal static Border Note(string text, Brush? color = null, double size = 13) => Row(Text(text, size, color ?? Secondary));
    internal static Border Labeled(string label, UIElement control, double labelWidth = 0)
    {
        var grid = new Grid { VerticalAlignment = VerticalAlignment.Center };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = labelWidth > 0 ? new GridLength(labelWidth) : GridLength.Auto }); grid.ColumnDefinitions.Add(new ColumnDefinition());
        var caption = Text(label, 13); caption.VerticalAlignment = VerticalAlignment.Center; grid.Children.Add(caption);
        if (control is FrameworkElement element) { element.HorizontalAlignment = HorizontalAlignment.Right; element.VerticalAlignment = VerticalAlignment.Center; }
        Grid.SetColumn(control, 1); grid.Children.Add(control); return Row(grid);
    }
    internal static ComboBox Popup(string label, IEnumerable<FormOption> options, string? selected)
    {
        var combo = new ComboBox { ItemsSource = options.ToArray(), DisplayMemberPath = nameof(FormOption.Label), SelectedValuePath = nameof(FormOption.Id), SelectedValue = selected, FontSize = 13, Padding = new Thickness(10, 5, 10, 5), MinWidth = 140, MaxWidth = 360 };
        System.Windows.Automation.AutomationProperties.SetName(combo, label); return combo;
    }
    // Mac Form multi-line field: the caption above, up to seven lines of text.
    internal static (Border Row, TextBox Box) Paragraph(string caption, string value, bool captionShown = true)
    {
        var (element, box) = Field(caption, value, multiline: true, minHeight: 48); box.MaxHeight = 150;
        var stack = new StackPanel();
        if (captionShown) stack.Children.Add(Text(caption, 11, Muted, FontWeights.SemiBold, new Thickness(0, 0, 0, 6)));
        stack.Children.Add(element); return (Row(stack), box);
    }
}
