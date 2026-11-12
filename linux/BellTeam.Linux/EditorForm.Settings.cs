using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Linux;

// The form building blocks the settings editors use (ported with SettingsUi); the member editors use FormUi.
public abstract partial class EditorFormView
{
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
