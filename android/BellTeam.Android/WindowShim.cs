using Avalonia;
using Avalonia.Controls;

namespace BellTeam.Linux;

// Avalonia's Window cannot be built on Android (NotSupportedException). The linked Linux screens are written as windows that are never shown on their own, so inside
// namespace BellTeam.Linux this phone Window takes the name: a window is a page of the PhoneShell's stack; Show() pushes it and Close() pops it.
public class Window : ContentControl
{
    public static Action<Window>? Pusher, Popper;
    public string? Title { get; set; }
    public Window? Owner { get; set; }
    public bool IsActive => IsVisible;
    public event EventHandler? Closed, Activated, Deactivated, Opened;
    public event EventHandler<WindowClosingEventArgs>? Closing;
    public void Show() { IsVisible = true; Pusher?.Invoke(this); Opened?.Invoke(this, EventArgs.Empty); Activated?.Invoke(this, EventArgs.Empty); }
    public void Show(Window owner) { Owner = owner; Show(); }
    public Task ShowDialog(Window owner) { Owner = owner; Show(); var done = new TaskCompletionSource(); Closed += (_, _) => done.TrySetResult(); return done.Task; }
    public Task<T?> ShowDialog<T>(Window owner) { Owner = owner; Show(); var done = new TaskCompletionSource<T?>(); Closed += (_, _) => done.TrySetResult(result is T value ? value : default); return done.Task; }
    private object? result;
    public void Close(object? dialogResult) { result = dialogResult; Close(); }
    public void Activate() { }
    public void Close() { var args = new WindowClosingEventArgs(); Closing?.Invoke(this, args); if (args.Cancel) return; IsVisible = false; Popper?.Invoke(this); Closed?.Invoke(this, EventArgs.Empty); }
    public WindowStartupLocation WindowStartupLocation { get; set; }
    public SizeToContent SizeToContent { get; set; }
    public static readonly StyledProperty<WindowState> WindowStateProperty = AvaloniaProperty.Register<Window, WindowState>(nameof(WindowState));
    public WindowState WindowState { get => GetValue(WindowStateProperty); set => SetValue(WindowStateProperty, value); }
    // Pages have no screens; the callers fall back to their own sizes when this answers null.
    public ScreensShim Screens { get; } = new();
    public bool CanResize { get; set; } = true;
    public bool ShowInTaskbar { get; set; }
    public bool Topmost { get; set; }
    public object? Icon { get; set; }
    public Avalonia.Input.Platform.IClipboard? Clipboard => TopLevel.GetTopLevel(this)?.Clipboard;
    public Avalonia.Platform.Storage.IStorageProvider StorageProvider => TopLevel.GetTopLevel(this)!.StorageProvider;
}
public sealed class ScreensShim { public ScreenInfo? ScreenFromWindow(Window window) => null; }
public sealed class ScreenInfo { public PixelRect WorkingArea { get; init; } public double Scaling { get; init; } = 1; }
public sealed class WindowClosingEventArgs : EventArgs { public bool Cancel { get; set; } }
