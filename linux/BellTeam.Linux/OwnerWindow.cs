using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.VisualTree;

namespace BellTeam.Linux;

// The window a control sits in. On Linux that is its TopLevel; on Android a "window" is a page of the phone shell (see android/BellTeam.Android/WindowShim.cs), found among the control's visual ancestors.
internal static class OwnerWindow
{
    public static Window? Of(Visual? control)
    {
#if ANDROID
        return control?.FindAncestorOfType<Window>();
#else
        return control is null ? null : TopLevel.GetTopLevel(control) as Window;
#endif
    }
}

// The two-pill header buttons of a sheet (Mac sheet: 閉じる / キャンセル on the left, 保存 on the right), shared by the main window and the pages.
internal static class SheetButtons
{
    public static Button Pill(string text)
    {
        var button = new Button
        {
            Classes = { "plain" }, Content = text, Padding = new Thickness(16, 7), CornerRadius = new CornerRadius(99), FontWeight = FontWeight.Normal, Foreground = BellTheme.Ink, Background = new SolidColorBrush(Color.Parse("#80FFFFFF")),
            BorderBrush = new SolidColorBrush(Color.Parse("#C9C4DE")), BorderThickness = new Thickness(1), VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center
        };
        AutomationProperties.SetName(button, text); return button;
    }
}

// A window shown as a phone page that has its own steps back (a detail back to its list) before the page itself closes: the back key asks this first.
public interface IPageBack { bool GoBack(); }
