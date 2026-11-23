using System.Text.Json;

namespace BellTeam.Core;

/// <summary>One answer of /api/approvals/*: status 0 = no answer (network, timeout, 5xx-like), 401 = the BellTeam sign-in is lost (not the module's 409 not_connected).</summary>
public sealed record ApprovalResponse(int Status, JsonElement? Body)
{
    public bool Ok => Status is >= 200 and < 300;
    public bool LoginRequired => Status == 401;
    public ApprovalFailure Failure => Approvals.FailureOf(Status, Body);
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

/// <summary>The app contract of the 決裁箱拡張's one connection (served by BellTeam, never Approval Box itself; Delta, 2026-12-12: the decisions, answers, holds, images and events are the device's, only the 工程表との連携 connection stays). Every call returns the answer; nothing here retries, and the writes are never resent on their own.</summary>
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

    public static Task<ApprovalResponse> ApprovalConnectionAsync(this BellApi api, CancellationToken token = default) => CallAsync(api, HttpMethod.Get, "/api/approvals/connection", null, null, token);
    public static Task<ApprovalResponse> ApprovalConnectAsync(this BellApi api, CancellationToken token = default) => CallAsync(api, HttpMethod.Post, "/api/approvals/connect", new { }, null, token);
    public static Task<ApprovalResponse> ApprovalStopConnectAsync(this BellApi api, CancellationToken token = default) => CallAsync(api, HttpMethod.Delete, "/api/approvals/connect", null, null, token);
    public static Task<ApprovalResponse> ApprovalDisconnectAsync(this BellApi api, CancellationToken token = default) => CallAsync(api, HttpMethod.Delete, "/api/approvals/connection", null, null, token);
}
