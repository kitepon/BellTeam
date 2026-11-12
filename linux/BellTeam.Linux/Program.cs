using Avalonia;
using Avalonia.Headless;
using BellTeam.Core;

namespace BellTeam.Linux;

public static class Program
{
    public static int Main(string[] args)
    {
        // No window: validate the address and keep the rest of the saved settings (the install script calls this).
        if (!Launcher.IsKnown(args)) { Console.Error.WriteLine(Launcher.Usage); return 1; }
        if (args is ["--configure", var server]) return Configure(server);
        return BuildApp(args).StartWithClassicDesktopLifetime(args);
    }

    private static int Configure(string server)
    {
        try
        {
            var origin = ServerOrigin.Parse(server);
            var store = new SettingsStore(SettingsStore.UserDirectory);
            store.Save(store.Load() with { ServerUrl = origin.AbsoluteUri });
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }

    // The render modes draw with Skia into an offscreen headless window, so they need no display.
    internal static AppBuilder BuildApp(string[] args)
    {
        var builder = AppBuilder.Configure<App>();
        return Launcher.IsRender(args) ? builder.UseSkia().UseHeadless(new AvaloniaHeadlessPlatformOptions { UseHeadlessDrawing = false }) : builder.UsePlatformDetect();
    }
}
