using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace BellTeam.App;

public sealed record FormOption(string Id, string Label);

public class EditorWindow : Window
{
    protected readonly StackPanel Body = new() { Margin = new Thickness(24) };
    protected readonly TextBlock Status = new() { TextWrapping = TextWrapping.Wrap, Foreground = Brushes.Firebrick, Margin = new Thickness(8), FontSize = 14 };
    protected readonly Button SaveButton = new() { Content = "保存" };
    protected readonly Button CloseButton = new() { Content = "キャンセル" };
    protected readonly StackPanel Actions = new() { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
    protected Func<Task<bool>>? SaveAction;
    protected bool Busy { get; private set; }
    protected bool Saved { get; set; }
    protected CancellationToken Token { get; }
    protected readonly List<Task> InitialLoads = [];
    protected Window DialogOwner => Owner ?? this;
    private Action? closePage;
    private bool closeWhileReading;
    public bool CanNavigateAway => !Busy || closeWhileReading;
    private readonly ScrollViewer scroller = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    public Task ReadyTask => Task.WhenAll(InitialLoads);
    public void ScrollToEndForRender() { scroller.ScrollToEnd(); scroller.UpdateLayout(); }
    public EditorWindow(string title, CancellationToken parent = default)
    {
        SetResourceReference(StyleProperty, typeof(Window)); SetResourceReference(BackgroundProperty, "ConversationBackground");
        var lifetime = CancellationTokenSource.CreateLinkedTokenSource(parent); Token = lifetime.Token;
        Closed += (_, _) => { lifetime.Cancel(); lifetime.Dispose(); };
        Title = title; Width = Math.Min(700, SystemParameters.WorkArea.Width); Height = Math.Min(800, SystemParameters.WorkArea.Height); MinWidth = 600; MinHeight = 500; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var dock = new DockPanel(); var footer = new DockPanel { Margin = new Thickness(16) };
        var statusStyle = new Style(typeof(TextBlock)); statusStyle.Triggers.Add(new Trigger { Property = TextBlock.TextProperty, Value = "", Setters = { new Setter(VisibilityProperty, Visibility.Collapsed) } }); Status.Style = statusStyle;
        Actions.Children.Add(CloseButton); Actions.Children.Add(SaveButton); DockPanel.SetDock(Actions, Dock.Right); footer.Children.Add(Actions); footer.Children.Add(Status);
        SaveButton.SetResourceReference(StyleProperty, "PrimaryButton");
        DockPanel.SetDock(footer, Dock.Bottom); dock.Children.Add(footer); scroller.Content = Body; dock.Children.Add(scroller); Content = dock;
        SaveButton.Click += async (_, _) => { if (SaveAction is not null) await RunAsync(SaveAction); };
        CloseButton.Click += (_, _) => { if (closePage is { } returnToConversation) returnToConversation(); else Close(); };
        Closing += (_, args) => { if (!CanNavigateAway) args.Cancel = true; };
    }
    public FrameworkElement AsPage(Action close)
    {
        closePage = close; var content = (FrameworkElement)Content; Content = null;
        Body.MaxWidth = 850; Body.HorizontalAlignment = HorizontalAlignment.Stretch;
        Actions.Visibility = Visibility.Collapsed;
        return content;
    }
    protected async Task RunAsync(Func<Task<bool>> operation, bool canClose = false)
    {
        if (Busy) return;
        closeWhileReading = canClose;
        Busy = true; Body.IsEnabled = Actions.IsEnabled = false; Status.Text = ""; Status.Foreground = Brushes.Firebrick;
        var close = false;
        try { close = await operation(); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception error) { Status.Text = error is Core.BellApiException { Status: not null } ? error.Message : "操作の結果を確認できませんでした。現在の状態を確認してください。\n" + error.Message; }
        finally { Busy = false; Actions.IsEnabled = true; Body.IsEnabled = SaveButton.IsEnabled = !Saved; CloseButton.IsEnabled = true; if (Saved) CloseButton.Content = "閉じる"; }
        if (close) Close();
    }
    protected void Heading(string label) => Body.Children.Add(new TextBlock { Text = label, FontSize = 20, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 18, 0, 10) });
    protected StackPanel Section(string label)
    {
        Body.Children.Add(new TextBlock { Text = label, FontSize = 14, FontWeight = FontWeights.SemiBold, Foreground = Brushes.SlateGray, Margin = new Thickness(16, 22, 0, 10) });
        var fields = new StackPanel(); Body.Children.Add(new Border { Child = fields, Background = Brushes.White, CornerRadius = new CornerRadius(18), BorderBrush = new SolidColorBrush(Color.FromRgb(229, 227, 240)), BorderThickness = new Thickness(1), Padding = new Thickness(18) }); return fields;
    }
    protected TextBox TextField(string label, string value, bool multiline = false, Panel? parent = null, bool inlineLabel = false)
    {
        var container = parent ?? Body;
        var field = new TextBox { Text = value, FontSize = multiline ? 18 : 16, AcceptsReturn = multiline, TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap, MinHeight = multiline ? 80 : 0, MaxHeight = multiline ? 230 : double.PositiveInfinity, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        AddField(container, label, field, inlineLabel); return field;
    }
    protected ComboBox Choice(string label, IEnumerable<FormOption> options, string selected, Panel? parent = null, bool inlineLabel = false)
    {
        var container = parent ?? Body;
        var combo = new ComboBox { ItemsSource = options.ToArray(), DisplayMemberPath = nameof(FormOption.Label), SelectedValuePath = nameof(FormOption.Id), SelectedValue = selected, Margin = new Thickness(0, 0, 0, 8), Padding = new Thickness(8) };
        AddField(container, label, combo, inlineLabel); return combo;
    }
    private static void AddField(Panel container, string label, Control control, bool inline)
    {
        System.Windows.Automation.AutomationProperties.SetName(control, label);
        var caption = new TextBlock { Text = label, FontSize = 14, Foreground = Brushes.SlateGray, Margin = new Thickness(0, 9, 0, 5) };
        if (!inline) { container.Children.Add(caption); container.Children.Add(control); return; }
        var row = new Grid { Margin = new Thickness(0, 6, 0, 6) }; row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(78) }); row.ColumnDefinitions.Add(new ColumnDefinition());
        caption.VerticalAlignment = VerticalAlignment.Center; caption.Margin = new Thickness(0); row.Children.Add(caption); Grid.SetColumn(control, 1); row.Children.Add(control); container.Children.Add(row);
    }
    protected Button ActionButton(string label, Action action)
    {
        var button = new Button { Content = label, HorizontalAlignment = HorizontalAlignment.Left }; button.Click += (_, _) => action(); Body.Children.Add(button); return button;
    }
}
