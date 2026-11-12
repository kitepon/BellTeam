using BellTeam.Core;

namespace BellTeam.Linux.Tests;

public sealed class SettingsLocationTests
{
    // A fresh account may have no ~/.local/share yet; the settings folder must still be absolute, never relative to the working directory.
    [Fact]
    public void UserDirectoryIsCreatedUnderAMissingDataHome()
    {
        var root = Path.Combine(Path.GetTempPath(), "bellteam-xdg-" + Guid.NewGuid().ToString("N"));
        var dataHome = Path.Combine(root, "share");
        var previous = Environment.GetEnvironmentVariable("XDG_DATA_HOME");
        try
        {
            Environment.SetEnvironmentVariable("XDG_DATA_HOME", dataHome);
            Assert.Equal(Path.Combine(dataHome, "BellTeam"), SettingsStore.UserDirectory);
            Assert.True(Directory.Exists(dataHome));
        }
        finally { Environment.SetEnvironmentVariable("XDG_DATA_HOME", previous); if (Directory.Exists(root)) Directory.Delete(root, true); }
    }
}
