using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Data;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Controls.Templates;

namespace BellTeam.Linux;

public sealed record FormOption(string Id, string Label);

// More icons of the inspector and the editors, on the 24x24 canvas of Icons.Draw. The Windows Segoe glyphs have no Linux counterpart.
internal static class InspectorIcons
{
    public const string Terminal = "M3,5 H21 V19 H3 Z M7,10 L10,12.5 L7,15 M12,15 H17";
    public const string Pencil = "M4,20 L5,15 L16,4 L20,8 L9,19 Z M14,6 L18,10";
    public const string Folder = "M3,6 H10 L12,8.5 H21 V19 H3 Z";
    public const string FolderPlus = "M3,6 H10 L12,8.5 H21 V19 H3 Z M12,11.5 V16.5 M9.5,14 H14.5";
    public const string Info = "M12,3 a9,9 0 1 0 0.01,0 Z M12,11 V17 M12,7.5 V8";
    public const string CheckCircle = "M12,3 a9,9 0 1 0 0.01,0 Z M8,12.5 L11,15.5 L16.5,9.5";
    public const string Clock = "M12,3 a9,9 0 1 0 0.01,0 Z M12,7 V12 L15.5,14";
    public const string FailedCircle = "M12,3 a9,9 0 1 0 0.01,0 Z M12,7.5 V13 M12,15.8 V16.2";
    public const string Left = "M15,5 L8,12 L15,19";
    public const string Right = "M9,5 L16,12 L9,19";
    public const string Up = "M5,15 L12,8 L19,15";
    public const string Down = "M5,9 L12,16 L19,9";
    // square.stack.3d.up: three stacked layers (a chart).
    public const string Stack = "M12,3 L21,8 L12,13 L3,8 Z M3,12 L12,17 L21,12 M3,16 L12,21 L21,16";
    // sidebar.right: a window with its right pane marked.
    public const string Panel = "M3.5,5 H20.5 V19 H3.5 Z M14.5,5 V19";
    // hand.raised.fill: four fingers over a palm, drawn filled.
    public static readonly string Hand = Icons.RoundedRect(5, 3, 3, 10, 1.5) + Icons.RoundedRect(9, 1, 3, 12, 1.5) + Icons.RoundedRect(13, 2, 3, 11, 1.5) + Icons.RoundedRect(17, 5, 3, 8, 1.5) + Icons.RoundedRect(5, 10, 15, 10, 5);
}

public sealed record AlertChoice(string Label, Action? Click = null, bool Destructive = false, bool Bold = false);

// A group of the Mac Form: a white rounded card whose rows are separated by hairlines; rows can be added, hidden and removed after creation.
internal sealed class FormGroup : Border
{
    private readonly StackPanel rows = new();
    private readonly List<(Control Row, StackPanel Holder, Border Line)> items = [];
    public FormGroup() { Background = Brushes.White; CornerRadius = new CornerRadius(10); Child = rows; ClipToBounds = true; }
    public FormGroup(params Control[] initial) : this() { foreach (var row in initial) Add(row); }
    public void Add(Control row) => Insert(items.Count, row);
    public int Count => items.Count;
    public void Insert(int index, Control row)
    {
        var line = new Border { Height = 1, Background = FormUi.Hairline, Margin = new Thickness(20, 0, 0, 0) };
        var holder = new StackPanel(); holder.Children.Add(line); holder.Children.Add(row);
        rows.Children.Insert(index, holder); items.Insert(index, (row, holder, line)); Refresh();
    }
    public void Remove(Control row)
    {
        var index = items.FindIndex(item => item.Row == row); if (index < 0) return;
        rows.Children.RemoveAt(index); items.RemoveAt(index); Refresh();
    }
    public void Clear() { rows.Children.Clear(); items.Clear(); }
    // A hidden row takes its separator with it; the first row shown never has one.
    public void SetVisible(Control row, bool visible)
    {
        var index = items.FindIndex(item => item.Row == row); if (index < 0) return;
        items[index].Holder.IsVisible = visible; Refresh();
    }
    private void Refresh()
    {
        var first = true;
        foreach (var item in items)
        {
            if (!item.Holder.IsVisible) continue;
            item.Line.IsVisible = !first; first = false;
        }
    }
}

// The Mac DisclosureGroup: the chevron before the label, the body shown when open.
internal sealed class Disclosure : StackPanel
{
    private readonly Control chevron = Icons.Draw(Icons.ChevronRight, 11, FormUi.Secondary, thickness: 2.2);
    private readonly Control opened = Icons.Draw(Icons.ChevronDown, 11, FormUi.Secondary, thickness: 2.2);
    private readonly Control body;
    private bool expanded;
    public event Action<bool>? Changed;
    public Disclosure(string title, Control body, bool open)
    {
        this.body = body; body.Margin = new Thickness(19, 8, 0, 0);
        var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Background = Brushes.Transparent, Cursor = new Cursor(StandardCursorType.Hand), Focusable = true, Children = { new Grid { Width = 11, Children = { chevron, opened } }, FormUi.Text(title, 13) } };
        AutomationProperties.SetName(head, title);
        head.PointerReleased += (_, args) => { if (args.InitialPressMouseButton == MouseButton.Left) IsExpanded = !IsExpanded; };
        head.KeyDown += (_, args) => { if (args.Key is Key.Enter or Key.Space) { IsExpanded = !IsExpanded; args.Handled = true; } };
        Children.Add(head); Children.Add(body); IsExpanded = open;
    }
    public bool IsExpanded
    {
        get => expanded;
        set { var changed = expanded != value; expanded = value; body.IsVisible = value; opened.IsVisible = value; chevron.IsVisible = !value; if (changed) Changed?.Invoke(value); }
    }
}

// The building blocks of the Mac Form (windows SettingsUi): grouped cards, rows, fields and pills, on the shared Linux theme.
internal static class FormUi
{
    private static IBrush Solid(string hex) => new Avalonia.Media.Immutable.ImmutableSolidColorBrush(Color.Parse(hex));
    public static readonly IBrush Ink = BellTheme.Ink, Muted = BellTheme.Muted, Secondary = BellTheme.Secondary, Violet = BellTheme.Violet, Red = BellTheme.Red, Green = Solid("#34C759"), Orange = Solid("#FF9500");
    public static readonly IBrush FormCanvas = Solid("#F2F2F7"), Hairline = Solid("#E6E6EB");

    public static TextBlock Text(string text, double size = 13, IBrush? color = null, FontWeight weight = FontWeight.Normal, Thickness? margin = null) => BellTheme.Text(text, size, color, weight, margin);

    // bellCard(): the white rounded card of the card-style pages.
    public static Border Card(Control content) => new()
    {
        Child = content, Background = new SolidColorBrush(Color.FromArgb(0xE8, 255, 255, 255)), CornerRadius = new CornerRadius(24), Padding = new Thickness(20),
        BorderBrush = new SolidColorBrush(Color.FromArgb(0xA6, 0xE5, 0xE3, 0xF0)), BorderThickness = new Thickness(1), BoxShadow = BoxShadows.Parse("0 8 16 0 #0D21293D")
    };

    // Form-style section: small caption, a white group, a footer.
    public static StackPanel FormSection(string? header, Control group, string? footer = null)
    {
        var section = new StackPanel { Margin = new Thickness(0, 14, 0, 0) };
        if (header is not null) section.Children.Add(Text(header, 13, Secondary, FontWeight.SemiBold, new Thickness(20, 0, 0, 7)));
        section.Children.Add(group);
        if (footer is not null) section.Children.Add(Text(footer, 14, Secondary, FontWeight.Normal, new Thickness(20, 8, 20, 0)));
        return section;
    }

    public static Border Row(Control content, double minHeight = 46)
    {
        if (content.VerticalAlignment == VerticalAlignment.Stretch) content.VerticalAlignment = VerticalAlignment.Center;
        return new() { Child = content, MinHeight = minHeight, Padding = new Thickness(20, 8, 20, 8) };
    }
    public static Grid LabeledRow(string label, string value, IBrush? valueColor = null)
    {
        var grid = new Grid { VerticalAlignment = VerticalAlignment.Center, ColumnDefinitions = new ColumnDefinitions("Auto,*") };
        grid.Children.Add(Text(label, 13));
        var text = Text(value, 13, valueColor ?? Secondary); text.HorizontalAlignment = HorizontalAlignment.Right; text.TextAlignment = TextAlignment.Right; text.Margin = new Thickness(16, 0, 0, 0); Grid.SetColumn(text, 1); grid.Children.Add(text);
        return grid;
    }
    // A row that runs something: icon and label in one colour. No click means a row that cannot be used now. It answers the pointer and Enter / Space.
    public static Grid IconRow(string icon, string label, IBrush color, Action? click)
    {
        var grid = new Grid { Background = Brushes.Transparent, VerticalAlignment = VerticalAlignment.Center, Opacity = click is null ? .45 : 1, ColumnDefinitions = new ColumnDefinitions("30,*") };
        if (click is not null) grid.Cursor = new Cursor(StandardCursorType.Hand);
        var mark = Icons.Draw(icon, 16, color, thickness: 1.7); mark.HorizontalAlignment = HorizontalAlignment.Left; grid.Children.Add(mark);
        var text = Text(label, 13, color); text.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(text, 1); grid.Children.Add(text);
        AutomationProperties.SetName(grid, label);
        if (click is null) return grid;
        grid.Focusable = true;
        grid.PointerReleased += (_, args) => { if (args.InitialPressMouseButton == MouseButton.Left) click(); };
        grid.KeyDown += (_, args) => { if (args.Key is Key.Enter or Key.Space) { click(); args.Handled = true; } };
        return grid;
    }
    // A row of a grouped list that opens something: the whole row answers the pointer and Enter / Space.
    public static Border Clickable(Control content, string name, Action click)
    {
        var row = Row(content); row.Focusable = true; row.Cursor = new Cursor(StandardCursorType.Hand); row.Background = Brushes.Transparent;
        AutomationProperties.SetName(row, name);
        row.PointerReleased += (_, args) => { if (args.InitialPressMouseButton == MouseButton.Left) click(); };
        row.KeyDown += (_, args) => { if (args.Key is Key.Enter or Key.Space) { click(); args.Handled = true; } };
        return row;
    }
    // One calm line for a BellTeam without the feature; never a red banner.
    public static Control Calm(string text)
    {
        var line = new Grid { ColumnDefinitions = new ColumnDefinitions("24,*") };
        var mark = Icons.Draw(InspectorIcons.Info, 16, Secondary, thickness: 1.7); mark.HorizontalAlignment = HorizontalAlignment.Left; line.Children.Add(mark);
        var words = Text(text, 14, Secondary); Grid.SetColumn(words, 1); line.Children.Add(words); return line;
    }

    public static Button Capsule(string label, IBrush background, IBrush foreground, double radius = 16, double fontSize = 13, Thickness? padding = null)
    {
        var button = new Button { Classes = { "plain" }, Content = label, Background = background, Foreground = foreground, FontSize = fontSize, CornerRadius = new CornerRadius(radius), Padding = padding ?? new Thickness(12, 5), VerticalAlignment = VerticalAlignment.Center };
        AutomationProperties.SetName(button, label); return button;
    }

    // Borderless text box whose hint is the field label, as in a Mac Form TextField.
    public static (TextBox Element, TextBox Box) Field(string hint, string value, bool multiline = false, double minHeight = 0)
    {
        var box = new TextBox
        {
            Classes = { "bare" }, Text = value, FontSize = 13, Foreground = Ink, CaretBrush = Ink, PlaceholderText = hint, PlaceholderForeground = Secondary, AcceptsReturn = multiline,
            TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap, MinHeight = minHeight, VerticalContentAlignment = VerticalAlignment.Top, VerticalAlignment = VerticalAlignment.Center
        };
        if (multiline) ScrollViewer.SetVerticalScrollBarVisibility(box, ScrollBarVisibility.Auto);
        AutomationProperties.SetName(box, hint);
        return (box, box);
    }

    // Fluent paints checked boxes and sliders in the system accent (blue): these controls carry the BellTeam violet instead.
    public static T Violetize<T>(T control) where T : Control
    {
        foreach (var key in new[] { "CheckBoxCheckBackgroundFillChecked", "CheckBoxCheckBackgroundFillCheckedPointerOver", "CheckBoxCheckBackgroundFillCheckedPressed", "CheckBoxCheckBackgroundStrokeChecked", "CheckBoxCheckBackgroundStrokeCheckedPointerOver", "CheckBoxCheckBackgroundStrokeCheckedPressed",
            "SliderThumbBackground", "SliderThumbBackgroundPointerOver", "SliderThumbBackgroundPressed", "SliderTrackValueFill", "SliderTrackValueFillPointerOver", "SliderTrackValueFillPressed" }) control.Resources[key] = Violet;
        return control;
    }

    // ---- editor form blocks ----
    public static Button LinkButton(string label, Action click, bool enabled = true, bool destructive = false)
    {
        var button = new Button { Classes = { "plain" }, Content = label, HorizontalAlignment = HorizontalAlignment.Left, Padding = default, Background = Brushes.Transparent, FontSize = 13, FontWeight = FontWeight.Normal, Foreground = destructive ? Red : Violet, IsEnabled = enabled };
        button.Click += (_, _) => click(); AutomationProperties.SetName(button, label); return button;
    }
    public static Border Note(string text, IBrush? color = null, double size = 13) => Row(Text(text, size, color ?? Secondary));
    public static Border Labeled(string label, Control control, double labelWidth = 0)
    {
        var grid = new Grid { VerticalAlignment = VerticalAlignment.Center, ColumnDefinitions = [new ColumnDefinition(labelWidth > 0 ? new GridLength(labelWidth) : GridLength.Auto), new ColumnDefinition(GridLength.Star)] };
        var caption = Text(label, 13); caption.VerticalAlignment = VerticalAlignment.Center; grid.Children.Add(caption);
        control.HorizontalAlignment = HorizontalAlignment.Right; control.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(control, 1); grid.Children.Add(control); return Row(grid);
    }
    public static ComboBox Popup(string label, IEnumerable<FormOption> options, string? selected)
    {
        var combo = new ComboBox { FontSize = 13, Padding = new Thickness(10, 5), MinWidth = 140, MaxWidth = 360, ItemTemplate = new FuncDataTemplate<FormOption>((option, _) => new TextBlock { Text = option.Label }) };
        SetOptions(combo, options); SelectId(combo, selected);
        AutomationProperties.SetName(combo, label); return combo;
    }
    public static void SetOptions(this ComboBox box, IEnumerable<FormOption> options) => box.ItemsSource = options.ToArray();
    public static string? SelectedId(this ComboBox box) => (box.SelectedItem as FormOption)?.Id;
    public static void SelectId(this ComboBox box, string? id) => box.SelectedItem = id is null ? null : (box.ItemsSource as IEnumerable<FormOption>)?.FirstOrDefault(option => option.Id == id);
    // Mac Form multi-line field: the caption above, up to seven lines of text.
    public static (Border Row, TextBox Box) Paragraph(string caption, string value, bool captionShown = true)
    {
        var (element, box) = Field(caption, value, multiline: true, minHeight: 48); box.MaxHeight = 150;
        var stack = new StackPanel();
        if (captionShown) stack.Children.Add(Text(caption, 11, Muted, FontWeight.SemiBold, new Thickness(0, 0, 0, 6)));
        stack.Children.Add(element); return (Row(stack), box);
    }
}
