using Xunit;

namespace BellTeam.Linux;

// Contract 1.46: the library's Apple-return line is kept in the app's own file, one line each, readable by the user only.
public sealed class AppleReturnLogTests
{
    [Fact]
    public void EachLineIsAppendedToTheOwnFileForTheUserOnly()
    {
        var dir = Path.Combine(Path.GetTempPath(), "bellteam-applelog-" + Guid.NewGuid().ToString("N"));
        try
        {
            var path = Path.Combine(dir, "sub", "apple-return.log");
            AppleReturnLog.Append(path, "2026-11-24T14:00:00+09:00 fields=id_token,state error=-");
            AppleReturnLog.Append(path, "2026-11-24T14:01:00+09:00 fields=error error=user_cancelled_authorize");
            Assert.Equal(["2026-11-24T14:00:00+09:00 fields=id_token,state error=-", "2026-11-24T14:01:00+09:00 fields=error error=user_cancelled_authorize"], File.ReadAllLines(path));
            if (OperatingSystem.IsLinux()) Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
        }
        finally { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
    }
}
