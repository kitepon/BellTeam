using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BellTeam.Core;
using BellTeam.PeerChannel;

namespace BellTeam.Linux;

/// <summary>An answer of Approval Box's /v1 that is not 2xx: <c>{error:{code, message, decision?}}</c> (docs/api.md "エラー").</summary>
internal sealed class V1Exception(int status, string code, JsonElement? decision) : Exception("v1 " + status + " " + code)
{
    public int Status { get; } = status; public string Code { get; } = code; public JsonElement? Decision { get; } = decision;
}

/// <summary>
/// The v1 adapter (client-v0.5.md 5.2, pinned to Approval Box docs/api.md v0.49): the person's decisions over <c>/v1</c> with the Approval Box pass as Bearer. List, one, answer (version + Idempotency-Key), hold, unhold,
/// attachments (read only) and the SSE <c>/events</c> with Last-Event-ID. Nothing is kept on disk: decision content lives in memory for the length of the view. No push.
/// One loop runs at a time. A failed attempt shows Retrying and tries again after 1, 2, 4 ... 60 s with no cap on the count; 「今すぐ試す」 (<see cref="Refresh"/>) ends the wait early and never starts a second loop.
/// 401 drops the pass (SignedOut, pass_ended), 402 is NotEntitled, both leave by <see cref="Refresh"/> or the next launch.
/// </summary>
internal sealed class ApprovalBoxV1Source : IApprovalSource, IDisposable
{
    private readonly Func<CancellationToken, Task<ServerAccess>> access;
    private readonly Func<IReadOnlyList<(string Id, string Name)>> roster;
    private readonly HttpClient http, stream;
    private readonly CancellationTokenSource life = new();
    private readonly object gate = new();
    private readonly Dictionary<string, string> keys = [];   // one Idempotency-Key per not-yet-settled write, so pressing again after an unknown outcome never doubles it
    private Dictionary<string, JsonElement> held = [];
    private List<ViewDecision> items = [];
    private RuntimeState state = new(RuntimeStatus.Connecting);
    private CancellationTokenSource? run;
    private TaskCompletionSource kick = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private string? lastEventId;

    /// <summary>Asked before every attempt (start, each retry, after sign-in): false = the server wants /pc/v1 now, this loop stops.</summary>
    internal Func<CancellationToken, Task<bool>>? BeforeAttempt { get; set; }
    /// <summary>The server refused the pass (401): the account drops it (the person signs in again).</summary>
    internal Action? PassEnded { get; set; }

    internal ApprovalBoxV1Source(Func<CancellationToken, Task<ServerAccess>> access, Func<IReadOnlyList<(string Id, string Name)>> roster, HttpMessageHandler? handler = null)
    {
        this.access = access; this.roster = roster;
        http = handler is null ? new HttpClient { Timeout = TimeSpan.FromSeconds(30) } : new HttpClient(handler, false) { Timeout = TimeSpan.FromSeconds(30) };
        stream = handler is null ? new HttpClient { Timeout = Timeout.InfiniteTimeSpan } : new HttpClient(handler, false) { Timeout = Timeout.InfiniteTimeSpan };
    }

    public event Action? Changed;
    public IReadOnlyList<ViewDecision> Decisions { get { lock (gate) return items; } }
    public RuntimeState State { get { lock (gate) return state; } }
    // A signed-out account holds nothing: the list of the account that left is dropped with its pass.
    private void Set(RuntimeState next) { lock (gate) { if (state == next) return; state = next; if (next.Status == RuntimeStatus.SignedOut) { held = []; items = []; } } Changed?.Invoke(); }

    internal void Start() => Resume();
    internal void Resume() { lock (gate) { if (run is not null) return; run = CancellationTokenSource.CreateLinkedTokenSource(life.Token); var mine = run.Token; _ = Task.Run(() => LoopAsync(mine)); } }
    internal void Park() { lock (gate) { run?.Cancel(); run = null; } }
    public void Refresh() { TaskCompletionSource now; lock (gate) { now = kick; kick = new(TaskCreationOptions.RunContinuationsAsynchronously); } now.TrySetResult(); }
    public void Dispose() { life.Cancel(); http.Dispose(); stream.Dispose(); }
    private Task Kicked() { lock (gate) return kick.Task; }

    private async Task LoopAsync(CancellationToken ct)
    {
        var wait = TimeSpan.FromSeconds(1);
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (BeforeAttempt is { } before && !await before(ct)) { lock (gate) run = null; return; }
                var now = await access(ct);
                await ReadAllAsync(now, ct);
                Set(new(RuntimeStatus.Live)); wait = TimeSpan.FromSeconds(1);
                await StreamAsync(ct);
                throw new HttpRequestException("the event stream ended");   // the list is read again on every reconnect: that heals a missed event
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (SignedOutException) { Set(new(RuntimeStatus.SignedOut)); await WaitAsync(Timeout.InfiniteTimeSpan, ct); }
            catch (V1Exception e) when (e.Status == 401) { PassEnded?.Invoke(); Set(new(RuntimeStatus.SignedOut, "pass_ended")); await WaitAsync(Timeout.InfiniteTimeSpan, ct); }
            catch (V1Exception e) when (e.Status == 402) { Set(new(RuntimeStatus.NotEntitled)); await WaitAsync(Timeout.InfiniteTimeSpan, ct); }
            // 410 gone: Approval Box closed its /v1 content (Nayuta, api.md v0.48 code; Delta Q4). This build has no other path for it: the update line, left by 「今すぐ試す」 or the next launch.
            catch (V1Exception e) when (e.Status == 410) { Set(new(RuntimeStatus.Stopped, "update_needed")); await WaitAsync(Timeout.InfiniteTimeSpan, ct); }
            catch (Exception error) when (error is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                // Network, 5xx, 429, an unreadable answer: every one of them is recoverable, so none ends the loop. The reason is never shown as text (the screen says 「つなぎ直しています」).
                Set(new(RuntimeStatus.Retrying, error.GetType().Name));
                await WaitAsync(wait, ct); wait = TimeSpan.FromSeconds(Math.Min(wait.TotalSeconds * 2, 60));
            }
        }
    }

    // Waits for the time or for Refresh (「今すぐ試す」 / 「確かめ直す」), whichever comes first; a stop ends the wait quietly.
    private async Task WaitAsync(TimeSpan time, CancellationToken ct) { try { await Task.WhenAny(Kicked(), Task.Delay(time, ct)); } catch (OperationCanceledException) { } }

    // ---- the wire
    private static Uri Url(ServerAccess now, string path) => new(new Uri(now.Url.GetLeftPart(UriPartial.Authority)), "/v1" + path);
    private static void Auth(HttpRequestMessage request, ServerAccess now) { foreach (var (name, value) in now.Headers) request.Headers.TryAddWithoutValidation(name, value); }

    private async Task<(JsonDocument Body, HttpResponseMessage Reply)> SendAsync(HttpMethod method, string path, object? body, string? key, CancellationToken ct)
    {
        var now = await access(ct);
        using var request = new HttpRequestMessage(method, Url(now, path));
        Auth(request, now);
        if (key is not null) request.Headers.TryAddWithoutValidation("Idempotency-Key", key);
        if (body is not null) request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        var reply = await http.SendAsync(request, ct);
        var text = await reply.Content.ReadAsStringAsync(ct);
        JsonDocument json; try { json = JsonDocument.Parse(text.Length == 0 ? "{}" : text); } catch (JsonException) { json = JsonDocument.Parse("{}"); }
        if (reply.IsSuccessStatusCode) return (json, reply);
        var error = json.RootElement.TryGetProperty("error", out var e) ? e : default;
        throw new V1Exception((int)reply.StatusCode, error.ValueKind == JsonValueKind.Object && error.TryGetProperty("code", out var code) ? code.GetString() ?? "" : "", error.ValueKind == JsonValueKind.Object && error.TryGetProperty("decision", out var decision) ? decision.Clone() : null);
    }

    private async Task ReadAllAsync(ServerAccess now, CancellationToken ct)
    {
        var (me, _) = await SendAsync(HttpMethod.Get, "/me", null, null, ct);
        if (me.RootElement.TryGetProperty("plan", out var plan) && plan.GetString() == "expired") throw new V1Exception(402, "subscription_expired", null);
        var all = new Dictionary<string, JsonElement>();
        // The open list in full; the answered/cancelled history is the recent part only (shortcut: 4 pages of 50, raise when the screen pages its history).
        await PagesAsync("pending,held", int.MaxValue, all, ct); await PagesAsync("answered,cancelled", 4, all, ct);
        lock (gate) { held = all; items = [.. all.Values.Select(Map).OfType<ViewDecision>()]; }
        Changed?.Invoke();
    }

    private async Task PagesAsync(string status, int pages, Dictionary<string, JsonElement> into, CancellationToken ct)
    {
        string? cursor = null;
        for (var page = 0; page < pages; page++)
        {
            var (body, _) = await SendAsync(HttpMethod.Get, "/decisions?status=" + status + "&limit=50" + (cursor is null ? "" : "&cursor=" + Uri.EscapeDataString(cursor)), null, null, ct);
            if (body.RootElement.TryGetProperty("items", out var list) && list.ValueKind == JsonValueKind.Array)
                foreach (var one in list.EnumerateArray()) if (one.TryGetProperty("id", out var id) && id.GetString() is { } text) into[text] = one.Clone();
            cursor = body.RootElement.TryGetProperty("next_cursor", out var next) && next.ValueKind == JsonValueKind.String ? next.GetString() : null;
            if (cursor is null) return;
        }
    }

    private void Upsert(string id, JsonElement? decision)
    {
        lock (gate)
        {
            if (decision is { } now) held[id] = now.Clone(); else held.Remove(id);
            items = [.. held.Values.Select(Map).OfType<ViewDecision>()];
        }
        Changed?.Invoke();
    }

    private async Task StreamAsync(CancellationToken ct)
    {
        var now = await access(ct);
        using var request = new HttpRequestMessage(HttpMethod.Get, Url(now, "/events"));
        Auth(request, now); request.Headers.TryAddWithoutValidation("Accept", "text/event-stream");
        if (lastEventId is not null) request.Headers.TryAddWithoutValidation("Last-Event-ID", lastEventId);
        using var reply = await stream.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!reply.IsSuccessStatusCode) throw new V1Exception((int)reply.StatusCode, "", null);
        using var reader = new StreamReader(await reply.Content.ReadAsStreamAsync(ct));
        string? name = null, id = null; var data = new StringBuilder();
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (line.Length == 0)
            {
                if (name is not null && data.Length > 0) await OnEventAsync(name, data.ToString(), ct);
                if (id is not null) lastEventId = id;
                name = id = null; data.Clear(); continue;
            }
            if (line[0] == ':') continue;   // a comment (heartbeat)
            var colon = line.IndexOf(':'); var field = colon < 0 ? line : line[..colon]; var value = colon < 0 ? "" : line[(colon + 1)..].TrimStart(' ');
            switch (field) { case "event": name = value; break; case "id": id = value; break; case "data": if (data.Length > 0) data.Append('\n'); data.Append(value); break; }
        }
    }

    private async Task OnEventAsync(string name, string data, CancellationToken ct)
    {
        if (name is not ("decision.created" or "decision.updated" or "decision.deleted")) return;
        string? decisionId; try { using var doc = JsonDocument.Parse(data); decisionId = doc.RootElement.TryGetProperty("decision_id", out var d) ? d.GetString() : null; } catch (JsonException) { return; }
        if (decisionId is null) return;
        if (name == "decision.deleted") { Upsert(decisionId, null); return; }
        try { var (one, _) = await SendAsync(HttpMethod.Get, "/decisions/" + Uri.EscapeDataString(decisionId), null, null, ct); Upsert(decisionId, one.RootElement); }
        catch (V1Exception e) when (e.Status == 404) { Upsert(decisionId, null); }
    }

    // ---- writes
    private string KeyFor(string what) { lock (gate) { if (!keys.TryGetValue(what, out var key)) keys[what] = key = Guid.NewGuid().ToString(); return key; } }
    private void Settled(string what) { lock (gate) keys.Remove(what); }

    public async Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text, long version)
    {
        var what = "answer|" + decisionId + "|" + version + "|" + optionId + "|" + text;
        object body = optionId is not null ? new { option_id = optionId, version } : new { text, version };
        return await WriteAsync(what, decisionId, "/decisions/" + Uri.EscapeDataString(decisionId) + "/answer", body);
    }

    public Task<SendOutcome> HoldAsync(string decisionId, bool heldNow) => WriteAsync((heldNow ? "hold|" : "unhold|") + decisionId, decisionId, "/decisions/" + Uri.EscapeDataString(decisionId) + (heldNow ? "/hold" : "/unhold"), null);

    // A write is never sent again by itself: an unknown outcome is shown, and pressing again reuses the same Idempotency-Key, so it cannot double.
    private async Task<SendOutcome> WriteAsync(string what, string decisionId, string path, object? body)
    {
        try
        {
            var (reply, _) = await SendAsync(HttpMethod.Post, path, body, KeyFor(what), life.Token);
            Settled(what); Upsert(decisionId, reply.RootElement); return new("ok");
        }
        catch (V1Exception conflict) when (conflict.Status == 409)
        {
            Settled(what);
            if (conflict.Decision is { } current) Upsert(decisionId, current);
            var open = conflict.Decision is { } d && d.TryGetProperty("status", out var status) && status.GetString() is "pending" or "held";
            return new(open ? "refused:stale_version" : "refused:already_decided");
        }
        catch (V1Exception e) when (e.Status == 404) { Settled(what); Upsert(decisionId, null); return new("refused:already_decided"); }
        catch (V1Exception e) when (e.Status == 401) { PassEnded?.Invoke(); Set(new(RuntimeStatus.SignedOut, "pass_ended")); return new("refused:unauthorized"); }
        catch (V1Exception e) when (e.Status == 402) { Set(new(RuntimeStatus.NotEntitled)); return new("refused:subscription_expired"); }
        catch (V1Exception refused) when (refused.Status is >= 400 and < 500 and not 429) { Settled(what); return new("refused:" + refused.Code); }
        catch (SignedOutException) { Set(new(RuntimeStatus.SignedOut)); return new("refused:unauthorized"); }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or V1Exception) { return new("unknown"); }
    }

    public async Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId)
    {
        ViewDecision? decision; lock (gate) decision = items.FirstOrDefault(item => item.Id == decisionId);
        var meta = decision?.RequestAttachments?.Concat(decision.Answer?.Attachments ?? []).FirstOrDefault(item => item.Id == attachmentId);
        try
        {
            var now = await access(life.Token);
            using var request = new HttpRequestMessage(HttpMethod.Get, Url(now, "/decisions/" + Uri.EscapeDataString(decisionId) + "/attachments/" + Uri.EscapeDataString(attachmentId)));
            Auth(request, now);
            using var reply = await http.SendAsync(request, life.Token);
            if (!reply.IsSuccessStatusCode) return null;
            var bytes = await reply.Content.ReadAsByteArrayAsync(life.Token);
            // The size and SHA-256 the decision names must match what arrived (api.md "申請画像").
            if (meta is not null && ((meta.Size > 0 && meta.Size != bytes.Length) || (meta.Sha256 is { Length: > 0 } sha && !string.Equals(Convert.ToHexStringLower(SHA256.HashData(bytes)), sha, StringComparison.OrdinalIgnoreCase)))) return null;
            return bytes;
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or SignedOutException) { return null; }
    }

    // ---- Decision JSON -> what the screen draws: Core's ApprovalsV1 (the /v1 read) and ApprovalOriginRule (the four rules against the member list)
    private ViewDecision? Map(JsonElement d) => ApprovalsV1.Parse(d) is { } decision ? ApprovalOriginRule.Apply(decision, roster()) : null;
}
