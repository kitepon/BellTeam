using System.Windows;
using System.Windows.Controls;

namespace BellTeam.App;

public sealed class ConfirmationWindow : Window
{
    public ConfirmationWindow(string title, string message, string accept)
    {
        Title = title; Width = 520; SizeToContent = SizeToContent.Height; MaxHeight = SystemParameters.WorkArea.Height; WindowStartupLocation = WindowStartupLocation.CenterOwner; ResizeMode = ResizeMode.NoResize;
        var body = new StackPanel { Margin = new Thickness(24) };
        body.Children.Add(new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap, FontSize = 18, Margin = new Thickness(0, 0, 0, 18) });
        var actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        var cancel = new Button { Content = "キャンセル", IsCancel = true }; cancel.Click += (_, _) => Close();
        var confirm = new Button { Content = accept }; confirm.Click += (_, _) => DialogResult = true;
        actions.Children.Add(cancel); actions.Children.Add(confirm); body.Children.Add(actions); Content = body;
    }
}
