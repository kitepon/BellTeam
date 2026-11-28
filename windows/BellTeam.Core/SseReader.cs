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
                if (document.RootElement.ValueKind != JsonValueKind.Object) throw new JsonException(CoreStrings.SseReader_ReadAsync_1);
                payload = document.RootElement.Clone();
            }
            catch (JsonException error) { throw new BellApiException(CoreStrings.SseReader_ReadAsync_2(error.Message)); }
            yield return payload;
        }
    }

    /// <summary>Yields each event's <c>event:</c> name (null if absent) and joined data text. <paramref name="onActivity"/> runs for every line, heartbeat comments included.</summary>
    public static IAsyncEnumerable<(string? Name, string Data)> ReadRawAsync(Stream stream, Action? onActivity, CancellationToken token = default) => ReadRawAsync(stream, onActivity, null, token);

    /// <summary>The same, and <paramref name="onId"/> gets the <c>id:</c> of each event as it is read (the value a client sends back as Last-Event-ID to resume).</summary>
    public static async IAsyncEnumerable<(string? Name, string Data)> ReadRawAsync(Stream stream, Action? onActivity, Action<string>? onId, [EnumeratorCancellation] CancellationToken token = default)
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
            else if (line.StartsWith("id:", StringComparison.Ordinal)) onId?.Invoke(Field(line, 3));
        }
    }

    private static string Field(string line, int start) => line[start..].StartsWith(' ') ? line[(start + 1)..] : line[start..];
}
