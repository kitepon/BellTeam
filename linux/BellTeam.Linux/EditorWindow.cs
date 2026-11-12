using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.FormUi;

namespace BellTeam.Linux;

// The window (or, through AsPage, the page) of a plain form editor: a scrolling body, one status line and キャンセル / 保存.
public class EditorWindow : Window
{
    protected readonly StackPanel Body = new() { Margin = new Thickness(24) };
    protected readonly TextBlock Status = new() { TextWrapping = TextWrapping.Wrap, Foreground = Brushes.Firebrick, Margin = new Thickness(8), FontSize = 14, IsVisible = false };
    protected readonly Button SaveButton = new() { Classes = { "plain" }, Content = "保存", Background = BellTheme.ProminentFill, Foreground = Brushes.White };
    protected readonly Button CloseButton = new() { Classes = { "plain" }, Content = "キャンセル", Background = BellTheme.ButtonFill, Foreground = BellTheme.Ink, Margin = new Thickness(0, 0, 8, 0) };
    protected readonly StackPanel Actions = new() { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
    protected Func<Task<bool>>? SaveAction;
    protected bool Busy { get; set; }
    protected bool Saved { get; set; }
    protected CancellationToken Token { get; }
    protected readonly List<Task> InitialLoads = [];
    private Action? closePage;
    private bool closeWhileReading;
    public virtual bool CanNavigateAway => !Busy || closeWhileReading;
    private readonly ScrollViewer scroller = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    public Task ReadyTask => Task.WhenAll(InitialLoads);
    public virtual void ScrollToEndForRender() { scroller.UpdateLayout(); scroller.ScrollToEnd(); scroller.UpdateLayout(); }
    public EditorWindow(string title, CancellationToken parent = default)
    {
        Background = BellTheme.ConversationBackground;
        var lifetime = CancellationTokenSource.CreateLinkedTokenSource(parent); Token = lifetime.Token;
        Closed += (_, _) => { lifetime.Cancel(); lifetime.Dispose(); };
        Title = title; Width = 700; Height = 800; MinWidth = 600; MinHeight = 500; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var dock = new DockPanel(); var footer = new DockPanel { Margin = new Thickness(16) };
        Actions.Children.Add(CloseButton); Actions.Children.Add(SaveButton); DockPanel.SetDock(Actions, Dock.Right); footer.Children.Add(Actions); footer.Children.Add(Status);
        DockPanel.SetDock(footer, Dock.Bottom); dock.Children.Add(footer); scroller.Content = Body; dock.Children.Add(scroller); Content = dock;
        SaveButton.Click += async (_, _) => { if (SaveAction is not null) await RunAsync(SaveAction); };
        CloseButton.Click += (_, _) => { if (closePage is { } returnToConversation) returnToConversation(); else Close(); };
        Closing += (_, args) => { if (!CanNavigateAway) args.Cancel = true; };
    }
    protected void SetStatus(string text) { Status.Text = text; Status.IsVisible = text.Length != 0; }
    // keepActions: the hosted editor still needs its own 保存/戻る buttons (the settings pane embeds the feature editor).
    public virtual Control AsPage(Action close, bool keepActions = false)
    {
        closePage = close; var content = (Control)Content!; Content = null;
        Body.MaxWidth = 850; Body.HorizontalAlignment = HorizontalAlignment.Stretch;
        if (!keepActions) Actions.IsVisible = false;
        return content;
    }
    protected async Task RunAsync(Func<Task<bool>> operation, bool canClose = false)
    {
        if (Busy) return;
        closeWhileReading = canClose;
        Busy = true; Body.IsEnabled = Actions.IsEnabled = false; SetStatus(""); Status.Foreground = Brushes.Firebrick;
        var close = false;
        try { close = await operation(); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception error) { SetStatus(error is BellApiException { Status: not null } ? error.Message : "操作の結果を確認できませんでした。現在の状態を確認してください。\n" + error.Message); }
        finally { Busy = false; Actions.IsEnabled = true; Body.IsEnabled = SaveButton.IsEnabled = !Saved; CloseButton.IsEnabled = true; if (Saved) CloseButton.Content = "閉じる"; }
        if (close) { if (closePage is { } returnToHost) returnToHost(); else Close(); }
    }
    protected void Heading(string label) => Body.Children.Add(new TextBlock { Text = label, FontSize = 20, FontWeight = FontWeight.SemiBold, Margin = new Thickness(0, 18, 0, 10) });
    protected StackPanel Section(string label)
    {
        Body.Children.Add(new TextBlock { Text = label, FontSize = 14, FontWeight = FontWeight.SemiBold, Foreground = Brushes.SlateGray, Margin = new Thickness(16, 22, 0, 10) });
        var fields = new StackPanel(); Body.Children.Add(new Border { Child = fields, Background = Brushes.White, CornerRadius = new CornerRadius(18), BorderBrush = new SolidColorBrush(Color.FromRgb(229, 227, 240)), BorderThickness = new Thickness(1), Padding = new Thickness(18) }); return fields;
    }
    protected TextBox TextField(string label, string value, bool multiline = false, Panel? parent = null, bool inlineLabel = false)
    {
        var container = parent ?? Body;
        var field = new TextBox { Text = value, FontSize = multiline ? 18 : 16, AcceptsReturn = multiline, TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap, MinHeight = multiline ? 80 : 0, MaxHeight = multiline ? 230 : double.PositiveInfinity };
        ScrollViewer.SetVerticalScrollBarVisibility(field, ScrollBarVisibility.Auto);
        AddField(container, label, field, inlineLabel); return field;
    }
    protected ComboBox Choice(string label, IEnumerable<FormOption> options, string selected, Panel? parent = null, bool inlineLabel = false)
    {
        var container = parent ?? Body;
        var combo = Popup(label, options, selected); combo.Margin = new Thickness(0, 0, 0, 8); combo.Padding = new Thickness(8); combo.HorizontalAlignment = HorizontalAlignment.Stretch; combo.MaxWidth = double.PositiveInfinity;
        AddField(container, label, combo, inlineLabel); return combo;
    }
    private static void AddField(Panel container, string label, Control control, bool inline)
    {
        AutomationProperties.SetName(control, label);
        var caption = new TextBlock { Text = label, FontSize = 14, Foreground = Brushes.SlateGray, Margin = new Thickness(0, 9, 0, 5) };
        if (!inline) { container.Children.Add(caption); container.Children.Add(control); return; }
        var row = new Grid { Margin = new Thickness(0, 6), ColumnDefinitions = new ColumnDefinitions("78,*") };
        caption.VerticalAlignment = VerticalAlignment.Center; caption.Margin = default; row.Children.Add(caption); Grid.SetColumn(control, 1); row.Children.Add(control); container.Children.Add(row);
    }
    protected Button ActionButton(string label, Action action)
    {
        var button = new Button { Classes = { "plain" }, Content = label, HorizontalAlignment = HorizontalAlignment.Left, Background = BellTheme.ButtonFill, Foreground = BellTheme.Ink }; button.Click += (_, _) => action(); Body.Children.Add(button); return button;
    }
}
