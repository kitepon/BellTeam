using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;

namespace BellTeam.Core;

public sealed class BellApiException(string message, HttpStatusCode? status = null) : Exception(message)
{
    public HttpStatusCode? Status { get; } = status;
}

public sealed class BellApi : IDisposable
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        RespectNullableAnnotations = true
    };
    private readonly HttpClient client;
    public Uri Origin { get; }

    public BellApi(Uri origin, HttpMessageHandler? handler = null)
    {
        Origin = origin;
        client = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false })
        {
            BaseAddress = origin,
            Timeout = Timeout.InfiniteTimeSpan
        };
    }

    public async Task<T> GetAsync<T>(string path, CancellationToken token = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        return await JsonAsync<T>(request, token);
    }

    public async Task SendAsync(ChatTarget target, string text, string[]? targets, CancellationToken token = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, target.Path + "/messages")
        {
            Content = JsonContent.Create(new { message = text, images = Array.Empty<object>(), targets }, options: Json)
        };
        var result = await JsonAsync<JsonElement>(request, token);
        if (result.ValueKind != JsonValueKind.Object) throw new BellApiException("BellTeamからの送信応答を読み取れませんでした。");
    }

    private async Task<T> JsonAsync<T>(HttpRequestMessage request, CancellationToken token)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        using var response = await client.SendAsync(request, timeout.Token);
        await ValidateAsync(response, timeout.Token);
        if (response.Content.Headers.ContentType?.MediaType != "application/json")
            throw new BellApiException("BellTeamからの応答がJSONではありません。接続先を確認してください。");
        try
        {
            return await response.Content.ReadFromJsonAsync<T>(Json, timeout.Token)
                ?? throw new BellApiException("BellTeamからの応答が空です。");
        }
        catch (JsonException error) { throw new BellApiException("BellTeamからの応答を読み取れませんでした。" + error.Message); }
    }

    private static async Task ValidateAsync(HttpResponseMessage response, CancellationToken token)
    {
        var status = (int)response.StatusCode;
        if (status is >= 300 and < 400 || status is 401 or 403)
            throw new BellApiException("Cloudflare Accessへログインしてください。Windows版の外部ログインは次の段階で対応します。", response.StatusCode);
        if (response.IsSuccessStatusCode) return;
        var body = await response.Content.ReadAsStringAsync(token);
        string detail = $"HTTP {status}";
        if (response.Content.Headers.ContentType?.MediaType == "application/json")
        {
            try
            {
                using var document = JsonDocument.Parse(body);
                var root = document.RootElement;
                if (root.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.String)
                    detail = message.GetString()!;
                else if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String)
                    detail = error.GetString()!;
            }
            catch (JsonException) { detail += "（エラー応答のJSONを読み取れませんでした）"; }
        }
        throw new BellApiException("BellTeam: " + detail, response.StatusCode);
    }

    public async IAsyncEnumerable<JsonElement> EventsAsync([EnumeratorCancellation] CancellationToken token = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/events");
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        using var handshake = CancellationTokenSource.CreateLinkedTokenSource(token);
        handshake.CancelAfter(TimeSpan.FromSeconds(30));
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, handshake.Token);
        await ValidateAsync(response, handshake.Token);
        handshake.CancelAfter(Timeout.InfiniteTimeSpan);
        if (response.Content.Headers.ContentType?.MediaType != "text/event-stream")
            throw new BellApiException("新着の応答がSSEではありません。");
        await using var stream = await response.Content.ReadAsStreamAsync(token);
        await foreach (var item in SseReader.ReadAsync(stream, token)) yield return item;
        throw new BellApiException("新着の接続が終了しました。「再接続」を押してください。");
    }

    public void Dispose() => client.Dispose();
}
