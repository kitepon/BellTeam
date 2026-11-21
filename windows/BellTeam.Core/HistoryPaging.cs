using System.Globalization;

namespace BellTeam.Core;

// machine-stream.md "History pages of a long stream": page sizes are one constant each (a measurement on a real seat changes one line); the prefetch rule is the same on every app.
public static class HistoryPaging
{
    public const int FirstPageLimit = 1000, OlderPageLimit = 1000; // the server cap is 1000; 601 KB and 0.25 s measured on production (Owner 13:4x: 100 is far too few)
    const double Screens = 3, Seconds = 2;
    // Fullness is what is drawn, never the rows held (machine-stream.md "Fill rule"): a page of folded rows draws almost nothing, so the count of rows says nothing about the screen.
    // above: drawn pixels above the top of the view (the first screen is the same case: the view at the bottom of a short list has nothing above it); speed: pixels per second the view is moving up.
    // Read an older page while less than max(3 screens, 2 seconds of the scroll speed) is drawn above the view; the caller also requires has_more, no older request on its way, and keeps looping while pages arrive.
    public static bool NeedsOlderPage(double above, double viewport, double speed) => above < Math.Max(Screens * viewport, Seconds * speed);
    // before_at: the `at` of the oldest loaded row as the server writes it (UTC, milliseconds), so the body can bound the cards it hands the child.
    public static string BeforeAt(DateTimeOffset at) => at.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
}
