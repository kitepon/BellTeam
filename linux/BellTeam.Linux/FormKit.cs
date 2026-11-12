using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Presenters;
using Avalonia.Controls.Primitives;
using Avalonia.Controls.Templates;
using Avalonia.Data;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;

namespace BellTeam.Linux;


// The pieces of the Mac grouped Form that Windows keeps in SettingsUi and EditorFormView: caption, white group with hairlines, rows, fields, switch, pop-up.
internal static class FormKit
{
    private static IBrush Solid(string hex) => new Avalonia.Media.Immutable.ImmutableSolidColorBrush(Color.Parse(hex));
    public static readonly IBrush Canvas = Solid("#F2F2F7"), Hairline = Solid("#E6E6EB"), Fill = Solid("#F0F0F4"), Green = Solid("#34C759"), DisabledGrey = Solid("#C7C7CC");

    public static TextBlock Text(string text, double size = 13, IBrush? color = null, FontWeight weight = FontWeight.Normal, Thickness? margin = null) => BellTheme.Text(text, size, color, weight, margin);

    public static Border Row(Control content, double minHeight = 46)
    {
        if (content.VerticalAlignment == VerticalAlignment.Stretch) content.VerticalAlignment = VerticalAlignment.Center;
        return new Border { Child = content, MinHeight = minHeight, Padding = new Thickness(20, 8) };
    }

    // Form-style section: small caption, a white group, a footer.
    public static StackPanel Section(string? header, Control group, string? footer = null)
    {
        var section = new StackPanel { Margin = new Thickness(0, 14, 0, 0) };
        if (header is not null) section.Children.Add(Text(header, 13, BellTheme.Secondary, FontWeight.SemiBold, new Thickness(20, 0, 0, 7)));
        section.Children.Add(group);
        if (footer is not null) section.Children.Add(Text(footer, 14, BellTheme.Secondary, margin: new Thickness(20, 8, 20, 0)));
        return section;
    }

    public static Border Note(string text, IBrush? color = null, double size = 13) => Row(Text(text, size, color ?? BellTheme.Secondary));

    public static Border Labeled(string label, Control control, double labelWidth = 0)
    {
        var grid = new Grid { VerticalAlignment = VerticalAlignment.Center, ColumnDefinitions = new ColumnDefinitions(labelWidth > 0 ? $"{labelWidth},*" : "Auto,*") };
        var caption = Text(label, 13); caption.VerticalAlignment = VerticalAlignment.Center; grid.Children.Add(caption);
        control.HorizontalAlignment = HorizontalAlignment.Right; control.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(control, 1); grid.Children.Add(control); return Row(grid);
    }

    // Borderless text box whose hint is the field label, as in a Mac Form TextField.
    public static TextBox Field(string hint, string value, bool multiline = false, double minHeight = 0, double fontSize = 13)
    {
        var box = new TextBox
        {
            Classes = { "bare" }, Text = value, FontSize = fontSize, PlaceholderText = hint, PlaceholderForeground = BellTheme.Secondary, AcceptsReturn = multiline, TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap,
            MinHeight = minHeight, VerticalContentAlignment = multiline ? VerticalAlignment.Top : VerticalAlignment.Center, VerticalAlignment = VerticalAlignment.Center
        };
        if (multiline) ScrollViewer.SetVerticalScrollBarVisibility(box, ScrollBarVisibility.Auto);
        AutomationProperties.SetName(box, hint); return box;
    }

    public static Button Capsule(string label, IBrush background, IBrush foreground, double radius = 16, double fontSize = 13, Thickness? padding = null)
    {
        var button = new Button { Classes = { "plain" }, Content = label, Background = background, Foreground = foreground, FontSize = fontSize, FontWeight = FontWeight.SemiBold, Padding = padding ?? new Thickness(12, 5), CornerRadius = new CornerRadius(radius), HorizontalContentAlignment = HorizontalAlignment.Center, VerticalContentAlignment = VerticalAlignment.Center };
        AutomationProperties.SetName(button, label); return button;
    }

    public static Button LinkButton(string label, Action click, bool enabled = true, bool destructive = false)
    {
        var button = new Button { Classes = { "plain" }, Content = label, HorizontalAlignment = HorizontalAlignment.Left, Padding = default, Background = Brushes.Transparent, FontSize = 13, FontWeight = FontWeight.Normal, Foreground = destructive ? BellTheme.Red : BellTheme.Violet, IsEnabled = enabled };
        button.Click += (_, _) => click(); AutomationProperties.SetName(button, label); return button;
    }

    public static FormPopup Popup(string label, IEnumerable<FormOption> options, string? selected)
    {
        var popup = new FormPopup(options.ToArray(), selected) { FontSize = 13, Padding = new Thickness(10, 5), MinWidth = 140, MaxWidth = 360, Background = Brushes.White, BorderBrush = BellTheme.Line, CornerRadius = new CornerRadius(9) };
        AutomationProperties.SetName(popup, label); return popup;
    }

    // Runs when the text changes, at once: TextBox.TextChanged is raised later than the property, so a render seam or a test that sets Text and goes on would see stale state.
    public static void OnText(this TextBox box, Action changed) => box.PropertyChanged += (_, change) => { if (change.Property == TextBox.TextProperty) changed(); };

    public static IosSwitch Switch(IBrush? on = null) => new(on ?? Green);

    // The Mac alert: a title, a message and stacked buttons. Any button dismisses first, then runs its action.
    public static Border AlertFrame(string title, string message, Action dismiss, params AlertChoice[] choices)
    {
        var card = new StackPanel { Width = 300 };
        var heading = Text(title, 14, BellTheme.Ink, FontWeight.SemiBold, new Thickness(20, 18, 20, message.Length == 0 ? 16 : 0)); heading.TextAlignment = TextAlignment.Center; card.Children.Add(heading);
        if (message.Length != 0) { var detail = Text(message, 12, BellTheme.Ink, margin: new Thickness(20, 6, 20, 16)); detail.TextAlignment = TextAlignment.Center; card.Children.Add(detail); }
        foreach (var choice in choices)
        {
            var button = new Button
            {
                Classes = { "plain" }, Content = choice.Label, Background = Brushes.Transparent, BorderBrush = Hairline, BorderThickness = new Thickness(0, 1, 0, 0), CornerRadius = default, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Center,
                Foreground = choice.Destructive ? BellTheme.Red : BellTheme.Violet, FontSize = 14, FontWeight = choice.Bold ? FontWeight.SemiBold : FontWeight.Normal, Padding = new Thickness(0, 11)
            };
            AutomationProperties.SetName(button, choice.Label);
            button.Click += (_, _) => { dismiss(); choice.Click?.Invoke(); };
            card.Children.Add(button);
        }
        var frame = new Border { Child = card, Background = Solid("#F6F6F8"), CornerRadius = new CornerRadius(14), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, ClipToBounds = true, BoxShadow = BoxShadows.Parse("0 6 24 0 #4D000000") };
        AutomationProperties.SetName(frame, title); return frame;
    }
}


// A ComboBox over FormOption ids (Windows: SelectedValuePath Id).
internal sealed class FormPopup : ComboBox
{
    private readonly FormOption[] options;
    public FormPopup(FormOption[] options, string? selected)
    {
        this.options = options; ItemsSource = options;
        ItemTemplate = new FuncDataTemplate<FormOption>((option, _) => new TextBlock { Text = option?.Label ?? "", FontSize = 13 });
        SelectedId = selected;
    }
    protected override Type StyleKeyOverride => typeof(ComboBox);
    public string? SelectedId
    {
        get => (SelectedItem as FormOption)?.Id;
        set => SelectedItem = options.FirstOrDefault(option => option.Id == value);
    }
}

// The Mac switch: a 42x26 track and a white knob; on is green.
internal sealed class IosSwitch : ToggleButton
{
    private readonly IBrush onColor;
    private Border? track;
    private Avalonia.Controls.Shapes.Ellipse? knob;
    public IosSwitch(IBrush on)
    {
        onColor = on; Cursor = new Cursor(StandardCursorType.Hand); VerticalAlignment = VerticalAlignment.Center; Padding = default;
        Template = new FuncControlTemplate<IosSwitch>((_, scope) =>
        {
            var line = new Border { CornerRadius = new CornerRadius(13), Background = Brushes.LightGray };
            var dot = new Avalonia.Controls.Shapes.Ellipse { Width = 22, Height = 22, Fill = Brushes.White, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(2, 0, 0, 0) };
            scope.Register("Track", line); scope.Register("Knob", dot);
            return new Grid { Width = 42, Height = 26, Children = { line, dot } };
        });
    }
    protected override Type StyleKeyOverride => typeof(ToggleButton);
    protected override void OnApplyTemplate(TemplateAppliedEventArgs e)
    {
        base.OnApplyTemplate(e);
        track = e.NameScope.Find<Border>("Track"); knob = e.NameScope.Find<Avalonia.Controls.Shapes.Ellipse>("Knob"); Sync();
    }
    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property == IsCheckedProperty || change.Property == IsEnabledProperty) Sync();
    }
    private void Sync()
    {
        if (track is null || knob is null) return;
        var on = IsChecked == true;
        track.Background = on ? onColor : new Avalonia.Media.Immutable.ImmutableSolidColorBrush(Color.Parse("#E5E5EA"));
        knob.HorizontalAlignment = on ? HorizontalAlignment.Right : HorizontalAlignment.Left; knob.Margin = on ? new Thickness(0, 0, 2, 0) : new Thickness(2, 0, 0, 0);
        track.Opacity = knob.Opacity = IsEnabled ? 1 : .5;
    }
}

