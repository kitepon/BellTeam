using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;

namespace BellTeam.Core;

public static class SseReader
{
    public static async IAsyncEnumerable<JsonElement> ReadAsync(Stream stream, [EnumeratorCancellation] CancellationToken token = default)
    {
        await foreach (var item in ReadRawAsync(stream, null, token))
        {
            JsonElement payload;
            try
            {
                using var document = JsonDocument.Parse(item.Data);
                if (document.RootElement.ValueKind != JsonValueKind.Object) throw new JsonException("オブジェクトが必要です。");
                payload = document.RootElement.Clone();
            }
            catch (JsonException error) { throw new BellApiException("新着のデータを読み取れませんでした。" + error.Message); }
            yield return payload;
        }
    }

    /// <summary>Yields each event's <c>event:</c> name (null if absent) and joined data text. <paramref name="onActivity"/> runs for every line, heartbeat comments included.</summary>
    public static async IAsyncEnumerable<(string? Name, string Data)> ReadRawAsync(Stream stream, Action? onActivity, [EnumeratorCancellation] CancellationToken token = default)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8, true, leaveOpen: true);
        var data = new List<string>();
        string? name = null;
        while (await reader.ReadLineAsync(token) is { } line)
        {
            onActivity?.Invoke();
            if (line.Length == 0)
            {
                if (data.Count > 0) yield return (name, string.Join('\n', data));
                data.Clear();
                name = null;
            }
            else if (line.StartsWith("data:", StringComparison.Ordinal)) data.Add(Field(line, 5));
            else if (line.StartsWith("event:", StringComparison.Ordinal)) name = Field(line, 6);
        }
    }

    private static string Field(string line, int start) => line[start..].StartsWith(' ') ? line[(start + 1)..] : line[start..];
}
