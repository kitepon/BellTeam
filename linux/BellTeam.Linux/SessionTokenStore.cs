using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Linux;

// a485: the server's session token per server address, in a file only the user can read (0600). shortcut: no libsecret yet; move to the Secret Service when Mika and Neon pick it up (app-sessions.md section 4).
public sealed class FileSessionTokenStore(string directory) : ISessionTokenStore
{
    private string FilePath => Path.Combine(directory, "sessions.json");
    private Dictionary<string, string> Read() => File.Exists(FilePath) ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(FilePath)) ?? [] : [];
    public string? Load(Uri origin) => Read().GetValueOrDefault(origin.AbsoluteUri);
    public void Save(Uri origin, string token) => Write(map => map[origin.AbsoluteUri] = token);
    public void Clear(Uri origin) { if (File.Exists(FilePath)) Write(map => map.Remove(origin.AbsoluteUri)); }
    private void Write(Action<Dictionary<string, string>> change)
    {
        var map = Read(); change(map);
        Directory.CreateDirectory(directory);
        // Created 0600 from the start: the token is never in a file others can read, not even for an instant.
        var temporary = FilePath + ".tmp";
        var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        using (var stream = new FileStream(temporary, options)) JsonSerializer.Serialize(stream, map);
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
