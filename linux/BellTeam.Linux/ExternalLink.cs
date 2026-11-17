using System.Diagnostics;

namespace BellTeam.Linux;

// Opens an address in the default browser. Linux uses the shell execute of .NET (xdg-open); an app without a shell (Android) sets Opener once at start. A failure is thrown for the caller to say.
public static class ExternalLink
{
    public static Action<Uri>? Opener { get; set; }
    public static void Launch(Uri uri)
    {
        if (Opener is { } open) open(uri);
        else Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }
}
