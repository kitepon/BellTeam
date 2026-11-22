using System.IO;
using System.Security.Cryptography;
using System.Text;
using BellTeam.PeerChannel;

namespace BellTeam.App;

// Request images of the device history, one DPAPI-sealed file per blob (named by its base64url SHA-256: only [A-Za-z0-9_-] can be a name). A file that does not unseal is no image.
internal sealed class SealedBlobFiles(string directory) : IBlobFiles
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("BellTeam-peer-channel-blob");
    private string PathOf(string blobId) => blobId.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_') && blobId.Length == 43 ? Path.Combine(directory, blobId) : throw new ArgumentException("not a blob id");
    public void Write(string blobId, byte[] bytes)
    {
        Directory.CreateDirectory(directory);
        var path = PathOf(blobId); var temp = path + ".tmp";
        File.WriteAllBytes(temp, ProtectedData.Protect(bytes, Entropy, DataProtectionScope.CurrentUser));
        File.Move(temp, path, overwrite: true);
    }
    public byte[]? Read(string blobId)
    {
        try { var path = PathOf(blobId); return File.Exists(path) ? ProtectedData.Unprotect(File.ReadAllBytes(path), Entropy, DataProtectionScope.CurrentUser) : null; }
        catch (Exception error) when (error is CryptographicException or IOException or ArgumentException) { return null; }
    }
}
