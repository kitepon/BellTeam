using System.Globalization;
using System.Windows.Data;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using BellTeam.Core;

namespace BellTeam.App;

// The shared Workspace (BellTeam.Core) with WPF images; ContextIdle runs after the first page's cards are laid out and loaded (MessageCard reads Opening then).
public sealed class Workspace(Func<Uri, BellApi>? apiFactory = null, Func<Uri, Task>? prepareConnection = null, Func<int, CancellationToken, Task>? retryDelay = null)
    : Workspace<BitmapSource>(WpfImageCodec.Instance, action => Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.ContextIdle, action), apiFactory, prepareConnection, retryDelay);

// Mac BotPresenceDot colours for ConversationEntry.PresenceTone.
public sealed class PresenceBrushConverter : IValueConverter
{
    private static readonly Brush WorkingBrush = Frozen(0xFF, 0x3B, 0x30), OnlineBrush = Frozen(0x2E, 0xB3, 0x9E), OfflineBrush = Frozen(0xE5, 0xE3, 0xF0);
    private static Brush Frozen(byte r, byte g, byte b) { var brush = new SolidColorBrush(Color.FromRgb(r, g, b)); brush.Freeze(); return brush; }
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture) => value switch { PresenceTone.Working => WorkingBrush, PresenceTone.Online => OnlineBrush, _ => OfflineBrush };
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}
