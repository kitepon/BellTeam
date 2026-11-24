namespace BellTeam.Linux;

// Contract 1.46: the library hands one line per Apple return (time, which fields arrived, Apple's error code; never the token, the code or the subject) to the product.
// It is appended to the app's own log file in its private storage on this device, where the person can read it later; nothing is sent anywhere.
// shortcut: appends without rotation (about 100 bytes per Apple sign-in), rotate when the file grows past what a person reads.
internal static class AppleReturnLog
{
    private static readonly object Gate = new();

    public static void Append(string path, string line)
    {
        lock (Gate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                if (!File.Exists(path)) File.WriteAllText(path, "");
                if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                File.AppendAllText(path, line + "\n");
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                Console.Error.WriteLine("Appleの戻りの記録を書けませんでした。" + error.Message);   // a log that cannot be written never stops the sign-in; the reason goes to the process's own output
            }
        }
    }
}
