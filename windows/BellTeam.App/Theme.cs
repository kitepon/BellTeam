using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Win32;

namespace BellTeam.App;

// Every colour that differs between the light and the dark appearance. Light values are the colours the app always had;
// dark values are the Mac system dark colours (black grouped background, #1C1C1E cards, white primary text, grey secondary text)
// seen in the Mac component renders 60/61. The app's own palette (violet, mint, accent bubbles, the key bar) is the same in both.
// Brushes are not frozen, so changing the colour of one updates every element that uses it; they live per thread
// because an unfrozen brush cannot cross threads (tests build views on their own threads without an Application).
internal static class Palette
{
    private static readonly (string Key, string Light, string Dark)[] Solids =
    [
        ("Ink", "#21293D", "#FFFFFF"), ("Muted", "#787D91", "#9A9EB3"), ("Secondary", "#8A8A8E", "#98989F"), ("Placeholder", "#C4C4C8", "#636366"),
        ("Violet", "#6147D4", "#6147D4"), ("Mint", "#2EB39E", "#2EB39E"), ("Red", "#FF3B30", "#FF453A"), ("Green", "#34C759", "#30D158"), ("Orange", "#FF9500", "#FF9F0A"),
        ("Line", "#E5E3F0", "#3A3A3E"), ("Canvas", "#F8F8FB", "#121214"), ("Card", "#FFFFFF", "#1C1C1E"), ("Grouped", "#F2F2F7", "#000000"),
        ("Hairline", "#E6E6EB", "#3E3E41"), ("Fill", "#F0F0F4", "#2C2C2E"), ("Sidebar", "#F1EDFC", "#1B1A28"), ("Material", "#E9E7E6", "#26262A"),
        ("Offline", "#E5E3F0", "#48484A"), ("InspectorFill", "#99FFFFFF", "#99101012"), ("InspectorLine", "#E0DBE8", "#3A3A3E"),
        ("SearchFill", "#EFFFFFFF", "#EF2C2C2E"), ("RowText", "#000000", "#FFFFFF"), ("ScrollTrack", "#00000000", "#0DFFFFFF"), ("ScrollThumb", "#00000000", "#59FFFFFF"), ("UpdateBadge", "#E4DDFB", "#3B3270"), ("OrangeText", "#C77700", "#FFB340"), ("Ring", "#FFFFFF", "#1B1A28"), ("ToolbarFill", "#1F767680", "#4D767680"), ("Lilac", "#A6E8E0FF", "#3D6147D4"), ("LilacSoft", "#BFE8E0FF", "#3D6147D4"),
        ("RowHover", "#66FFFFFF", "#26FFFFFF"), ("RowSelected", "#FFFFFF", "#2C2C2E"),
        ("BorderedButton", "#D8D8DD", "#3A3A3E"), ("SheetPill", "#80FFFFFF", "#26FFFFFF"), ("SheetPillHover", "#CCFFFFFF", "#40FFFFFF"), ("SheetPillLine", "#C9C4DE", "#4A4860"),
        ("SliderTrack", "#E3E3E8", "#3A3A3C"), ("SwitchOff", "#E5E5EA", "#39393D"), ("Segment", "#E3E3E8", "#2C2C2E"), ("SegmentOn", "#FFFFFF", "#636366"),
        ("SaveDisabled", "#E9E9EE", "#2C2C2E"), ("PanelFill", "#E8FFFFFF", "#E81C1C1E"), ("PanelLine", "#A6E5E3F0", "#A63A3A3E"), ("PillFill", "#E0F6F6F9", "#E02C2C2E"),
        ("BubbleOut", "#FFFFFF", "#2C2C2E"), ("BubbleOutLine", "#E5E3F0", "#3A3A3E"), ("Glass", "#BFFFFFFF", "#802C2C2E"), ("GlassCard", "#E6FFFFFF", "#E61C1C1E"),
        ("CodeFill", "#EFEDF4", "#2C2C2E"), ("CodeInline", "#E6E6FA", "#34304F"), ("QuoteLine", "#D8BFD8", "#5A4F8A"), ("TableLine", "#D3D3D3", "#48484A"),
        ("Link", "#7661AB", "#A596E0"), ("Danger", "#B22222", "#FF6961"), ("Subtle", "#708090", "#98989F"), ("Gray", "#808080", "#98989F"), 
        ("CropFill", "#F2F2F7", "#1C1C1E"), ("ButtonFill", "#E4E3E8", "#3A3A3E"), 
        ("ProminentFill", "#5642C9", "#5642C9"), 
        ("CardLine", "#14000000", "#33FFFFFF"), ("PressTint", "#14000000", "#1FFFFFFF"), ("StackVeil", "#47FFFFFF", "#1AFFFFFF"), ("FrameCard", "#F6F6F8", "#2C2C2E"), ("MenuFill", "#FFFFFF", "#2C2C2E"), ("MenuHover", "#F1EDFC", "#3A3A3E")
    ];
    private static readonly (string Key, string[] Light, string[] Dark, double[] Offsets)[] Gradients =
    [
        ("ConversationBackground", ["#F1ECFF", "#F8F8FB", "#FFFFFF"], ["#1E1A33", "#101014", "#0A0A0D"], [0, 0.55, 1]),
        ("StartupBackground", ["#ECE6FE", "#F8F8FB", "#FFFFFF"], ["#1E1A33", "#101014", "#0A0A0D"], [0, 0.5, 1])
    ];

    private static readonly (Type Control, string Style)[] DarkStyles = [(typeof(System.Windows.Controls.Primitives.ScrollBar), "DarkScrollBar"), (typeof(System.Windows.Controls.DatePicker), "DarkDatePicker")];
    [ThreadStatic] private static Dictionary<string, Brush>? brushes;
    [ThreadStatic] private static bool dark;
    [ThreadStatic] private static ResourceDictionary? installed;

    public static bool IsDark => dark;

    private static Dictionary<string, Brush> Table()
    {
        if (brushes is not null) return brushes;
        var made = new Dictionary<string, Brush>();
        foreach (var (key, light, darkColor) in Solids) made[key] = new SolidColorBrush(Parse(dark ? darkColor : light));
        foreach (var (key, light, darkColors, offsets) in Gradients)
        {
            var stops = new GradientStopCollection(); var colors = dark ? darkColors : light;
            for (var index = 0; index < colors.Length; index++) stops.Add(new GradientStop(Parse(colors[index]), offsets[index]));
            made[key] = new LinearGradientBrush(stops, new Point(0, 0), new Point(1, 1));
        }
        return brushes = made;
    }

    public static Color Parse(string hex) => (Color)ColorConverter.ConvertFromString(hex);

    // Throws for an unknown key: a typo must not silently draw nothing.
    public static Brush Get(string key) => Table()[key];
    public static IEnumerable<string> Keys => Solids.Select(item => item.Key).Concat(Gradients.Select(item => item.Key));

    public static Brush Ink => Get("Ink");
    public static Brush Muted => Get("Muted");
    public static Brush Secondary => Get("Secondary");
    public static Brush Card => Get("Card");

    // XAML reaches the colours by key. The Application dictionary freezes what it holds (it is readable from any thread), so it gets
    // frozen copies, and each Apply replaces them, which refreshes every DynamicResource; code-built UI holds the unfrozen brushes above.
    public static void Install(ResourceDictionary resources) { installed = resources; Publish(); }
    private static void Publish()
    {
        if (installed is null) return;
        foreach (var (key, brush) in Table()) { var copy = brush.CloneCurrentValue(); copy.Freeze(); installed[key] = copy; }
        // Controls whose system look is always light get a dark implicit style only in dark; light keeps the system style untouched.
        // A dictionary without Theme.xaml (a unit test) has no such styles to swap in.
        foreach (var (type, key) in DarkStyles)
        {
            if (dark && installed[key] is Style style) installed[type] = style;
            else installed.Remove(type);
        }
    }

    public static void Apply(bool useDark)
    {
        dark = useDark;
        foreach (var (key, light, darkColor) in Solids) ((SolidColorBrush)Table()[key]).Color = Parse(useDark ? darkColor : light);
        foreach (var (key, light, darkColors, _) in Gradients)
        {
            var stops = ((LinearGradientBrush)Table()[key]).GradientStops; var colors = useDark ? darkColors : light;
            for (var index = 0; index < colors.Length; index++) stops[index].Color = Parse(colors[index]);
        }
        Publish();
    }
}

// Follows the Windows app mode (Settings > Personalization > Colors > "Choose your default app mode"). The app never writes an OS setting.
internal static class AppTheme
{
    private const string PersonalizeKey = @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    private const string AppsUseLightTheme = "AppsUseLightTheme";
    private const int UseImmersiveDarkMode = 20;
    private static bool started;

    // Registry value 0 means dark; 1, a missing value or anything unreadable means light (the Windows default).
    public static bool IsDark(object? appsUseLightTheme) => appsUseLightTheme is int value && value == 0;
    public static bool ReadSystemDark() => IsDark(Registry.GetValue(PersonalizeKey, AppsUseLightTheme, null));

    // renderTheme is only given by the render entry points ("dark" or "light"); a real run follows the system and its changes.
    public static void Start(string? renderTheme = null)
    {
        if (started) return; started = true;
        if (Application.Current is { } app) Palette.Install(app.Resources);
        EventManager.RegisterClassHandler(typeof(Window), FrameworkElement.LoadedEvent, new RoutedEventHandler((sender, _) => ApplyTitleBar((Window)sender)));
        if (renderTheme is not null) { Set(renderTheme == "dark"); return; }
        Set(ReadSystemDark());
        // SystemEvents raises on its own thread; "ImmersiveColorSet" arrives as a General preference change.
        var dispatcher = Application.Current.Dispatcher;
        SystemEvents.UserPreferenceChanged += (_, change) => { if (change.Category == UserPreferenceCategory.General) dispatcher.BeginInvoke(() => Set(ReadSystemDark())); };
    }

    public static void Set(bool dark)
    {
        Palette.Apply(dark);
        if (Application.Current is { } app) foreach (Window window in app.Windows) ApplyTitleBar(window);
    }

    private static void ApplyTitleBar(Window window)
    {
        if (new WindowInteropHelper(window).Handle is var handle && handle != IntPtr.Zero)
        {
            var value = Palette.IsDark ? 1 : 0;
            DwmSetWindowAttribute(handle, UseImmersiveDarkMode, ref value, sizeof(int));
        }
    }

    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
}
