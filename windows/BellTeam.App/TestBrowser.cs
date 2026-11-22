using System.Diagnostics;

namespace BellTeam.App;

/// <summary>
/// The browser of a web sign-in: the system browser (null), or, only when BELLTEAM_TEST_CHROME_PROFILE names a directory, a Chrome of that separate profile,
/// so a real-provider test run (real-path-tests 1.26) never touches the Owner's own browser profile. A missing Chrome fails the sign-in; nothing falls back to the system browser.
/// </summary>
internal static class TestBrowser
{
    internal static Func<Uri, Task>? Open => Environment.GetEnvironmentVariable("BELLTEAM_TEST_CHROME_PROFILE") is { Length: > 0 } dir ? uri => Start(Arguments(dir, uri)) : null;

    internal static string Arguments(string profileDirectory, Uri address) => $"--user-data-dir=\"{profileDirectory}\" --no-first-run --no-default-browser-check \"{address.AbsoluteUri}\"";

    private static Task Start(string arguments) { Process.Start(new ProcessStartInfo("chrome.exe", arguments) { UseShellExecute = true }); return Task.CompletedTask; }
}
