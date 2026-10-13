using System.Windows.Media;

namespace BellTeam.App;

public static class BellColors
{
    public static Color Accent(string? name) => name switch
    {
        "rose" => Color.FromRgb(232, 107, 148), "indigo" => Color.FromRgb(69, 89, 194),
        "sky" => Color.FromRgb(71, 161, 227), "mint" => Color.FromRgb(46, 179, 158), "amber" => Color.FromRgb(232, 158, 71),
        _ => Color.FromRgb(97, 71, 212)
    };
}
