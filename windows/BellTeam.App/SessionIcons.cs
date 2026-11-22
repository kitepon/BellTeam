using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using Path = System.Windows.Shapes.Path;

namespace BellTeam.App;

// The sessions screen icons (apple/sessions-screen.md): apple, linux, windows and android are the shared SVG files (embedded, one 24x24 path each, drawn natively); web and console use
// the Segoe Fluent glyphs the reference names (Globe E774, CommandPrompt E756).
internal static partial class SessionIcons
{
    [GeneratedRegex("<path d=\"([^\"]+)\"")] private static partial Regex PathData();
    public static Geometry Geometry(string key) => System.Windows.Media.Geometry.Parse(PathData().Match(EmbeddedAsset.Text("sessions-icons/" + key + ".svg")) is { Success: true } match ? match.Groups[1].Value : throw new InvalidOperationException(key + ".svg に path がありません。"));
    // A 32 pt rounded tile (radius 8, the secondary fill) with the glyph in the muted text colour; the accessibility name is the kind's name.
    public static Border Tile(string key, string name, Brush fill, Brush glyph)
    {
        UIElement mark = key switch
        {
            "web" => SettingsUi.Glyph("\uE774", 16, glyph),
            "console" => SettingsUi.Glyph("\uE756", 16, glyph),
            _ => new Path { Data = Geometry(key), Fill = glyph, Stretch = Stretch.Uniform, Width = 16, Height = 16 }
        };
        if (mark is FrameworkElement element) { element.HorizontalAlignment = HorizontalAlignment.Center; element.VerticalAlignment = VerticalAlignment.Center; }
        var tile = new Border { Width = 32, Height = 32, CornerRadius = new CornerRadius(8), Background = fill, Child = mark, VerticalAlignment = VerticalAlignment.Center };
        System.Windows.Automation.AutomationProperties.SetName(tile, name); return tile;
    }
}
