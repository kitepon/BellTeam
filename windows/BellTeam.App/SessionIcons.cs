using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using Path = System.Windows.Shapes.Path;

namespace BellTeam.App;

// The sessions screen glyphs (apple/sessions-screen.md): generic device icons, the shared SVG files (embedded, one 24x24 path each) drawn natively. No brand marks.
internal static partial class SessionIcons
{
    [GeneratedRegex("<path d=\"([^\"]+)\"")] private static partial Regex PathData();
    public static Geometry Geometry(string key) => System.Windows.Media.Geometry.Parse(PathData().Match(EmbeddedAsset.Text("sessions-icons/" + key + ".svg")) is { Success: true } match ? match.Groups[1].Value : throw new InvalidOperationException(key + ".svg に path がありません。"));
    // A 32 pt rounded tile (radius 8, the secondary fill) with the glyph in the muted text colour; the accessibility name is the kind's name.
    public static Border Tile(string key, string name, Brush fill, Brush glyph)
    {
        var path = new Path { Data = Geometry(key), Fill = glyph, Stretch = Stretch.Uniform, Width = 16, Height = 16, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        var tile = new Border { Width = 32, Height = 32, CornerRadius = new CornerRadius(8), Background = fill, Child = path, VerticalAlignment = VerticalAlignment.Center };
        System.Windows.Automation.AutomationProperties.SetName(tile, name); return tile;
    }
}
