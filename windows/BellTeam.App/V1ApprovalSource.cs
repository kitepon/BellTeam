using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using BellTeam.Core;
using BellTeam.PeerChannel;

namespace BellTeam.App;

/// <summary>
/// Adapter v1 of the 決裁箱 (client-v0.5 5.2, pinned to Approval Box docs/api.md v0.49): the decisions of the Approval Box account over /v1 with the login-billing pass as Bearer, exactly as the Approval Box app reads and answers them.
/// Lists (pending,held with next_cursor; answered,cancelled), one decision, answer {option_id|text, version} with an Idempotency-Key (a 409 carries the current decision and replaces the screen), hold / unhold, request attachments read only, and GET /events (SSE, Last-Event-ID).
/// States: SignedOut (no pass, or a 401: the pass is dropped), NotEntitled (a 402 or /me plan expired), Connecting, Live, Retrying (network, 5xx, 429: 1, 2, 4 … 60 s with no cap, the last view stays). Every state leaves by the same screen's action (Refresh) or the next launch.
/// The body's /api/approvals list, answer, hold and events routes are not on this path. The pass and the decision content are never logged.
/// </summary>
internal sealed class V1ApprovalSource(HttpClient http, Func<bool> signedIn, Action dropPass, Func<TimeSpan, CancellationToken, Task>? delay = null, Func<double>? random = null) : IApprovalSource, IAsyncDisposable
{
    internal static readonly TimeSpan Silence = TimeSpan.FromSeconds(70);
    private readonly Func<TimeSpan, CancellationToken, Task> wait = delay ?? Task.Delay;
    private readonly object gate = new();
    private Dictionary<string, ViewDecision> decisions = [];
    private readonly Dictionary<string, string> keys = [];   // one key per (decision, version, choice): the same press again is the same request
    private CancellationTokenSource? run; private TaskCompletionSource wake = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private string? lastEventId;
    public RuntimeState State { get; private set; } = new(RuntimeStatus.Connecting);
    public IReadOnlyList<ViewDecision> Decisions { get { lock (gate) return [.. decisions.Values]; } }
    public event Action? Changed;

    /// <summary>A failed call: the HTTP status (0 = no answer), the module's error code and the latest decision of a 409.</summary>
    private sealed class V1Failure(int status, string? code = null, ViewDecision? decision = null, TimeSpan? retryAfter = null) : Exception("v1 " + status)
    {
        public int Status { get; } = status; public string? Code { get; } = code; public ViewDecision? Decision { get; } = decision; public TimeSpan? RetryAfter { get; } = retryAfter;
    }

    public void Start() { lock (gate) { if (run is not null) return; run = new CancellationTokenSource(); } _ = RunAsync(run.Token); }
    /// <summary>retryNow, and after a sign-in: ends the wait at once, or starts again after a stop.</summary>
    public void Refresh() { Start(); lock (gate) { wake.TrySetResult(); } }
    public ValueTask DisposeAsync() { CancellationTokenSource? current; lock (gate) { current = run; run = null; } current?.Cancel(); return ValueTask.CompletedTask; }

    private void Set(RuntimeStatus status, string? reason = null)
    {
        var next = new RuntimeState(status, reason);
        if (State == next) return;
        State = next; Changed?.Invoke();
    }
    private async Task WaitAsync(TimeSpan? span, CancellationToken token)
    {
        Task woken; lock (gate) { woken = wake.Task; }
        var timer = span is { } time ? wait(time, token) : Task.Delay(Timeout.Infinite, token);
        try { await Task.WhenAny(woken, timer); token.ThrowIfCancellationRequested(); }
        finally { lock (gate) { if (wake.Task.IsCompleted) wake = new(TaskCreationOptions.RunContinuationsAsynchronously); } }
    }
    private TimeSpan Backoff(int attempt) => TimeSpan.FromMilliseconds(Math.Min(60000, (int)Math.Round(1000 * Math.Pow(2, Math.Max(0, Math.Min(attempt, 6))) * (0.8 + 0.4 * (random ?? Random.Shared.NextDouble)()), MidpointRounding.AwayFromZero)));

    private async Task RunAsync(CancellationToken token)
    {
        var attempt = 0;
        try
        {
            while (!token.IsCancellationRequested)
            {
                if (!signedIn()) { Set(RuntimeStatus.SignedOut); await WaitAsync(null, token); continue; }
                try
                {
                    if (State.Status is RuntimeStatus.SignedOut or RuntimeStatus.NotEntitled) Set(RuntimeStatus.Connecting);
                    if (await GetAsync("me", token) is { } me && me.TryGetProperty("plan", out var plan) && plan.GetString() == "expired") { Set(RuntimeStatus.NotEntitled, "no_entitlement"); await WaitAsync(null, token); continue; }
                    await ReadListsAsync(token);
                    attempt = 0; Set(RuntimeStatus.Live);
                    await StreamAsync(token);
                    Set(RuntimeStatus.Retrying);   // the stream ended: read again (a list read on every reconnect heals a missed event)
                    await WaitAsync(Backoff(attempt++), token);
                }
                catch (V1Failure failure) when (failure.Status == 401) { dropPass(); Set(RuntimeStatus.SignedOut, "pass_ended"); await WaitAsync(null, token); }
                catch (V1Failure failure) when (failure.Status == 402) { Set(RuntimeStatus.NotEntitled, "no_entitlement"); await WaitAsync(null, token); }
                catch (Exception error) when (error is V1Failure or HttpRequestException or IOException or TimeoutException or JsonException)
                {
                    Set(RuntimeStatus.Retrying);
                    await WaitAsync(error is V1Failure { RetryAfter: { } after } ? after : Backoff(attempt++), token);
                }
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    // ---- reading
    private async Task ReadListsAsync(CancellationToken token)
    {
        var next = new Dictionary<string, ViewDecision>();
        string? cursor = null;
        do { var (items, more) = await ListAsync("pending,held", cursor, token); foreach (var item in items) next[item.Id!] = item; cursor = more; } while (cursor is not null);
        foreach (var item in (await ListAsync("answered,cancelled", null, token)).Items) next.TryAdd(item.Id!, item);   // the recent ones: the first page
        lock (gate) decisions = next;
        Changed?.Invoke();
    }
    private async Task<(IReadOnlyList<ViewDecision> Items, string? Next)> ListAsync(string statuses, string? cursor, CancellationToken token)
        => ApprovalsV1.ParseList(await GetAsync("decisions?status=" + statuses + "&limit=50" + (cursor is null ? "" : "&cursor=" + Uri.EscapeDataString(cursor)), token) ?? throw new V1Failure(0));
    private async Task<JsonElement?> GetAsync(string path, CancellationToken token)
    {
        var (status, body, _) = await SendAsync(HttpMethod.Get, path, null, null, token);
        if (status == 404) return null;
        return Ok(status) ? body : throw Failure(status, body);
    }
    private static bool Ok(int status) => status is >= 200 and < 300;
    private static V1Failure Failure(int status, JsonElement? body, TimeSpan? retryAfter = null)
    {
        string? code = null; ViewDecision? latest = null;
        if (body is { ValueKind: JsonValueKind.Object } root && root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object)
        {
            code = error.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
            if (error.TryGetProperty("decision", out var d)) latest = ApprovalsV1.Parse(d);
        }
        return new V1Failure(status, code, latest, retryAfter);
    }
    // One call with its own 30 s limit (the events stream has none); the body is read whole and its content never leaves this method except as the parsed result.
    private async Task<(int Status, JsonElement? Body, TimeSpan? RetryAfter)> SendAsync(HttpMethod method, string path, object? body, string? key, CancellationToken token)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token); limit.CancelAfter(TimeSpan.FromSeconds(30));
        using var request = new HttpRequestMessage(method, path);
        if (body is not null) request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        if (key is not null) request.Headers.TryAddWithoutValidation("Idempotency-Key", key);
        try
        {
            using var response = await http.SendAsync(request, limit.Token);
            var text = await response.Content.ReadAsStringAsync(limit.Token);
            JsonElement? json = null;
            if (text.Length > 0) try { json = JsonDocument.Parse(text).RootElement.Clone(); } catch (JsonException) { }
            return ((int)response.StatusCode, json, response.Headers.RetryAfter?.Delta);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { throw new TimeoutException(); }
    }

    private async Task StreamAsync(CancellationToken token)
    {
        using var silence = CancellationTokenSource.CreateLinkedTokenSource(token);
        void Arm() { try { silence.CancelAfter(Silence); } catch (ObjectDisposedException) { } }
        using var request = new HttpRequestMessage(HttpMethod.Get, "events");
        request.Headers.Accept.ParseAdd("text/event-stream"); if (lastEventId is not null) request.Headers.TryAddWithoutValidation("Last-Event-ID", lastEventId);
        try
        {
            Arm();
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, silence.Token);
            if (!response.IsSuccessStatusCode) throw Failure((int)response.StatusCode, null, response.Headers.RetryAfter?.Delta);
            await using var stream = await response.Content.ReadAsStreamAsync(silence.Token);
            await foreach (var (name, data) in SseReader.ReadRawAsync(stream, Arm, id => lastEventId = id, silence.Token))
            {
                if (name is not ("decision.created" or "decision.updated" or "decision.deleted")) continue;
                JsonElement root; try { root = JsonDocument.Parse(data).RootElement.Clone(); } catch (JsonException) { continue; }
                if (!root.TryGetProperty("decision_id", out var id) || id.ValueKind != JsonValueKind.String) continue;
                if (name == "decision.deleted") Remove(id.GetString()!); else await ReadOneAsync(id.GetString()!, token);
            }
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { }   // 70 s of silence: the caller reads again
    }
    private async Task ReadOneAsync(string id, CancellationToken token)
    {
        var one = await GetAsync("decisions/" + Uri.EscapeDataString(id), token);
        if (one is { } element && ApprovalsV1.Parse(element) is { } decision) Put(decision); else Remove(id);
    }
    private void Put(ViewDecision decision) { lock (gate) decisions = new(decisions) { [decision.Id!] = decision }; Changed?.Invoke(); }
    private void Remove(string id) { lock (gate) { decisions = new(decisions); decisions.Remove(id); } Changed?.Invoke(); }

    // ---- writing: one try each; a lost answer is sent again by the person's next press with the same key
    public Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text, long version)
    {
        string? normalized = text is null ? null : TextContent.Normalize(text);
        var key = KeyFor($"answer|{decisionId}|{version}|{optionId}|{normalized}");
        return WriteAsync(decisionId, $"decisions/{Uri.EscapeDataString(decisionId)}/answer", Body(("option_id", optionId), ("text", normalized), ("version", version)), key);
    }
    // The server's schema takes an absent field, never a null (z.string().optional()): a null text was refused with 400 on the first live run.
    private static Dictionary<string, object> Body(params (string Name, object? Value)[] fields) => fields.Where(f => f.Value is not null).ToDictionary(f => f.Name, f => f.Value!);
    public Task<SendOutcome> HoldAsync(string decisionId, bool held) => WriteAsync(decisionId, $"decisions/{Uri.EscapeDataString(decisionId)}/{(held ? "hold" : "unhold")}", new { }, KeyFor($"hold|{decisionId}|{held}|{Guid.NewGuid()}"));
    private string KeyFor(string press) { lock (gate) return keys.TryGetValue(press, out var key) ? key : keys[press] = Guid.NewGuid().ToString(); }
    private async Task<SendOutcome> WriteAsync(string decisionId, string path, object body, string key)
    {
        try
        {
            var (status, json, _) = await SendAsync(HttpMethod.Post, path, body, key, CancellationToken.None);
            if (Ok(status) && json is { } ok && ApprovalsV1.Parse(ok) is { } updated) { Put(updated); return new("ok"); }
            var failure = Failure(status, json);
            switch (status)
            {
                case 409 when failure.Decision is { } latest:
                    Put(latest);   // the screen is replaced with the current decision, the typed text stays with the screen
                    return new(latest.Status is "pending" or "held" ? "refused:stale_version" : "refused:already_decided");
                case 401: dropPass(); Set(RuntimeStatus.SignedOut, "pass_ended"); return new("no_session");
                case 402: Set(RuntimeStatus.NotEntitled, "no_entitlement"); return new("refused:no_entitlement");
                case 404: Remove(decisionId); return new("gone");
                default: return new("failed");
            }
        }
        catch (Exception error) when (error is HttpRequestException or TimeoutException or IOException) { return new("unknown"); }   // sent, no answer: the same key makes a second press harmless
    }

    public async Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId)
    {
        try
        {
            using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            using var response = await http.GetAsync($"decisions/{Uri.EscapeDataString(decisionId)}/attachments/{Uri.EscapeDataString(attachmentId)}", limit.Token);
            return response.IsSuccessStatusCode ? await response.Content.ReadAsByteArrayAsync(limit.Token) : null;
        }
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException or IOException) { return null; }
    }
}
