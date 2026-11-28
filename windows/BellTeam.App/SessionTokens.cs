using System.IO;
using System.Security.Cryptography;
using System.Text;
using BellTeam.Core;

namespace BellTeam.App;

// app-sessions.md section 4: the server's opaque session token, one file per server address, protected for this Windows user (DPAPI, CurrentUser).
public sealed class DpapiSessionTokenStore(string directory) : ISessionTokenStore
{
    public static DpapiSessionTokenStore Local => new(Path.Combine(SettingsStore.UserDirectory, "session-tokens"));
    private string FileOf(Uri origin) => Path.Combine(directory, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(origin.AbsoluteUri))) + ".bin");

    public string? Load(Uri origin)
    {
        var file = FileOf(origin);
        if (!File.Exists(file)) return null;
        // A file this user cannot unprotect (copied from another account or machine) holds no usable token: the app asks for a new code, which replaces it.
        try { return Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(file), null, DataProtectionScope.CurrentUser)); }
        catch (CryptographicException) { return null; }
    }
    public void Save(Uri origin, string token)
    {
        Directory.CreateDirectory(directory);
        File.WriteAllBytes(FileOf(origin), ProtectedData.Protect(Encoding.UTF8.GetBytes(token), null, DataProtectionScope.CurrentUser));
    }
    public void Clear(Uri origin) => File.Delete(FileOf(origin));
    // Account deletion: the token of every server goes (nothing to remove is not an error).
    public void DeleteAll() { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
}
