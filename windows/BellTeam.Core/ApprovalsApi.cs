using System.Runtime.CompilerServices;
using System.Text.Json;

namespace BellTeam.Core;

/// <summary>One answer of /api/approvals/*: status 0 = no answer (network, timeout, 5xx-like), 401 = the BellTeam sign-in is lost (not the module's 409 not_connected).</summary>
public sealed record ApprovalResponse(int Status, JsonElement? Body)
{
    public bool Ok => Status is >= 200 and < 300;
    public bool LoginRequired => Status == 401;
    public ApprovalFailure Failure => Approvals.FailureOf(Status, Body);
    public ViewDecision? Decision => Ok ? Approvals.ParseDecision(Body) : null;
    public ApprovalSummary? Summary
        => Ok && Parse<ApprovalSummary>() is { Schema: Approvals.SummarySchema } summary ? summary : null;
    public ApprovalList? List => Ok ? Parse<ApprovalList>() : null;
    public ApprovalConnection? Connection => Ok ? Parse<ApprovalConnection>() : null;
    public ApprovalConnectStart? Start => Ok ? Parse<ApprovalConnectStart>() : null;
    public string? ErrorMessage => Body is { ValueKind: JsonValueKind.Object } root && root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object
        && error.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.String ? message.GetString() : null;
    private T? Parse<T>() where T : class
    {
        try { return Body is { ValueKind: JsonValueKind.Object } root ? JsonSerializer.Deserialize<T>(root.GetRawText(), BellApi.Json) : null; }
        catch (JsonException) { return null; }
    }
}

/// <summary>The app contract of the 決裁箱拡張 (served by BellTeam, never Approval Box itself). Every call returns the answer; nothing here retries, and the writes are never resent on their own.</summary>
public static class ApprovalsApi
{
    private static async Task<ApprovalResponse> CallAsync(BellApi api, HttpMethod method, string path, object? body, string? key, CancellationToken token)
    {
        try { var (status, json) = await api.RawAsync(method, path, body, key, token); return new(status, json); }
        catch (BellApiException error) when (error.RequiresLogin) { return new(401, null); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        // Network failure and the 30 s timeout both mean "no answer": the caller shows the reconnect view or keeps the answer for another press.
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException or BellApiException) { return new(0, null); }
    }
    private static string Id(string id) => Uri.EscapeDataString(id);

    public static Task<ApprovalResponse> ApprovalSummaryAsync(this BellApi api, CancellationToken token = default) => CallAsync(api, HttpMethod.Get, "/api/approvals/summary", null, null, token);
    /// <summary><paramref name="statuses"/> is "pending,held" or "answered,cancelled" (with a cursor for the next page of 済み).</summary>
    public static Task<ApprovalResponse> ApprovalListAsync(this BellApi api, string statuses, string? cursor = null, CancellationToken token = default)
        => CallAsync(api, HttpMethod.Get, $"/api/approvals?status={statuses}{(cursor is { Length: > 0 } ? $"&cursor={Uri.EscapeDataString(cursor)}" : "")}", null, null, token);
    public static Task<ApprovalResponse> ApprovalAsync(this BellApi api, string id, CancellationToken token = default) => CallAsync(api, HttpMethod.Get, $"/api/approvals/{Id(id)}", null, null, token);
    /// <summary>One answer: the key stays the same for a repeat of the same press (same decision, same choice) so a resend is harmless on the server.</summary>
    public static Task<ApprovalResponse> ApprovalAnswerAsync(this BellApi api, string id, string? optionId, string? text, long version, string idempotencyKey, CancellationToken token = default)
        => CallAsync(api, HttpMethod.Post, $"/api/approvals/{Id(id)}/answer", new { optionId, text = text is null ? null : TextContent.Normalize(text), version }, idempotencyKey, token);
    public static Task<ApprovalResponse> ApprovalHoldAsync(this BellApi api, string id, bool hold, CancellationToken token = default)
        => CallAsync(api, HttpMethod.Post, $"/api/approvals/{Id(id)}/{(hold ? "hold" : "unhold")}", new { }, null, token);
    public static Task<ApprovalResponse> ApprovalConnectionAsync(this BellApi api, CancellationToken token = default) => CallAsync(api, HttpMethod.Get, "/api/approvals/connection", null, null, token);
    public static Task<ApprovalResponse> ApprovalConnectAsync(this BellApi api, CancellationToken token = default) => CallAsync(api, HttpMethod.Post, "/api/approvals/connect", new { }, null, token);
    public static Task<ApprovalResponse> ApprovalStopConnectAsync(this BellApi api, CancellationToken token = default) => CallAsync(api, HttpMethod.Delete, "/api/approvals/connect", null, null, token);
    public static Task<ApprovalResponse> ApprovalDisconnectAsync(this BellApi api, CancellationToken token = default) => CallAsync(api, HttpMethod.Delete, "/api/approvals/connection", null, null, token);
    /// <summary>The bytes of a request or answer image (png/jpeg/gif/webp only; BellApi.ImageAsync checks the origin and type). The caller checks size and sha256 against the body.</summary>
    public static Task<byte[]> ApprovalAttachmentAsync(this BellApi api, string id, string attachmentId, CancellationToken token = default)
        => api.ImageAsync($"/api/approvals/{Id(id)}/attachments/{Id(attachmentId)}", token);

    public enum ApprovalEventKind { Summary, Created, Updated, Deleted }
    public sealed record ApprovalEvent(ApprovalEventKind Kind, ApprovalSummary? Summary, string? Id, long Version);
    /// <summary>GET /api/approvals/events: summary and decision.created|updated|deleted. Ends only by an error (the feed reconnects); unknown events and unreadable frames of a known event are skipped or thrown as BellApiException.</summary>
    public static async IAsyncEnumerable<ApprovalEvent> ApprovalEventsAsync(this BellApi api, Action onActivity, [EnumeratorCancellation] CancellationToken token = default)
    {
        await foreach (var (name, data) in api.EventStreamAsync("/api/approvals/events", onActivity, token))
        {
            if (name is not ("summary" or "decision.created" or "decision.updated" or "decision.deleted")) continue;
            JsonElement root;
            try { using var document = JsonDocument.Parse(data); root = document.RootElement.Clone(); }
            catch (JsonException error) { throw new BellApiException("決裁のデータを読み取れませんでした。" + error.Message); }
            if (name == "summary")
            {
                ApprovalSummary? summary = null;
                try { summary = JsonSerializer.Deserialize<ApprovalSummary>(root.GetRawText(), BellApi.Json); } catch (JsonException) { }
                if (summary is { Schema: Approvals.SummarySchema }) yield return new(ApprovalEventKind.Summary, summary, null, 0);
            }
            else if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String)
                yield return new(name == "decision.created" ? ApprovalEventKind.Created : name == "decision.updated" ? ApprovalEventKind.Updated : ApprovalEventKind.Deleted, null, id.GetString(),
                    root.TryGetProperty("version", out var version) && version.TryGetInt64(out var number) ? number : 0);
        }
    }
}

public enum ApprovalFeedStatus { Connecting, Live, Drop, Old, NotEntitled, Expired, NoCredential, LoginRequired }

/// <summary>
/// The one reader of 決裁箱 (the entry badge and the screen share it; port of web/approvals-feed.js). Reads GET /summary, then holds GET /events; while the stream holds nothing is read on a timer.
/// When it cannot (no answer, 5xx, a dropped stream, 35 s of silence) it reads again after 1, 2, 4 … 30 s for as long as it runs, never giving up. 404 / 402 / 403 / 409 and a lost sign-in do not change by waiting:
/// the loop stops with that status and leaves only by <see cref="Refresh"/> (読み直す, opening the screen, coming to the front).
/// </summary>
public sealed class ApprovalsFeed(BellApi api, Func<TimeSpan, CancellationToken, Task>? delay = null, Func<double>? random = null)
{
    public static readonly TimeSpan Silence = TimeSpan.FromSeconds(35);
    private readonly Func<TimeSpan, CancellationToken, Task> wait = delay ?? Task.Delay;
    private CancellationTokenSource? run;
    private bool resynced;
    public ApprovalSummary? Summary { get; private set; }
    public ApprovalFeedStatus Status { get; private set; } = ApprovalFeedStatus.Connecting;
    public ApprovalFailure? Failure { get; private set; }
    public bool Running => run is not null;
    /// <summary>The loop currently running (tests and shutdown await it).</summary>
    public Task Loop { get; private set; } = Task.CompletedTask;
    public event Action? SummaryChanged, StatusChanged, Resynced;
    public event Action<ApprovalsApi.ApprovalEvent>? DecisionChanged;

    public void Start() { if (run is null) Begin(); }
    /// <summary>Starts a read at once: the waiting one is not waited for, and a stopped feed starts again. The old loop ends; there is never a second one.</summary>
    public void Refresh() { Stop(); Begin(); }
    public void Stop() { var current = run; run = null; current?.Cancel(); }
    private void Begin() { var source = run = new CancellationTokenSource(); Loop = RunAsync(source); }

    private void Set(ApprovalFeedStatus status, ApprovalFailure? failure = null)
    {
        Failure = failure;
        if (status == Status) return;
        Status = status; StatusChanged?.Invoke();
    }
    private static ApprovalFeedStatus Terminal(ApprovalFailure failure) => failure switch
    {
        ApprovalFailure.Old => ApprovalFeedStatus.Old, ApprovalFailure.NotEntitled => ApprovalFeedStatus.NotEntitled, ApprovalFailure.Expired => ApprovalFeedStatus.Expired, _ => ApprovalFeedStatus.NoCredential
    };

    private async Task RunAsync(CancellationTokenSource source)
    {
        var token = source.Token; var attempt = 0;
        try
        {
            while (!token.IsCancellationRequested)
            {
                var read = await api.ApprovalSummaryAsync(token);
                if (token.IsCancellationRequested) return;
                if (read.LoginRequired) { Set(ApprovalFeedStatus.LoginRequired); return; }
                if (!read.Ok && read.Failure is var failure && Approvals.IsTerminal(failure))
                {
                    if (failure == ApprovalFailure.Old) Summary = null;
                    Set(Terminal(failure), failure); return;
                }
                if (read.Summary is { } summary)
                {
                    attempt = 0; Summary = summary; SummaryChanged?.Invoke(); Set(ApprovalFeedStatus.Live);
                    if (resynced) Resynced?.Invoke();
                    resynced = true;
                    await StreamAsync(token);
                    if (token.IsCancellationRequested) return;
                }
                Set(ApprovalFeedStatus.Drop);
                await wait(TimeSpan.FromMilliseconds(Approvals.BackoffMs(attempt++, random)), token);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        finally { if (ReferenceEquals(run, source)) run = null; source.Dispose(); }
    }

    // Any end of the stream (an error, the server closing it, 35 s without a line) returns to RunAsync, which reads the summary again; that read also classifies a refusal.
    private async Task StreamAsync(CancellationToken token)
    {
        using var silence = CancellationTokenSource.CreateLinkedTokenSource(token);
        void Arm() { try { silence.CancelAfter(Silence); } catch (ObjectDisposedException) { } }
        try
        {
            Arm();
            await foreach (var item in api.ApprovalEventsAsync(Arm, silence.Token))
            {
                if (item.Kind == ApprovalsApi.ApprovalEventKind.Summary) { Summary = item.Summary; SummaryChanged?.Invoke(); }
                else DecisionChanged?.Invoke(item);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception error) when (error is HttpRequestException or BellApiException or IOException) { }
    }
}
