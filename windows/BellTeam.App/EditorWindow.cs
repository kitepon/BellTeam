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
    public Task ReadyTask => Task.WhenAll(InitialLoads);
    public EditorWindow(string title, CancellationToken parent = default)
    {
        var lifetime = CancellationTokenSource.CreateLinkedTokenSource(parent); Token = lifetime.Token;
        Closed += (_, _) => { lifetime.Cancel(); lifetime.Dispose(); };
        Title = title; Width = Math.Min(700, SystemParameters.WorkArea.Width); Height = Math.Min(800, SystemParameters.WorkArea.Height); MinWidth = 600; MinHeight = 500; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var dock = new DockPanel(); var footer = new DockPanel { Margin = new Thickness(16) };
        Actions.Children.Add(CloseButton); Actions.Children.Add(SaveButton); DockPanel.SetDock(Actions, Dock.Right); footer.Children.Add(Actions); footer.Children.Add(Status);
        DockPanel.SetDock(footer, Dock.Bottom); dock.Children.Add(footer); dock.Children.Add(new ScrollViewer { Content = Body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }); Content = dock;
        SaveButton.Click += async (_, _) => { if (SaveAction is not null) await RunAsync(SaveAction); };
        CloseButton.Click += (_, _) => Close();
        Closing += (_, args) => { if (Busy) args.Cancel = true; };
    }
    protected async Task RunAsync(Func<Task<bool>> operation)
    {
        if (Busy) return;
        Busy = true; Body.IsEnabled = Actions.IsEnabled = false; Status.Text = ""; Status.Foreground = Brushes.Firebrick;
        var close = false;
        try { close = await operation(); }
        catch (Exception error) { Status.Text = error is Core.BellApiException { Status: not null } ? error.Message : "操作の結果を確認できませんでした。現在の状態を確認してください。\n" + error.Message; }
        finally { Busy = false; Actions.IsEnabled = true; Body.IsEnabled = SaveButton.IsEnabled = !Saved; CloseButton.IsEnabled = true; if (Saved) CloseButton.Content = "閉じる"; }
        if (close) Close();
    }
    protected void Heading(string label) => Body.Children.Add(new TextBlock { Text = label, FontSize = 20, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 18, 0, 10) });
    protected TextBox TextField(string label, string value, bool multiline = false)
    {
        Body.Children.Add(new TextBlock { Text = label, FontSize = 14, Margin = new Thickness(0, 9, 0, 5) });
        var field = new TextBox { Text = value, FontSize = multiline ? 18 : 16, AcceptsReturn = multiline, TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap, MinHeight = multiline ? 80 : 0, MaxHeight = multiline ? 230 : double.PositiveInfinity, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Body.Children.Add(field); return field;
    }
    protected ComboBox Choice(string label, IEnumerable<FormOption> options, string selected)
    {
        Body.Children.Add(new TextBlock { Text = label, FontSize = 14, Margin = new Thickness(0, 9, 0, 5) });
        var combo = new ComboBox { ItemsSource = options.ToArray(), DisplayMemberPath = nameof(FormOption.Label), SelectedValuePath = nameof(FormOption.Id), SelectedValue = selected, Margin = new Thickness(0, 0, 0, 8), Padding = new Thickness(8) };
        Body.Children.Add(combo); return combo;
    }
    protected Button ActionButton(string label, Action action)
    {
        var button = new Button { Content = label, HorizontalAlignment = HorizontalAlignment.Left }; button.Click += (_, _) => action(); Body.Children.Add(button); return button;
    }
}
