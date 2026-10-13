using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;

namespace BellTeam.Core;

public static class SseReader
{
    public static async IAsyncEnumerable<JsonElement> ReadAsync(Stream stream, [EnumeratorCancellation] CancellationToken token = default)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8, true, leaveOpen: true);
        var data = new List<string>();
        while (await reader.ReadLineAsync(token) is { } line)
        {
            if (line.Length == 0)
            {
                if (data.Count == 0) continue;
                JsonElement payload;
                try
                {
                    using var document = JsonDocument.Parse(string.Join('\n', data));
                    if (document.RootElement.ValueKind != JsonValueKind.Object) throw new JsonException("オブジェクトが必要です。");
                    payload = document.RootElement.Clone();
                }
                catch (JsonException error) { throw new BellApiException("新着のデータを読み取れませんでした。" + error.Message); }
                data.Clear();
                yield return payload;
            }
            else if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                var value = line[5..];
                data.Add(value.StartsWith(' ') ? value[1..] : value);
            }
        }
    }
}
