using Avalonia;
using Avalonia.Headless;
using BellTeam.Linux;

namespace BellTeam.Linux;

// A headless Skia app on its own UI thread: the codec and the dispatcher need a platform, but no window is ever shown.
public static class TestAppBuilder
{
    public static AppBuilder BuildAvaloniaApp() => AppBuilder.Configure<App>().UseSkia().UseHeadless(new AvaloniaHeadlessPlatformOptions { UseHeadlessDrawing = false });
}

public static class Ui
{
    private static readonly Lazy<HeadlessUnitTestSession> Session = new(() => HeadlessUnitTestSession.StartNew(typeof(TestAppBuilder)));
    // The Func<Task<int>> overload is the one that awaits the test body; Func<Task> would bind to the synchronous one and pass vacuously.
    public static Task Run(Func<Task> test) => Session.Value.Dispatch(async () => { await test(); return 0; }, CancellationToken.None);
}
