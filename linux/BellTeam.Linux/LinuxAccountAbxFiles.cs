using System.Text;
using BellTeam.PeerChannel;

namespace BellTeam.Linux;

// a520: the files of this PC's Approval Box device. Linux keeps them as files only the user can read (mode 0600, written through a temporary file), like the pass and the home record;
// the registry therefore says protection "software" (peer-channel contract 3, not "os_store": no Secret Service yet). shortcut: no secret-tool, add it when Delta asks for os_store on Linux.
internal static class SecretFile
{
    public static void Write(string path, byte[] bytes)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tmp";
        File.Delete(temporary);   // a stale .tmp from a crash would keep its old mode: the file is made new with 0600
        var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        using (var stream = new FileStream(temporary, options)) stream.Write(bytes);
        File.Move(temporary, path, overwrite: true);
    }
}

// The device's peer-channel keys. A file that does not parse is no key: new keys are made and the device is added to the registry again.
internal static class LinuxDeviceKeyStore
{
    public static DeviceIdentity LoadOrCreate(string path)
    {
        try { if (File.Exists(path)) return DeviceIdentity.Import(File.ReadAllBytes(path)); }
        catch (Exception error) when (error is ArgumentException or IOException or FormatException) { }
        var made = DeviceIdentity.Generate();
        SecretFile.Write(path, made.Export());
        return made;
    }
}

// Request images of the device history, one 0600 file per blob (named by its base64url SHA-256: only [A-Za-z0-9_-] can be a name).
internal sealed class LinuxBlobFiles(string directory) : IBlobFiles
{
    private string PathOf(string blobId) => blobId.Length == 43 && blobId.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_') ? Path.Combine(directory, blobId) : throw new ArgumentException("not a blob id");
    public void Write(string blobId, byte[] bytes) => SecretFile.Write(PathOf(blobId), bytes);
    public byte[]? Read(string blobId)
    {
        try { var path = PathOf(blobId); return File.Exists(path) ? File.ReadAllBytes(path) : null; }
        catch (Exception error) when (error is IOException or ArgumentException) { return null; }
    }
}
