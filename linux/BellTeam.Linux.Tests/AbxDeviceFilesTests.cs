using BellTeam.Linux;
using BellTeam.PeerChannel;
using Xunit;

namespace BellTeam.Linux.Tests;

[System.Runtime.Versioning.UnsupportedOSPlatform("windows")]   // the 0600 mode is a Unix fact
public sealed class AbxDeviceFilesTests : IDisposable
{
    private readonly string dir = Path.Combine(Path.GetTempPath(), "abx-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { try { Directory.Delete(dir, true); } catch (IOException) { } }

    [Fact]
    public void TheDeviceKeysAreMadeOnceKeptPrivateAndReadAgain()
    {
        var path = Path.Combine(dir, "device.key");
        var first = LinuxDeviceKeyStore.LoadOrCreate(path);
        var again = LinuxDeviceKeyStore.LoadOrCreate(path);
        Assert.Equal(first.KeyId, again.KeyId);
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
    }

    [Fact]
    public void AStaleTemporaryFileDoesNotKeepItsOldMode()
    {
        var path = Path.Combine(dir, "device.key"); Directory.CreateDirectory(dir);
        File.WriteAllText(path + ".tmp", "old"); File.SetUnixFileMode(path + ".tmp", UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead);
        SecretFile.Write(path, [1]);
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
    }

    [Fact]
    public void AKeyFileThatDoesNotParseGivesNewKeys()
    {
        var path = Path.Combine(dir, "device.key"); Directory.CreateDirectory(dir); File.WriteAllText(path, "not a key");
        var made = LinuxDeviceKeyStore.LoadOrCreate(path);
        Assert.Equal(made.KeyId, LinuxDeviceKeyStore.LoadOrCreate(path).KeyId);
    }

    [Fact]
    public void BlobFilesKeepBytesPrivatelyAndRefuseAnythingButABlobId()
    {
        var files = new LinuxBlobFiles(Path.Combine(dir, "blobs")); var id = new string('A', 43);
        files.Write(id, [1, 2, 3]);
        Assert.Equal(new byte[] { 1, 2, 3 }, files.Read(id));
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(Path.Combine(dir, "blobs", id)));
        Assert.Null(files.Read(new string('B', 43)));
        Assert.Null(files.Read("../escape"));   // not a blob id: never a path
        Assert.Throws<ArgumentException>(() => files.Write("../escape", [1]));
    }

    [Fact]
    public void TheHistoryIsKeptPrivatelyAndReadAgain()
    {
        var path = Path.Combine(dir, "history.json");
        LinuxDeviceApprovals.SaveHistoryFile(path, new DecisionBook());
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
        Assert.NotNull(LinuxDeviceApprovals.LoadHistory(path));
        File.WriteAllText(path, "garbage");
        Assert.NotNull(LinuxDeviceApprovals.LoadHistory(path));   // unreadable: an empty book, never a crash
    }
}
