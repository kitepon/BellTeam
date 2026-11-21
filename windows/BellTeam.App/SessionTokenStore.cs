using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.App;

// a485: the server's session token per server address (app-sessions.md section 4), in a file only this Windows user can read (DPAPI, CurrentUser).
public sealed class DpapiSessionTokenStore(string directory) : ISessionTokenStore
{
    private string FilePath => Path.Combine(directory, "sessions.bin");
    // A file this user can no longer decrypt (another account, a restored profile) holds a token nobody can use: reading it as "no token" only means logging in again.
    private Dictionary<string, string> Read()
    {
        if (!File.Exists(FilePath)) return [];
        try { return JsonSerializer.Deserialize<Dictionary<string, string>>(Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(FilePath), null, DataProtectionScope.CurrentUser))) ?? []; }
        catch (Exception error) when (error is CryptographicException or JsonException) { return []; }
    }
    public string? Load(Uri origin) => Read().GetValueOrDefault(origin.AbsoluteUri);
    public void Save(Uri origin, string token) => Write(map => map[origin.AbsoluteUri] = token);
    public void Clear(Uri origin) { if (File.Exists(FilePath)) Write(map => map.Remove(origin.AbsoluteUri)); }
    private void Write(Action<Dictionary<string, string>> change)
    {
        var map = Read(); change(map);
        Directory.CreateDirectory(directory);
        var temporary = FilePath + ".tmp";
        File.WriteAllBytes(temporary, ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(map), null, DataProtectionScope.CurrentUser));
        File.Move(temporary, FilePath, true);
    }
}

// For a window that is not the installed app (tests, renders): nothing reaches the disk.
public sealed class MemorySessionTokenStore : ISessionTokenStore
{
    private readonly Dictionary<string, string> map = [];
    public string? Load(Uri origin) => map.GetValueOrDefault(origin.AbsoluteUri);
    public void Save(Uri origin, string token) => map[origin.AbsoluteUri] = token;
    public void Clear(Uri origin) => map.Remove(origin.AbsoluteUri);
}
