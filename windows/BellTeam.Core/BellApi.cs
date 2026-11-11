using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;

namespace BellTeam.Core;

public sealed class BellApiException(string message, HttpStatusCode? status = null, string? code = null) : Exception(message)
{
    public HttpStatusCode? Status { get; } = status;
    // The server's machine-readable "error" value (for example SCREEN_SEAT_ABSENT) when the answer carried one.
    public string? Code { get; } = code;
    // The server may or may not have acted: no HTTP answer, an unreadable answer, or a server error.
    public static bool IsResultUnconfirmed(Exception error) => error is not BellApiException { Status: not null } || (int)((BellApiException)error).Status! >= 500;
    // The update stream closed after it had opened (Mac: 更新の接続が切れました。再接続しています。).
    public const string StreamEndedCode = "EVENTS_ENDED";
    public const string StreamEndedMessage = "更新の接続が切れました。再接続しています。";
    // Mac events(): connecting failed (network, 429, 5xx); retried by the caller.
    public const string ConnectFailedMessage = "更新へ接続できません。再接続しています。";
    // A 403 that carries a server error code is an app refusal (owner required), not a lost sign-in.
    public bool RequiresLogin => Status is HttpStatusCode.Unauthorized || Status is HttpStatusCode.Forbidden && Code is null || (int?)Status is >= 300 and < 400;
}

public sealed class BellApi : IDisposable
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        RespectNullableAnnotations = true
    };
    private readonly HttpClient client;
    public Uri Origin { get; }
    public event Action? AuthenticationRequired;

    public BellApi(Uri origin, HttpMessageHandler? handler = null, CookieContainer? cookies = null)
    {
        Origin = origin;
        client = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false, CookieContainer = cookies ?? new CookieContainer() })
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

    public Task<string> SendAsync(ChatTarget target, string text, string[]? targets, CancellationToken token = default)
        => SendAsync(target, text, [], targets, token);
    // Returns the id the history will carry for this message (Mac messageID(for:)): a room answers "id", a member "delivery_id"
    // (src/conversation/results.mjs user.post; the Mac reads it through convertFromSnakeCase).
    public async Task<string> SendAsync(ChatTarget target, string text, ImageAttachment[] images, string[]? targets, CancellationToken token = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, target.Path + "/messages")
        {
            Content = JsonContent.Create(new { message = TextContent.Normalize(text), images = images.Select(image => new ImagePayload(image.Mime, Convert.ToBase64String(image.Bytes))).ToArray(), targets }, options: Json)
        };
        var result = await JsonAsync<JsonElement>(request, token);
        if (result.ValueKind == JsonValueKind.Object && result.TryGetProperty(target.IsRoom ? "id" : "delivery_id", out var id) && id.ValueKind == JsonValueKind.String && id.GetString() is { Length: > 0 } accepted) return accepted;
        throw new BellApiException("BellTeamからの送信応答を読み取れませんでした。");
    }

    // Never retried by the caller: a stop whose result is unknown is reported, not resent.
    public async Task<BotStopOutcome> StopBotAsync(string botId, CancellationToken token = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, new ChatTarget(botId, false).Path + "/stop");
        var (result, status) = await JsonWithStatusAsync<BotStopResponse>(request, token);
        return result.Outcome(status, botId) ?? throw new BellApiException("BellTeamからの応答を読み取れませんでした。");
    }
    public async Task<T> PostAsync<T>(string path, object body, CancellationToken token = default, TimeSpan? limit = null)
        => await WriteAsync<T>(HttpMethod.Post, path, body, token, limit);
    public async Task<T> WriteAsync<T>(HttpMethod method, string path, object body, CancellationToken token = default, TimeSpan? limit = null)
    {
        using var request = new HttpRequestMessage(method, path) { Content = JsonContent.Create(body, options: Json) };
        return await JsonAsync<T>(request, token, limit);
    }
    public async Task DeleteAsync(string path, CancellationToken token = default)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(30));
        using var request = new HttpRequestMessage(HttpMethod.Delete, path);
        using var response = await client.SendAsync(request, timeout.Token);
        await ValidateAsync(response, timeout.Token);
    }
    public async Task<SecretRequest> FinishSecretAsync(string id, SecretSubmission? submission, CancellationToken token = default)
    {
        // 専用POST。値を例外・診断へ含めず、リダイレクト先へ本文を渡さない。
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/secret-requests/{Uri.EscapeDataString(id)}/{(submission is null ? "cancel" : "submit")}")
            {
                Content = JsonContent.Create(submission?.Body ?? [], options: Json)
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

    private async Task<T> JsonAsync<T>(HttpRequestMessage request, CancellationToken token, TimeSpan? limit = null) => (await JsonWithStatusAsync<T>(request, token, limit)).Value;
    private async Task<(T Value, int Status)> JsonWithStatusAsync<T>(HttpRequestMessage request, CancellationToken token, TimeSpan? limit = null)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(limit ?? TimeSpan.FromSeconds(30));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        using var response = await client.SendAsync(request, timeout.Token);
        await ValidateAsync(response, timeout.Token);
        if (response.Content.Headers.ContentType?.MediaType != "application/json")
            throw new BellApiException("BellTeamからの応答がJSONではありません。接続先を確認してください。");
        try
        {
            return (await response.Content.ReadFromJsonAsync<T>(Json, timeout.Token)
                ?? throw new BellApiException("BellTeamからの応答が空です。"), (int)response.StatusCode);
        }
        catch (JsonException error) { throw new BellApiException("BellTeamからの応答を読み取れませんでした。" + error.Message); }
    }

    private async Task ValidateAsync(HttpResponseMessage response, CancellationToken token)
    {
        var status = (int)response.StatusCode;
        // Every server 403 is a JSON {"error": "..._OWNER_REQUIRED"} refusal; Cloudflare Access answers with a redirect, 401 or a non-JSON 403.
        // Only the latter means "sign in again" (Kiro: keep the Cloudflare Access text for a real access failure only).
        string? body = null;
        if (status == 403 && response.Content.Headers.ContentType?.MediaType == "application/json")
        {
            body = await response.Content.ReadAsStringAsync(token);
            if (ErrorCode(body) is { } refusal) throw new BellApiException("BellTeam: " + refusal, response.StatusCode, refusal);
        }
        if (status is >= 300 and < 400 || status is 401 or 403)
        {
            AuthenticationRequired?.Invoke();
            throw new BellApiException("Cloudflare Accessへログインしてください。", response.StatusCode);
        }
        if (response.IsSuccessStatusCode) return;
        body ??= await response.Content.ReadAsStringAsync(token);
        string detail = $"HTTP {status}"; string? code = null;
        if (response.Content.Headers.ContentType?.MediaType == "application/json")
        {
            try
            {
                using var document = JsonDocument.Parse(body);
                var root = document.RootElement;
                if (root.TryGetProperty("error", out var codeValue) && codeValue.ValueKind == JsonValueKind.String) code = codeValue.GetString();
                if (root.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.String)
                    detail = message.GetString()!;
                else if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String)
                    detail = error.GetString()!;
            }
            catch (JsonException) { detail += "（エラー応答のJSONを読み取れませんでした）"; }
        }
        throw new BellApiException("BellTeam: " + detail, response.StatusCode, code);
    }
    private static string? ErrorCode(string body)
    {
        try { using var document = JsonDocument.Parse(body); return document.RootElement.ValueKind == JsonValueKind.Object && document.RootElement.TryGetProperty("error", out var code) && code.ValueKind == JsonValueKind.String && code.GetString() is { Length: > 0 } value ? value : null; }
        catch (JsonException) { return null; }
    }

    public async IAsyncEnumerable<JsonElement> EventsAsync([EnumeratorCancellation] CancellationToken token = default)
    {
        using var response = await OpenEventStreamAsync("/api/events", token);
        await using var stream = await response.Content.ReadAsStreamAsync(token);
        await foreach (var item in SseReader.ReadAsync(stream, token)) yield return item;
        throw new BellApiException(BellApiException.StreamEndedMessage, code: BellApiException.StreamEndedCode);
    }

    /// <summary>GET /api/work-graph/events: named snapshot/change events. Bad JSON throws <see cref="JsonException"/>, which the work graph shows and reconnects on.</summary>
    public async IAsyncEnumerable<WorkGraphEvent> WorkGraphEventsAsync(Action onActivity, [EnumeratorCancellation] CancellationToken token = default)
    {
        await foreach (var (name, data) in EventStreamAsync("/api/work-graph/events", onActivity, token))
        {
            using var document = JsonDocument.Parse(data);
            yield return new WorkGraphEvent(name, document.RootElement.Clone());
        }
    }

    /// <summary>Named SSE events of one stream. <paramref name="onActivity"/> runs on open and for every line; the stream ending is an error (the caller reconnects).</summary>
    public async IAsyncEnumerable<(string? Name, string Data)> EventStreamAsync(string path, Action onActivity, [EnumeratorCancellation] CancellationToken token = default)
    {
        using var response = await OpenEventStreamAsync(path, token);
        onActivity();
        await using var stream = await response.Content.ReadAsStreamAsync(token);
        await foreach (var item in SseReader.ReadRawAsync(stream, onActivity, token)) yield return item;
        throw new BellApiException(BellApiException.StreamEndedMessage, code: BellApiException.StreamEndedCode);
    }

    private async Task<HttpResponseMessage> OpenEventStreamAsync(string path, CancellationToken token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        using var handshake = CancellationTokenSource.CreateLinkedTokenSource(token);
        handshake.CancelAfter(TimeSpan.FromSeconds(30));
        var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, handshake.Token);
        try
        {
            await ValidateAsync(response, handshake.Token);
            handshake.CancelAfter(Timeout.InfiniteTimeSpan);
            if (response.Content.Headers.ContentType?.MediaType != "text/event-stream")
                throw new BellApiException("新着の応答がSSEではありません。");
            return response;
        }
        catch { response.Dispose(); throw; }
    }

    public void Dispose() => client.Dispose();
}
