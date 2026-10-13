using System.Globalization;
using System.Windows.Data;

namespace BellTeam.App;

public sealed class ButtonGlyphConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture) => value is string { Length: 1 } glyph ? glyph : "";
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}
