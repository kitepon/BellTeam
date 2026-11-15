using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using BellTeam.Core;
using static BellTeam.App.LatticeLook;

namespace BellTeam.App;

/// <summary>The small drawn parts of the 決裁箱 screen (screen-spec "Look"): glyphs in the Lattice 1.7 stroke style (the same paths as Web), tiles and badges.</summary>
internal static class ApprovalsLook
{
    // 24 x 24 stroke paths, the Web screen's GLYPHS (approvals.js / lattice-chart.js). Colour never carries a state alone: a glyph and a word always go together.
    private static readonly Dictionary<string, string> Paths = new()
    {
        ["inbox"] = "M3.5 13.5l2.4-7.2A2 2 0 0 1 7.8 5h8.4a2 2 0 0 1 1.9 1.3l2.4 7.2 M3.5 13.5V18a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4.5h-5.2a3.3 3.3 0 0 1-6.6 0z",
        ["bolt"] = "M13 3L5.5 13.2h5.2L10 21l7.5-10.2h-5.2z",
        ["pause"] = "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M10 9v6M14 9v6",
        ["link"] = "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
        ["copy"] = "M8.5 8.5h11v11h-11z M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2",
        ["send"] = "M20.5 3.5L10 14M20.5 3.5L14 20.5l-4-6.5-6.5-4z",
        ["pencil"] = "M5 19l1-4.2L16.6 4.2a2.1 2.1 0 0 1 3 3L9 17.8z M14.5 6.3l3.2 3.2",
        ["doc"] = "M6 3h8l4 4v14H6z M9 11h6M9 15h6",
        ["terminal"] = "M6 4.5h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3z M7.5 10l3 2.5-3 2.5M13 15h3.5",
        ["chat"] = "M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6l-4.5 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
        ["globe"] = "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M3 12h18 M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3z",
        ["arrow"] = "M5 12h13M13 6.5l5.5 5.5-5.5 5.5",
        ["image"] = "M6 5h12a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-9A2.5 2.5 0 0 1 6 5z M4 17l5-4.5 3.5 3L16 12l4.5 4.5",
        ["check"] = "M5 12.5l4.5 4.5L19 7.5",
        ["seal"] = "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M8 12.3l3 3 5-6",
        ["xmark"] = "M6.5 6.5l11 11M17.5 6.5l-11 11",
        ["refresh"] = "M20 12a8 8 0 1 1-2.7-6M20 4.5v4.8h-4.8",
        ["info"] = "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M12 11v5.5 M12 7.9v.1",
        ["target"] = "M5 12a7 7 0 1 0 14 0a7 7 0 1 0-14 0 M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2",
        ["hour"] = "M7 3.5h10M7 20.5h10 M8 3.5c0 4.6 3.2 5.8 4 8.5-.8 2.7-4 3.9-4 8.5M16 3.5c0 4.6-3.2 5.8-4 8.5.8 2.7 4 3.9 4 8.5",
    };
    private static readonly Dictionary<string, Geometry> Cache = [];
    private static Geometry Of(string name)
    {
        if (Cache.TryGetValue(name, out var geometry)) return geometry;
        geometry = Geometry.Parse(Paths.GetValueOrDefault(name, Paths["info"])); geometry.Freeze(); return Cache[name] = geometry;
    }
    public static Path Glyph(string name, double size, Color color) => new()
    {
        Data = Of(name), Stroke = Brush(color), StrokeThickness = 1.7, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, StrokeLineJoin = PenLineJoin.Round,
        Width = size, Height = size, Stretch = Stretch.Uniform, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center
    };

    public static Color Tone(string tone) => tone switch
    {
        "vio" => Violet, "amb" => Amber, "ok" => Color.FromRgb(0x1F, 0x86, 0x76), "ind" => Accent("indigo"), _ => Muted
    };
    /// <summary>A state badge: glyph + text, tinted by its tone (回答待ち vio, 急ぎ amb, 保留 / 取り下げ / 外部から pen, 回答済み / 届きました ok, 修正あり ind).</summary>
    public static Border Badge(ApprovalBadge badge)
    {
        var color = Tone(badge.Tone); var row = Row();
        if (badge.Glyph.Length > 0) row.Children.Add(Glyph(badge.Glyph, 12, color));
        row.Children.Add(Spaced(Text(badge.Text, 12, color, FontWeights.SemiBold), badge.Glyph.Length > 0 ? 5 : 0));
        var pill = Pill(row, color, 0x1F, new Thickness(8, 2, 9, 2)); pill.Margin = new Thickness(0, 0, 6, 0); return pill;
    }

    /// <summary>Who filed it: a roster face (BellTeam member) or a grey rounded-square tool tile (never a member colour, so it cannot be taken for a face).</summary>
    public static FrameworkElement Origin(ApprovalOriginView origin, double size, Func<ApprovalRequester, LatticePerson> person, Func<string, string, Task<System.Windows.Media.Imaging.BitmapSource>> avatar)
    {
        if (origin.Member is { } member) return new LatticeAvatar(person(member), size, avatar);
        var tile = new Border { Width = size, Height = size, CornerRadius = new CornerRadius(size * .3), Background = Brush(Muted, 0x33), VerticalAlignment = VerticalAlignment.Center, Child = Glyph(origin.Tile, size * .58, Slate) };
        System.Windows.Automation.AutomationProperties.SetName(tile, origin.Tool);
        return tile;
    }
}
