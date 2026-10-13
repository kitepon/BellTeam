using System.Text.Json;

namespace BellTeam.Core;

public sealed record WindowPlacement(double Left, double Top, double Width, double Height, bool Maximized);
public sealed record LocalSettings
{
    public string? ServerUrl { get; init; }
    public WindowPlacement? Window { get; init; }
}
public sealed class SettingsStore(string directory)
{
    public static string UserDirectory => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BellTeam");
    public string FilePath => Path.Combine(directory, "settings.json");
    public LocalSettings Load()
    {
        if (!File.Exists(FilePath)) return new();
        return JsonSerializer.Deserialize<LocalSettings>(File.ReadAllText(FilePath), BellApi.Json)
            ?? throw new InvalidDataException("このPCの設定ファイルが空です。");
    }
    public void Save(LocalSettings settings)
    {
        Directory.CreateDirectory(directory);
        var temporary = FilePath + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(settings, BellApi.Json));
        File.Move(temporary, FilePath, true);
    }
}
