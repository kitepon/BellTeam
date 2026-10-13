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

    public Task SendAsync(ChatTarget target, string text, string[]? targets, CancellationToken token = default)
        => SendAsync(target, text, [], targets, token);
    public async Task SendAsync(ChatTarget target, string text, ImageAttachment[] images, string[]? targets, CancellationToken token = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, target.Path + "/messages")
        {
            Content = JsonContent.Create(new { message = TextContent.Normalize(text), images = images.Select(image => new ImagePayload(image.Mime, Convert.ToBase64String(image.Bytes))).ToArray(), targets }, options: Json)
        };
        var result = await JsonAsync<JsonElement>(request, token);
        if (result.ValueKind != JsonValueKind.Object) throw new BellApiException("BellTeamからの送信応答を読み取れませんでした。");
    }

    public async Task<T> PostAsync<T>(string path, object body, CancellationToken token = default)
        => await WriteAsync<T>(HttpMethod.Post, path, body, token);
    public async Task<T> WriteAsync<T>(HttpMethod method, string path, object body, CancellationToken token = default)
    {
        using var request = new HttpRequestMessage(method, path) { Content = JsonContent.Create(body, options: Json) };
        return await JsonAsync<T>(request, token);
    }
    public async Task DeleteAsync(string path, CancellationToken token = default)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(30));
        using var request = new HttpRequestMessage(HttpMethod.Delete, path);
        using var response = await client.SendAsync(request, timeout.Token);
        await ValidateAsync(response, timeout.Token);
    }
    public async Task<SecretRequest> FinishSecretAsync(string id, string? value, CancellationToken token = default)
    {
        // 専用POST。値を例外・診断へ含めず、リダイレクト先へ本文を渡さない。
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/secret-requests/{Uri.EscapeDataString(id)}/{(value is null ? "cancel" : "submit")}")
            {
                Content = JsonContent.Create(value is null ? new Dictionary<string, string>() : new Dictionary<string, string> { ["value"] = value }, options: Json)
            };
            request.Headers.CacheControl = new CacheControlHeaderValue { NoStore = true };
            return (await JsonAsync<SecretResponse>(request, token)).Request;
        }
        catch (Exception) { throw new BellApiException("登録結果を確認できませんでした。閉じて最新の状態を確認してください。"); }
    }

    public async Task<OwnerQuestion> AnswerAsync(string id, string? choice, string? text, CancellationToken token = default)
        => (await PostAsync<QuestionResponse>($"/api/owner-questions/{Uri.EscapeDataString(id)}/answer", new { choice, text = text is null ? null : TextContent.Normalize(text) }, token)).Question;

    public async Task<byte[]> ImageAsync(string path, CancellationToken token = default)
    {
        var url = new Uri(Origin, path);
        if (url.GetLeftPart(UriPartial.Authority) != Origin.GetLeftPart(UriPartial.Authority))
            throw new BellApiException("画像の接続先がBellTeamと異なります。");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        using var response = await client.SendAsync(request, timeout.Token);
        await ValidateAsync(response, timeout.Token);
        if (response.Content.Headers.ContentType?.MediaType is not ("image/png" or "image/jpeg" or "image/webp" or "image/gif"))
            throw new BellApiException("画像ではない応答を受け取りました。");
        return await response.Content.ReadAsByteArrayAsync(timeout.Token);
    }

    public async Task<byte[]> ExportAsync(ChatTarget target, CancellationToken token = default)
    {
        var document = await GetAsync<JsonElement>(target.Path + "/export", token);
        if (document.ValueKind != JsonValueKind.Object || !document.TryGetProperty("format", out var format) || format.GetString() != "bellteam.conversation.v1")
            throw new BellApiException("会話の書き出し形式を読み取れませんでした。");
        return JsonSerializer.SerializeToUtf8Bytes(document, new JsonSerializerOptions(Json) { WriteIndented = true });
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
