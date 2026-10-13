using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using BellTeam.Core;

namespace BellTeam.App;

public partial class MainWindow : Window
{
    private readonly Workspace model;
    private bool inspectorVisible = true;
    public MainWindow(Workspace model, bool persistPlacement = true)
    {
        this.model = model;
        InitializeComponent();
        DataContext = model;
        model.ScrollToBottom += force =>
        {
            if (force || MessageScroll.ScrollableHeight - MessageScroll.VerticalOffset < 80)
                Dispatcher.BeginInvoke(() => MessageScroll.ScrollToEnd());
        };
        model.PropertyChanged += (_, args) =>
        {
            if (args.PropertyName == nameof(Workspace.IsRoom) && inspectorVisible)
                InspectorColumn.Width = model.IsRoom ? new GridLength(280) : new GridLength(1, GridUnitType.Star);
        };
        PreviewKeyDown += Window_KeyDown;
        if (persistPlacement)
        {
            var placement = new SettingsStore(SettingsStore.UserDirectory).Load().Window;
            if (placement is not null)
            {
                Width = Math.Max(MinWidth, placement.Width); Height = Math.Max(MinHeight, placement.Height);
                Left = placement.Left; Top = placement.Top;
                var desktop = new Rect(SystemParameters.VirtualScreenLeft, SystemParameters.VirtualScreenTop, SystemParameters.VirtualScreenWidth, SystemParameters.VirtualScreenHeight);
                if (!desktop.IntersectsWith(new Rect(Left, Top, Width, Height))) { Left = desktop.Left + 30; Top = desktop.Top + 30; }
                WindowStartupLocation = WindowStartupLocation.Manual;
                if (placement.Maximized) WindowState = WindowState.Maximized;
            }
            Closing += (_, _) =>
            {
                var store = new SettingsStore(SettingsStore.UserDirectory);
                var bounds = RestoreBounds;
                try { store.Save(store.Load() with { Window = new(bounds.Left, bounds.Top, bounds.Width, bounds.Height, WindowState == WindowState.Maximized) }); }
                catch (Exception error) { MessageBox.Show(this, "窓の位置を保存できませんでした。" + error.Message, "BellTeam"); }
            };
        }
    }
    private async void Conversation_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (ConversationList.SelectedItem is ConversationEntry entry && model.Selected?.Target != entry.Target)
            await model.SelectAsync(entry);
    }
    private async void Send_Click(object sender, RoutedEventArgs e) => await model.SendAsync();
    private async void Older_Click(object sender, RoutedEventArgs e) => await model.LoadOlderAsync();
    private async void Reconnect_Click(object sender, RoutedEventArgs e) => await model.ReconnectAsync();
    private void Connection_Click(object sender, RoutedEventArgs e) => OpenConnectionSettings();
    public void OpenConnectionSettings()
    {
        var dialog = new ConnectionWindow(model.Server) { Owner = this };
        if (dialog.ShowDialog() == true) _ = model.ConnectAsync(dialog.Address);
    }
    private void Inspector_Click(object sender, RoutedEventArgs e) => ToggleInspector();
    private void ToggleInspector()
    {
        inspectorVisible = !inspectorVisible;
        Inspector.Visibility = inspectorVisible ? Visibility.Visible : Visibility.Collapsed;
        InspectorColumn.MinWidth = inspectorVisible ? 280 : 0;
        InspectorColumn.Width = inspectorVisible ? model.IsRoom ? new GridLength(280) : new GridLength(1, GridUnitType.Star) : new GridLength(0);
    }
    private void Window_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.K && Keyboard.Modifiers == ModifierKeys.Control) { SearchBox.Focus(); SearchBox.SelectAll(); e.Handled = true; }
        if (e.Key == Key.I && Keyboard.Modifiers == (ModifierKeys.Control | ModifierKeys.Shift)) { ToggleInspector(); e.Handled = true; }
    }
    private async void Composer_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Keyboard.Modifiers == ModifierKeys.None)
        {
            // 日本語IMEの変換確定はKey.ImeProcessedとなるため、ここでは送信しない。
            e.Handled = true;
            await model.SendAsync();
        }
    }
}

internal sealed class ConnectionWindow : Window
{
    private readonly TextBox input;
    public string Address { get; private set; } = "";
    public ConnectionWindow(string address)
    {
        Title = "接続先"; Width = 570; Height = 280; ResizeMode = ResizeMode.NoResize; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var panel = new StackPanel { Margin = new Thickness(24) };
        panel.Children.Add(new TextBlock { Text = "接続先URL", FontWeight = FontWeights.SemiBold, FontSize = 18, Margin = new Thickness(0, 0, 0, 10) });
        input = new TextBox { Text = address };
        panel.Children.Add(input);
        panel.Children.Add(new TextBlock { Text = "HTTPS、またはlocalhost・LANのHTTP接続先URL", Margin = new Thickness(0, 8, 0, 8), TextWrapping = TextWrapping.Wrap });
        var errorText = new TextBlock { Foreground = System.Windows.Media.Brushes.Firebrick, TextWrapping = TextWrapping.Wrap };
        panel.Children.Add(errorText);
        var save = new Button { Content = "接続", IsDefault = true, HorizontalAlignment = HorizontalAlignment.Right };
        save.Click += (_, _) =>
        {
            try
            {
                var origin = ServerOrigin.Parse(input.Text);
                var store = new SettingsStore(SettingsStore.UserDirectory);
                store.Save(store.Load() with { ServerUrl = origin.AbsoluteUri });
                Address = origin.AbsoluteUri;
                DialogResult = true;
            }
            catch (Exception error) { errorText.Text = error.Message; }
        };
        panel.Children.Add(save); Content = panel;
    }
}
